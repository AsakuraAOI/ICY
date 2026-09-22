/**
 * 短期事件去重。
 *
 * 相同 msg_id 可能多次推送（Gateway Resume 补发、网络抖动、业务重试都会造成重复），
 * 所以按「事件类型 + 消息 ID」做 TTL 去重。
 *
 * 注意：不要拿回复用的 msg_seq 当去重键。官方文档在去重与回复两处都提到了它，
 * 但那是两个不同语义：一处是事件的重复推送，一处是同一次回复的第几次。混用会让
 * 「对同一条消息回复第二次」被误判成重复事件而被丢掉。
 */

import type { InboundEvent } from './normalize.js';

export interface DeduperOptions {
  /** 去重窗口，默认 60 秒。 */
  ttlMs?: number;
  /** 条目上限，超限时淘汰最旧的，默认 10000。 */
  maxEntries?: number;
}

export class Deduper {
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  /** key → 过期时间戳（毫秒）。Map 保持插入顺序，便于淘汰最旧条目。 */
  readonly #entries = new Map<string, number>();

  constructor(options: DeduperOptions = {}) {
    this.#ttlMs = options.ttlMs ?? 60_000;
    this.#maxEntries = options.maxEntries ?? 10_000;
  }

  /** 返回 true 表示这条事件是新的；false 表示在窗口内已经见过。 */
  accept(key: string, now: number = Date.now()): boolean {
    const expiresAt = this.#entries.get(key);
    if (expiresAt !== undefined && expiresAt > now) return false;

    // 已过期则先删再加，让它落到 Map 末尾，不被当成最旧条目优先淘汰。
    if (expiresAt !== undefined) this.#entries.delete(key);
    this.#entries.set(key, now + this.#ttlMs);

    if (this.#entries.size > this.#maxEntries) this.#evict(now);
    return true;
  }

  /** 清理所有已过期条目，返回清理数量。 */
  sweep(now: number = Date.now()): number {
    let removed = 0;
    for (const [key, expiresAt] of this.#entries) {
      if (expiresAt <= now) {
        this.#entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.#entries.size;
  }

  #evict(now: number): void {
    this.sweep(now);
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      this.#entries.delete(oldest.value);
    }
  }
}

/**
 * 去重键。
 *
 * 优先用 msg_id；没有 msg_id 的事件（如 GROUP_ADD_ROBOT）退回到 payload 最外层的 id。
 * 两者都拼上事件类型，避免不同事件类型的 id 空间相撞。
 */
export function dedupeKey(event: InboundEvent): string {
  return `${event.eventType}:${event.messageId ?? event.eventId}`;
}
