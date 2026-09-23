/**
 * MessagePipeline 实现：按顺序处理一条消息，直到有人消费它。
 *
 * 与 EventBus 的分工是硬的：Pipeline 表达「按顺序处理这个东西」并且**有返回值**，
 * 所以它必须有顺序、优先级、next() 与中断语义。「三件事各干各的」是 EventBus 的事，
 * 「这条消息由谁处理」是 Pipeline 的事。
 *
 * 实现约束：
 *
 * 1. **priority 升序，同值按注册顺序**：同优先级的顺序由显式递增的 seq 决定，
 *    不依赖 Array.sort 的稳定性 —— 后者是引擎实现细节，不是契约。
 * 2. **next() 每次 dispatch 每人只能调一次**：一个 middleware 调两次 next() 会让
 *    下游链跑两遍，产生重复回复或重复副作用。这里主动报错（Koa 同语义），
 *    而不是静默让它跑两遍。
 * 3. **异常带 owner/id**：出错必须能定位到是哪个模块的哪个 middleware，所以包装成
 *    MiddlewareError 再抛；本身已经是管道错误的直接透传，避免套娃成
 *    「middleware A 失败：middleware B 失败：…」。
 * 4. **不重新设计消息协议**：最终返回值就是 ICY SDK 的 PluginReplyInstruction | null。
 */

import { describeError } from '../runtime/errors.js';
import type { Disposable } from '../runtime/module.js';
import type {
  MessageContext,
  MessageDispatch,
  MessageMiddleware,
  MessageMiddlewareOptions,
  MessageNext,
  MessagePipeline,
  MessageResult,
} from '../runtime/contracts.js';

/** middleware 自己抛出的异常，带 owner 与 id，用于归因。 */
export class MiddlewareError extends Error {
  readonly owner: string;
  readonly middlewareId: string;

  constructor(owner: string, middlewareId: string, cause: unknown) {
    super(`middleware "${owner}:${middlewareId}" 处理消息失败：${describeError(cause)}`, {
      cause,
    });
    this.name = 'MiddlewareError';
    this.owner = owner;
    this.middlewareId = middlewareId;
  }
}

/** 同一个 middleware 在一次 dispatch 里调用了两次 next()。 */
export class PipelineReentryError extends Error {
  readonly owner: string;
  readonly middlewareId: string;

  constructor(owner: string, middlewareId: string) {
    super(
      `middleware "${owner}:${middlewareId}" 在一次 dispatch 里调用了两次 next()；next() 只能调用一次`,
    );
    this.name = 'PipelineReentryError';
    this.owner = owner;
    this.middlewareId = middlewareId;
  }
}

/** 模块停止后仍尝试注册 middleware：宁可报错，也不要留下一个幽灵中间件。 */
export class PipelineRegistrationError extends Error {
  readonly owner: string;

  constructor(owner: string) {
    super(`模块 "${owner}" 已停止，不能再注册 pipeline middleware`);
    this.name = 'PipelineRegistrationError';
    this.owner = owner;
  }
}

interface MiddlewareEntry {
  readonly id: string;
  readonly owner: string;
  readonly priority: number;
  /** 注册序号。同优先级按它升序执行，替代对 sort 稳定性的隐式依赖。 */
  readonly seq: number;
  readonly middleware: MessageMiddleware;
}

/** 消息来源没给 signal 时用它，middleware 不必处理 undefined。 */
const NEVER_ABORT = new AbortController().signal;

export class MessagePipelineImpl implements MessagePipeline {
  #entries: MiddlewareEntry[] = [];
  #sequence = 0;

  use(middleware: MessageMiddleware, options: MessageMiddlewareOptions = {}): Disposable {
    if (typeof middleware !== 'function') {
      throw new TypeError('messages.use() 需要一个 middleware 函数');
    }

    const owner = options.resources?.owner ?? 'anonymous';
    const seq = ++this.#sequence;
    const entry: MiddlewareEntry = {
      id: options.id ?? `${owner}#${seq}`,
      owner,
      priority: options.priority ?? 0,
      seq,
      middleware,
    };
    this.#entries.push(entry);

    let disposed = false;
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      const at = this.#entries.indexOf(entry);
      if (at >= 0) this.#entries.splice(at, 1);
    };

    // 模块停止时自动摘掉：signal 已经 abort 的注册直接拒绝并释放，
    // 而不是静默注册一个永远不会被调用的 middleware。
    const signal = options.resources?.signal;
    if (signal !== undefined) {
      if (signal.aborted) {
        dispose();
        throw new PipelineRegistrationError(owner);
      }
      signal.addEventListener('abort', dispose, { once: true });
    }

    return { dispose };
  }

  /**
   * 跑完整条链。
   *
   * 每次 dispatch 都按当前注册表重新排序：模块可以在 start 阶段注册 middleware
   * （那是模块自己的资源，随 signal 一起释放），排序结果必须反映那一刻的真实集合，
   * 而不是缓存的旧顺序。
   */
  async dispatch(input: MessageDispatch): Promise<MessageResult> {
    if (this.#entries.length === 0) return null;

    const chain = [...this.#entries].sort((a, b) => a.priority - b.priority || a.seq - b.seq);

    const ctx: MessageContext = {
      event: input.event,
      ...(input.botId === undefined ? {} : { botId: input.botId }),
      reply: input.reply,
      host: input.host,
      signal: input.signal ?? NEVER_ABORT,
    };

    const dispatchAt = async (position: number): Promise<MessageResult> => {
      const entry = chain[position];
      if (entry === undefined) return null;

      // 重入保护是「每次调用一份」的局部状态：它精确对应「这一个 middleware 的这一次
      // 执行」，不需要在链级别追踪游标。同一个 next 被 await 两次会命中这里。
      let called = false;
      const next: MessageNext = () => {
        if (called) return Promise.reject(new PipelineReentryError(entry.owner, entry.id));
        called = true;
        return dispatchAt(position + 1);
      };

      try {
        const result = await entry.middleware(ctx, next);
        return result ?? null;
      } catch (error) {
        if (error instanceof MiddlewareError || error instanceof PipelineReentryError) {
          throw error;
        }
        throw new MiddlewareError(entry.owner, entry.id, error);
      }
    };

    return dispatchAt(0);
  }

  get size(): number {
    return this.#entries.length;
  }

  /** 按执行顺序列出 `owner:id`，诊断与测试用。 */
  describe(): readonly string[] {
    return [...this.#entries]
      .sort((a, b) => a.priority - b.priority || a.seq - b.seq)
      .map((entry) => `${entry.owner}:${entry.id}`);
  }
}

export function createMessagePipeline(): MessagePipeline {
  return new MessagePipelineImpl();
}
