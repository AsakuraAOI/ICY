/**
 * EventBus 实现：只表达「某件事情发生了」。
 *
 * 与 Service 的边界是硬的：Event 没有返回值、没有确定性的接收方、没有失败归因。
 * 需要「请执行一件事并告诉我结果」的场景请用 ServiceRegistry，拿 EventBus 模拟 RPC
 * 会把调用方的错误处理路径整个抹掉。
 *
 * 三条实现约束：
 *
 * 1. **listener 相互隔离**：一个 handler 抛异常或 reject 不阻止其他 handler 执行。
 *    所以 emit 不能简单地 Promise.all 后就撒手 —— 必须逐个 settle，把失败聚合成
 *    { owner, error } 返回给调用方，而不是抛出去。抛出去等于让「一个 listener 坏了」
 *    升级成「整次广播失败」。
 * 2. **emit 等待所有 listener settle**：返回时所有 handler 都已经跑完（或失败），
 *    调用方不需要再自己去 join。异步 handler 会被 await。
 * 3. **每个 listener 记录 owner**：日志与失败归因都靠它；模块停止时 Runtime 通过
 *    resources.signal 把该模块的全部 listener 一次性摘掉。
 *
 * v0 刻意不做跨进程 EventBus：这是进程内模块协作机制。跨进程广播属于 ICY 插件层
 * （IPC）的职责，不在这里模拟。
 */

import {
  EventError,
  type EventBus,
  type EventDeliveryFailure,
  type EventDeliveryResult,
  type EventHandler,
  type EventSubscribeOptions,
  type EventToken,
} from '../runtime/contracts.js';
import type { Disposable } from '../runtime/module.js';

interface ListenerRecord {
  readonly id: string;
  readonly owner: string;
  readonly handler: EventHandler<unknown>;
}

export class EventBusImpl implements EventBus {
  readonly #listeners = new Map<string, ListenerRecord[]>();
  #sequence = 0;

  on<T>(
    token: EventToken<T>,
    handler: EventHandler<T>,
    options: EventSubscribeOptions = {},
  ): Disposable {
    if (typeof handler !== 'function') {
      throw new EventError(token.id, `event "${token.id}" 的 listener 必须是函数`);
    }

    const owner = options.resources?.owner ?? 'anonymous';
    const id = options.id ?? `${owner}#${++this.#sequence}`;
    const record: ListenerRecord = { id, owner, handler: handler as EventHandler<unknown> };

    const list = this.#listeners.get(token.id);
    if (list === undefined) this.#listeners.set(token.id, [record]);
    else list.push(record);

    let disposed = false;
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      this.#remove(token.id, record);
    };

    // 模块停止时自动摘掉：signal 已经 abort 的注册直接当作立即释放（并给出明确错误而不是
    // 静默注册一个永远不会被调用的 listener）。
    const signal = options.resources?.signal;
    if (signal !== undefined) {
      if (signal.aborted) {
        dispose();
        throw new EventError(token.id, `模块 "${owner}" 停止后仍在注册 event listener`);
      }
      signal.addEventListener('abort', dispose, { once: true });
    }

    return { dispose };
  }

  async emit<T>(token: EventToken<T>, payload: T): Promise<EventDeliveryResult> {
    // 快照：handler 里再 on/off 不影响本轮广播，否则「谁收到了」取决于迭代顺序。
    const listeners = [...(this.#listeners.get(token.id) ?? [])];
    const failed: EventDeliveryFailure[] = [];
    let delivered = 0;

    const results = await Promise.allSettled(
      listeners.map(async (record) => record.handler(payload)),
    );
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      const record = listeners[index];
      if (record === undefined || result === undefined) continue;
      if (result.status === 'fulfilled') delivered += 1;
      else failed.push({ owner: record.owner, error: toError(result.reason) });
    }

    return { delivered, failed };
  }

  get size(): number {
    let total = 0;
    for (const list of this.#listeners.values()) total += list.length;
    return total;
  }

  /** 列出 owner，诊断与测试用。 */
  describe(): readonly string[] {
    const out: string[] = [];
    for (const [id, list] of this.#listeners) {
      for (const record of list) out.push(`${record.owner}:${record.id}@${id}`);
    }
    return out;
  }

  #remove(tokenId: string, record: ListenerRecord): void {
    const list = this.#listeners.get(tokenId);
    if (list === undefined) return;
    const at = list.indexOf(record);
    if (at >= 0) list.splice(at, 1);
    if (list.length === 0) this.#listeners.delete(tokenId);
  }
}

/** 建一个空的 EventBus。 */
export function createEventBus(): EventBus {
  return new EventBusImpl();
}

function toError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}