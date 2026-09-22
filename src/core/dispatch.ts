/**
 * 事件路由：会话串行 + fanout 顺序 + 插件级背压。
 *
 * 三条硬规则（DESIGN.md §7）：
 * 1. 同一会话内的事件串行处理，不同会话并行 —— 否则两个用户的消息可能同时
 *    改写同一条流式消息或打乱上下文顺序。
 * 2. 多插件订阅同一事件时按 priority 升序调用，**第一个返回非 null 的胜出**。
 *    被动回复只有一条，不能让两个插件都回。这个语义必须在插件文档里写清楚。
 * 3. 每个插件一个有界队列，满了丢弃最旧并记日志；慢插件不拖慢其他插件。
 *
 * 本类不认 QQ 协议，也不认 IPC：插件投递由 PluginEndpoint 抽象，具体实现由
 * host/supervisor 提供；发送由 send 回调接到 QQApiClient。
 */

import { conversationKey, type InboundEvent } from './normalize.js';
import type {
  PublicReplyHandle,
  ReplyInstruction,
  ReplyRegistry,
  ReplyRequest,
} from './pending.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 宿主侧暴露给路由层的一个插件端点。 */
export interface PluginEndpoint {
  readonly name: string;
  /** 数值小者先被调用。 */
  readonly priority: number;
  /** 订阅的事件名，即 payload 的 t。只有声明了才会被投递。 */
  readonly events: readonly string[];
  /** 并发度，默认取 Dispatcher 的配置（1，保序）。 */
  readonly concurrency?: number;
  /** 队列上限，默认取 Dispatcher 的配置（64）。 */
  readonly queueLimit?: number;
  /**
   * 投递一条事件。返回非 null 的 ReplyRequest 表示该插件要回复，
   * 路由层会走 ReplyRegistry 校验后再发。
   */
  dispatch(event: InboundEvent, reply: PublicReplyHandle | null): Promise<ReplyRequest | null>;
}

export interface DispatcherOptions {
  plugins: readonly PluginEndpoint[];
  replies: ReplyRegistry;
  /** 内核校验通过后的最终发送动作，通常接到 QQApiClient.sendGroupText。 */
  send: (instruction: ReplyInstruction) => Promise<void>;
  log?: (level: LogLevel, message: string) => void;
  /** 单插件队列上限，默认 64。 */
  queueLimit?: number;
  /** 单插件默认并发度，默认 1。 */
  concurrency?: number;
}

interface QueueEntry {
  start: () => void;
  /** 队列满时被淘汰，立刻以 null 结算，不阻塞任何人。 */
  drop: () => void;
}

interface QueueState {
  running: number;
  queue: QueueEntry[];
}

export class Dispatcher {
  readonly #plugins: readonly PluginEndpoint[];
  readonly #replies: ReplyRegistry;
  readonly #send: (instruction: ReplyInstruction) => Promise<void>;
  readonly #log: (level: LogLevel, message: string) => void;
  readonly #queueLimit: number;
  readonly #defaultConcurrency: number;

  readonly #chains = new Map<string, Promise<void>>();
  readonly #inflight = new Set<Promise<void>>();
  readonly #queues = new Map<string, QueueState>();

  constructor(options: DispatcherOptions) {
    this.#plugins = options.plugins;
    this.#replies = options.replies;
    this.#send = options.send;
    this.#log = options.log ?? (() => {});
    this.#queueLimit = options.queueLimit ?? 64;
    this.#defaultConcurrency = options.concurrency ?? 1;
  }

  /** 投递一条已归一化的事件。立即返回，处理在后台按会话串行推进。 */
  submit(event: InboundEvent): void {
    const key = conversationKey(event);
    const prev = this.#chains.get(key) ?? Promise.resolve();

    const task = prev
      .then(() => this.#handle(event))
      .catch((error: unknown) => {
        this.#log('error', `事件 ${event.eventId} 处理失败：${describe(error)}`);
      });

    const settle = (): void => {
      if (this.#chains.get(key) === chained) this.#chains.delete(key);
      this.#inflight.delete(chained);
    };
    const chained = task.finally(settle);

    this.#chains.set(key, chained);
    this.#inflight.add(chained);
  }

  /** 等待当前所有在途事件处理完。用于关停与测试。 */
  async drain(): Promise<void> {
    while (this.#inflight.size > 0) {
      await Promise.allSettled([...this.#inflight]);
    }
  }

  /** 在途事件数。 */
  get pending(): number {
    return this.#inflight.size;
  }

  /** 当前活跃会话数。 */
  get conversations(): number {
    return this.#chains.size;
  }

  async #handle(event: InboundEvent): Promise<void> {
    const handle = this.#replies.register(event);

    const candidates = this.#plugins
      .filter((plugin) => plugin.events.includes(event.eventType))
      .sort((a, b) => a.priority - b.priority);

    if (candidates.length === 0) {
      this.#log('debug', `事件 ${event.eventType} 没有插件订阅`);
      return;
    }

    for (const plugin of candidates) {
      const request = await this.#deliver(plugin, event, handle);
      if (request === null) continue;

      if (handle === null) {
        this.#log('warn', `插件 ${plugin.name} 在无被动窗口的事件 ${event.eventType} 上要求回复，已丢弃`);
        continue;
      }

      const resolution = this.#replies.resolve(handle.handleId, request.content);
      if (!resolution.ok) {
        this.#log(
          'warn',
          `插件 ${plugin.name} 的回复被内核拒绝：${resolution.error.reason} — ${resolution.error.detail}`,
        );
        continue;
      }

      try {
        await this.#send(resolution.instruction);
      } catch (error: unknown) {
        this.#log('error', `插件 ${plugin.name} 的回复发送失败：${describe(error)}`);
      }
      // 第一个返回非 null 的插件胜出：被动回复只有一条。
      return;
    }
  }

  #deliver(
    plugin: PluginEndpoint,
    event: InboundEvent,
    handle: PublicReplyHandle | null,
  ): Promise<ReplyRequest | null> {
    const state = this.#queueState(plugin.name);
    const concurrency = plugin.concurrency ?? this.#defaultConcurrency;
    const limit = plugin.queueLimit ?? this.#queueLimit;

    return new Promise<ReplyRequest | null>((resolve) => {
      const entry: QueueEntry = {
        start: (): void => {
          state.running += 1;
          void plugin
            .dispatch(event, handle)
            .catch((error: unknown) => {
              this.#log('warn', `插件 ${plugin.name} 处理事件失败：${describe(error)}`);
              return null;
            })
            .then((result) => {
              resolve(result);
            })
            .finally(() => {
              state.running -= 1;
              this.#pump(plugin.name, state, concurrency);
            });
        },
        drop: (): void => {
          this.#log('warn', `插件 ${plugin.name} 队列已满（上限 ${limit}），丢弃最旧事件`);
          resolve(null);
        },
      };

      if (state.running < concurrency && state.queue.length === 0) {
        entry.start();
        return;
      }

      state.queue.push(entry);
      if (state.queue.length > limit) {
        const dropped = state.queue.shift();
        dropped?.drop();
      }
    });
  }

  #pump(name: string, state: QueueState, concurrency: number): void {
    while (state.running < concurrency && state.queue.length > 0) {
      const next = state.queue.shift();
      if (next === undefined) break;
      next.start();
    }
    if (state.running === 0 && state.queue.length === 0) this.#queues.delete(name);
  }

  #queueState(name: string): QueueState {
    let state = this.#queues.get(name);
    if (state === undefined) {
      state = { running: 0, queue: [] };
      this.#queues.set(name, state);
    }
    return state;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
