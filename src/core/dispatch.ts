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

/**
 * 单插件默认并发度。
 *
 * **它不是保序手段。** 同一会话内的顺序由 #chains 保证（见 submit），这里纯粹是
 * 「一个插件同时在处理几条事件」的上限，也就是背压。取 1 会把所有会话串成一条线，
 * 与 DESIGN §7.2「不同会话并行」直接矛盾 —— 一个慢群的处理会卡住其他所有群。
 */
export const DEFAULT_CONCURRENCY = 8;

/** 单插件默认队列上限。manifest 未声明时用它（见 host/manifest.ts）。 */
export const DEFAULT_QUEUE_LIMIT = 64;

/** 宿主侧暴露给路由层的一个插件端点。 */
export interface PluginEndpoint {
  readonly name: string;
  /** 数值小者先被调用。 */
  readonly priority: number;
  /** 订阅的事件名，即 payload 的 t。只有声明了才会被投递。 */
  readonly events: readonly string[];
  /** 并发度上限，默认取 Dispatcher 的配置（8）。会话内顺序由会话链保证，与此无关。 */
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
  /** 单插件默认并发度，默认 8。它不是保序手段：会话内顺序由会话链保证。 */
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
    this.#queueLimit = options.queueLimit ?? DEFAULT_QUEUE_LIMIT;
    this.#defaultConcurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  }

  /** 投递一条已归一化的事件。立即返回，处理在后台按会话串行推进。 */
  submit(event: InboundEvent): void {
    // 被动回复窗口从消息进入本地调度时开始计时，后续会话串行等待不能延长它。
    const receivedAt = Date.now();
    const key = conversationKey(event);
    const prev = this.#chains.get(key) ?? Promise.resolve();

    const task = prev
      .then(() => this.#handle(event, receivedAt))
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

  async #handle(event: InboundEvent, receivedAt: number): Promise<void> {
    const candidates = this.#plugins
      .filter((plugin) => plugin.events.includes(event.eventType))
      .sort((a, b) => a.priority - b.priority);

    if (candidates.length === 0) {
      this.#log('debug', `事件 ${event.eventType} 没有插件订阅`);
      return;
    }

    // 只为「真的会有人处理」的事件登记被动窗口。没有订阅者还登记，这些 handle 会一直
    // 堆到窗口关闭：上限 5000 一到就淘汰最旧的，而被淘汰的可能正是别的会话里仍在等待
    // 异步 host/reply 的 handle —— 插件拿到 unknown_handle，原因却和自己的行为无关。
    // 先按实际当前时间清扫旧 handle，再用入站时间固定本条消息的被动回复预算。
    this.#replies.sweep();
    const handle = this.#replies.register(event, receivedAt, candidates.map((plugin) => plugin.name));

    for (const plugin of candidates) {
      const request = await this.#deliver(plugin, event, handle);
      if (request === null) continue;

      if (handle === null) {
        this.#log('warn', `插件 ${plugin.name} 在无被动窗口的事件 ${event.eventType} 上要求回复，已丢弃`);
        continue;
      }

      const resolution = this.#replies.resolve(handle.handleId, request.message, Date.now(), plugin.name);
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
