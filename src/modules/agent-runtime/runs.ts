import { randomUUID } from 'node:crypto';
import type { PluginHost, PublicReplyHandle } from '../../sdk/index.js';
import { defineService } from '../../app/runtime/contracts.js';
import { defineModule } from '../../app/runtime/module.js';
import { Agents, type AgentEngine } from '../agent/engine.js';
import { Policy, type PolicyService } from '../agent/policy.js';
import type { ActorContext } from '../agent/identity.js';
import { Models } from '../llm/contracts.js';
import { AgentStore, type StoredRun } from './store.js';

export type SubmitResult =
  | { readonly accepted: true; readonly runId: string; readonly duplicate: boolean }
  | { readonly accepted: false; readonly reason: 'forbidden' | 'busy' | 'expired' | 'stopping' | 'disabled' | 'too_long' | 'quota' };

export interface RunsService {
  readonly enabled: boolean;
  readonly durable: boolean;
  submit(input: {
    actor: ActorContext; eventKey: string; text: string;
    reply: PublicReplyHandle; host: PluginHost;
  }): SubmitResult;
  status(actor: ActorContext): StoredRun | null;
  cancel(actor: ActorContext): boolean;
  reset(actor: ActorContext): void;
  stop(): Promise<void>;
}

export const Runs = defineService<RunsService>('agent.runs');

interface RunsConfig {
  readonly enabled?: boolean;
  readonly dbPath?: string;
  readonly modelAlias?: string;
  readonly systemPrompt?: string;
  readonly outputLimit?: number;
  readonly maxReplyChars?: number;
  readonly maxConcurrency?: number;
  readonly maxQueue?: number;
  readonly maxModelCalls?: number;
  readonly maxToolCalls?: number;
  readonly maxRunsPerSession24h?: number;
  readonly maxRunsGlobal24h?: number;
}

interface Job {
  readonly id: string;
  readonly actor: ActorContext;
  readonly text: string;
  readonly reply: PublicReplyHandle;
  readonly host: PluginHost;
  readonly deadline: number;
  readonly generation: number;
}

class RunManager implements RunsService {
  readonly enabled = true;
  readonly durable: boolean;
  readonly #store: AgentStore;
  readonly #engine: AgentEngine;
  readonly #policy: PolicyService;
  readonly #config: Required<Omit<RunsConfig, 'dbPath' | 'enabled'>>;
  readonly #log: (message: string) => void;
  readonly #queue: Job[] = [];
  readonly #active = new Map<string, { id: string; controller: AbortController; promise: Promise<void> }>();
  #stopping = false;

  constructor(store: AgentStore, durable: boolean, engine: AgentEngine, policy: PolicyService,
    config: Required<Omit<RunsConfig, 'dbPath' | 'enabled'>>, log: (message: string) => void) {
    this.#store = store;
    this.durable = durable;
    this.#engine = engine;
    this.#policy = policy;
    this.#config = config;
    this.#log = log;
  }

  submit(input: {
    actor: ActorContext; eventKey: string; text: string;
    reply: PublicReplyHandle; host: PluginHost;
  }): SubmitResult {
    if (this.#stopping) return { accepted: false, reason: 'stopping' };
    if (!this.#policy.decide(input.actor, 'agent.use', { kind: 'session', sessionKey: input.actor.sessionKey }).allowed) {
      return { accepted: false, reason: 'forbidden' };
    }
    if (Array.from(input.text).length > 4_000) return { accepted: false, reason: 'too_long' };
    const deadline = Math.min(Date.now() + 120_000, input.reply.acceptBefore - 15_000);
    if (deadline <= Date.now() + 2_000) return { accepted: false, reason: 'expired' };
    // 已接单的重投递返回同一个 run；不再次消耗队列名额或模型额度。
    const existing = this.#store.byEventKey(input.eventKey);
    if (existing !== null) return { accepted: true, runId: existing.id, duplicate: true };
    const since = Date.now() - 24 * 60 * 60 * 1_000;
    if (this.#store.countSince(since, input.actor.sessionKey) >= this.#config.maxRunsPerSession24h ||
      this.#store.countSince(since) >= this.#config.maxRunsGlobal24h) {
      return { accepted: false, reason: 'quota' };
    }
    if (this.#store.pendingCount(input.actor.sessionKey) >= 2 ||
      this.#queue.length >= this.#config.maxQueue) {
      return { accepted: false, reason: 'busy' };
    }
    const created = this.#store.create({
      id: randomUUID(), eventKey: input.eventKey,
      sessionKey: input.actor.sessionKey, text: input.text,
    });
    if (created.duplicate) return { accepted: true, runId: created.run.id, duplicate: true };
    this.#queue.push({
      id: created.run.id, actor: input.actor, text: input.text,
      reply: input.reply, host: input.host, deadline, generation: created.run.generation,
    });
    queueMicrotask(() => this.#pump());
    return { accepted: true, runId: created.run.id, duplicate: false };
  }

  status(actor: ActorContext): StoredRun | null {
    if (!this.#authorized(actor, 'runs.read')) return null;
    return this.#store.latest(actor.sessionKey);
  }

  cancel(actor: ActorContext): boolean {
    if (!this.#authorized(actor, 'runs.cancel')) return false;
    let cancelled = false;
    for (let i = this.#queue.length - 1; i >= 0; i -= 1) {
      const job = this.#queue[i];
      if (job?.actor.sessionKey !== actor.sessionKey) continue;
      this.#queue.splice(i, 1);
      cancelled = this.#store.fail(job.id, 'cancelled', '任务已取消。', 'cancelled') || cancelled;
    }
    const active = this.#active.get(actor.sessionKey);
    if (active !== undefined) {
      cancelled = this.#store.fail(active.id, 'cancelled', '任务已取消。', 'cancelled') || cancelled;
      active.controller.abort();
    }
    return cancelled;
  }

  reset(actor: ActorContext): void {
    if (!this.#authorized(actor, 'sessions.reset')) throw new Error('没有重置此会话的权限');
    this.cancel(actor);
    this.#store.reset(actor.sessionKey);
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    for (const job of this.#queue.splice(0)) {
      this.#store.interrupt(job.id);
    }
    for (const active of this.#active.values()) {
      this.#store.interrupt(active.id);
      active.controller.abort();
    }
    const pending = [...this.#active.values()].map((entry) => entry.promise);
    if (pending.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled(pending),
          new Promise<void>((resolve) => { timer = setTimeout(resolve, 2_500); }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
  }

  #authorized(actor: ActorContext, action: 'runs.read' | 'runs.cancel' | 'sessions.reset'): boolean {
    return this.#policy.decide(actor, action, { kind: 'session', sessionKey: actor.sessionKey }).allowed;
  }

  #pump(): void {
    if (this.#stopping) return;
    while (this.#active.size < this.#config.maxConcurrency) {
      const index = this.#queue.findIndex((job) => !this.#active.has(job.actor.sessionKey));
      if (index < 0) return;
      const [job] = this.#queue.splice(index, 1);
      if (job === undefined) return;
      const controller = new AbortController();
      const promise = this.#execute(job, controller.signal)
        .catch((error: unknown) => { this.#log(`run ${job.id} 执行异常：${describe(error)}`); })
        .finally(() => {
          this.#active.delete(job.actor.sessionKey);
          this.#pump();
        });
      this.#active.set(job.actor.sessionKey, { id: job.id, controller, promise });
    }
  }

  async #execute(job: Job, signal: AbortSignal): Promise<void> {
    if (!this.#store.markRunning(job.id)) return;
    if (Date.now() >= job.deadline) {
      if (this.#store.fail(job.id, 'deadline', '任务已超时，请重试。')) {
        await this.#deliver(job, '任务已超时，请重试。');
      }
      return;
    }
    const history = this.#store.history(job.actor.sessionKey, job.generation);
    const messages = [
      ...(this.#config.systemPrompt === '' ? [] as const
        : [{ role: 'system' as const, content: this.#config.systemPrompt }]),
      ...history,
      { role: 'user' as const, content: job.text },
    ];
    try {
      const result = await this.#engine.run({
        actor: job.actor, sessionKey: job.actor.sessionKey, runId: job.id,
        modelAlias: this.#config.modelAlias, messages,
        outputLimit: this.#config.outputLimit, deadline: job.deadline, signal,
        maxModelCalls: this.#config.maxModelCalls, maxToolCalls: this.#config.maxToolCalls,
      });
      if (signal.aborted || !this.#store.complete(job.id, job.generation, result.text)) return;
      await this.#deliver(job, truncate(result.text, this.#config.maxReplyChars));
    } catch (error) {
      if (signal.aborted) return;
      const kind = error !== null && typeof error === 'object' && 'kind' in error
        ? String(error.kind) : 'unavailable';
      const userText = kind === 'deadline' || kind === 'timeout'
        ? '任务已超时，请重试。' : '处理请求时发生错误，请稍后重试。';
      this.#log(`run ${job.id} 失败 kind=${kind}`);
      if (this.#store.fail(job.id, kind, userText)) await this.#deliver(job, userText);
    }
  }

  async #deliver(job: Job, text: string): Promise<void> {
    if (!this.#store.canDeliver(job.id, job.generation)) return;
    if (this.#stopping || Date.now() >= job.reply.acceptBefore - 2_000) {
      this.#store.setDelivery(job.id, 'failed');
      return;
    }
    try {
      const result = await job.host.reply(job.reply, { kind: 'text', text });
      this.#store.setDelivery(job.id, result.ok ? 'sent' : 'failed');
      if (!result.ok) this.#log(`run ${job.id} 回复失败 reason=${result.reason}`);
    } catch (error) {
      // RPC 已发出但回执丢失时，不能自动重发。
      this.#store.setDelivery(job.id, 'unknown');
      this.#log(`run ${job.id} 回复状态未知：${describe(error)}`);
    }
  }
}

function readPositive(value: number | undefined, name: string, fallback: number, max: number): number {
  const parsed = value ?? fallback;
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`runs.${name} 必须是 1–${max} 的整数`);
  }
  return parsed;
}

function truncate(value: string, max: number): string {
  const chars = Array.from(value);
  if (chars.length <= max) return value;
  return `${chars.slice(0, max - 6).join('')}…（已截断）`;
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export const runsModule = defineModule<RunsConfig>({
  name: 'runs', version: '0.1.0',
  requires: ['agent-engine', 'models', 'policy'],
  setup(ctx) {
    const cfg = ctx.config;
    if (cfg.enabled !== undefined && typeof cfg.enabled !== 'boolean') {
      throw new Error('runs.enabled 必须是布尔值');
    }
    if (cfg.enabled !== true) {
      ctx.provide(Runs, {
        enabled: false, durable: false,
        submit: () => ({ accepted: false, reason: 'disabled' }),
        status: () => null, cancel: () => false, reset: () => {},
        stop: async () => {},
      });
      ctx.logger.info('Runs 尚未启用；等待模型与数据路径配置');
      return;
    }
    const path = cfg.dbPath ?? process.env.ICY_AGENT_DB_PATH ?? ':memory:';
    if (typeof path !== 'string' || path.trim() === '') throw new Error('runs.dbPath 必须是有效路径');
    const modelAlias = cfg.modelAlias ?? 'chat-default';
    if (typeof modelAlias !== 'string' || modelAlias.trim() === '') {
      throw new Error('runs.modelAlias 必须是非空字符串');
    }
    const model = ctx.services.require(Models).describe(modelAlias);
    const outputLimit = readPositive(cfg.outputLimit, 'outputLimit', 2_000, model.maxOutputTokens);
    const systemPrompt = cfg.systemPrompt ?? '';
    if (typeof systemPrompt !== 'string') throw new Error('runs.systemPrompt 必须是字符串');
    const limits = {
      modelAlias, systemPrompt, outputLimit,
      maxReplyChars: readPositive(cfg.maxReplyChars, 'maxReplyChars', 1_800, 2_000),
      maxConcurrency: readPositive(cfg.maxConcurrency, 'maxConcurrency', 4, 64),
      maxQueue: readPositive(cfg.maxQueue, 'maxQueue', 16, 1_000),
      maxModelCalls: readPositive(cfg.maxModelCalls, 'maxModelCalls', 6, 20),
      maxToolCalls: readPositive(cfg.maxToolCalls, 'maxToolCalls', 8, 32),
      maxRunsPerSession24h: readPositive(cfg.maxRunsPerSession24h, 'maxRunsPerSession24h', 20, 10_000),
      maxRunsGlobal24h: readPositive(cfg.maxRunsGlobal24h, 'maxRunsGlobal24h', 200, 1_000_000),
    };
    const store = new AgentStore(path);
    ctx.onDispose(() => store.close());
    ctx.provide(Runs, new RunManager(
      store, path !== ':memory:', ctx.services.require(Agents), ctx.services.require(Policy), limits,
      (message) => ctx.logger.warn(message),
    ));
    if (path === ':memory:') ctx.logger.warn('Runs 使用内存 SQLite；重启后会话与任务不会保留');
  },
  async stop(ctx) { await ctx.services.require(Runs).stop(); },
});

export default runsModule;
