/**
 * 被动回复窗口预登记。
 *
 * 平台硬约束：群聊被动回复只有 5 分钟、最多 5 次，超了就是 40034005 / 40034128。
 * AI 类插件处理很久是常态，如果让插件自己拿着 msg_id 硬发，很容易撞墙。
 *
 * 因此由内核在收到事件时立刻登记 ReplyHandle：插件只拿到 handleId / expiresAt /
 * remaining，既拿不到 msg_id，也决定不了 msg_seq —— 这两样都由内核持有。
 *
 * 生命周期决策：handle 不在单次事件处理结束时回收，而是活到窗口关闭。
 * 因为插件的异步回复路径（event/dispatch 返回 null，稍后用 host/reply）依赖它，
 * 提前回收会把这条自由度掐死。回收统一交给 sweep()。
 */

import type { InboundEvent } from './normalize.js';
import { outboundScopeProblem, type OutboundMessage } from './outbound.js';

/**
 * 插件向内核提出的回复请求。内核负责补齐 msg_id 与 msg_seq。
 *
 * scope 是插件自报的场景，**不具权威性**：真正决定端点的是 handle 登记时记下的
 * target。事件来自群，回复就一定发到群 —— 插件填错也不会把消息发去别处。
 */
export interface ReplyRequest {
  scope: 'group' | 'c2c';
  /** 想发什么。文本 / Markdown / ARK / Embed / 键盘 / 富媒体都在这一个模型里。 */
  message: OutboundMessage;
}

/**
 * 被动回复的定位目标。
 *
 * 群聊与单聊走的是两个不同的 OpenAPI 端点（`/v2/groups/{gid}/messages` 与
 * `/v2/users/{uid}/messages`），所以目标必须带上 scope 才能定位到正确端点。
 * 这是内核内部结构，msg_id 与它一起只在这一层出现，不下发插件。
 */
export type ReplyTarget =
  | { scope: 'group'; groupOpenid: string }
  | { scope: 'c2c'; userOpenid: string };

/** 内核校验通过后真正发出去的指令。msg_id 只在这一层出现。 */
export type ReplyInstruction = ReplyTarget & {
  message: OutboundMessage;
  /** 被动回复用的 msg_id，取自事件的 d.id。 */
  msgId: string;
  /** 内核分配的回复序号，从 1 开始递增，避免 40054005「消息被去重」。 */
  msgSeq: number;
};

/** 下发给插件的 handle 视图：没有 msg_id。 */
export interface PublicReplyHandle {
  handleId: string;
  /** 窗口关闭时间戳（毫秒），已减去 buffer。 */
  expiresAt: number;
  /** 还允许回复几次。仅供参考，最终以 resolve() 的校验为准。 */
  remaining: number;
}

export type ReplyRejectionReason =
  | 'unknown_handle'
  | 'expired'
  | 'window_closing'
  | 'exhausted'
  | 'unsupported_scope';

export interface ReplyRejection {
  reason: ReplyRejectionReason;
  /** 给人看的说明，逻辑不允许依赖它。 */
  detail: string;
  expiresAt?: number;
  remaining?: number;
}

export type ReplyResolution =
  | { ok: true; instruction: ReplyInstruction }
  | { ok: false; error: ReplyRejection };

interface ReplyHandleState {
  id: string;
  /** 回复目标：群聊或单聊，决定最终走哪个发送端点。 */
  target: ReplyTarget;
  msgId: string;
  expiresAt: number;
  remaining: number;
  nextSeq: number;
}

export interface ReplyRegistryOptions {
  /** 被动窗口，默认 300000（5 分钟）。 */
  windowMs?: number;
  /** 窗口提前量，默认 30000。 */
  windowBufferMs?: number;
  /** 剩余不足该毫秒数时主动拒绝，默认 60000。 */
  minRemainingMs?: number;
  /** 单条消息最多被动回复几次，默认 5。 */
  maxReplies?: number;
  /** handle 上限，超出淘汰最旧的，默认 5000。 */
  maxHandles?: number;
}

export class ReplyRegistry {
  readonly #windowMs: number;
  readonly #windowBufferMs: number;
  readonly #minRemainingMs: number;
  readonly #maxReplies: number;
  readonly #maxHandles: number;
  readonly #handles = new Map<string, ReplyHandleState>();
  #counter = 0;

  constructor(options: ReplyRegistryOptions = {}) {
    this.#windowMs = options.windowMs ?? 300_000;
    this.#windowBufferMs = options.windowBufferMs ?? 30_000;
    this.#minRemainingMs = options.minRemainingMs ?? 60_000;
    this.#maxReplies = options.maxReplies ?? 5;
    this.#maxHandles = options.maxHandles ?? 5_000;
  }

  /**
   * 为一条事件登记被动回复句柄。
   *
   * 返回 null 表示这条事件没有被动窗口（只有群消息与单聊消息有），调用方应把 null
   * 作为「本事件不允许被动回复」传给插件链接口，而不是跳过投递。
   */
  register(event: InboundEvent, now: number = Date.now()): PublicReplyHandle | null {
    const target = replyTargetOf(event);
    if (target === null) return null;
    const msgId = event.messageId;
    if (typeof msgId !== 'string' || msgId === '') return null;

    this.sweep(now);

    const id = `h${++this.#counter}`;
    const state: ReplyHandleState = {
      id,
      target,
      msgId,
      // 窗口 5 分钟，本地再提前 30 秒关闭，绝不贴着平台的边界发。
      expiresAt: now + Math.max(this.#windowMs - this.#windowBufferMs, 1_000),
      remaining: this.#maxReplies,
      nextSeq: 1,
    };
    this.#handles.set(id, state);

    if (this.#handles.size > this.#maxHandles) {
      const oldest = this.#handles.keys().next();
      if (oldest.done !== true) this.#handles.delete(oldest.value);
    }

    return { handleId: id, expiresAt: state.expiresAt, remaining: state.remaining };
  }

  /**
   * 校验并消费一次回复额度。
   *
   * 窗口剩余不足 minRemainingMs 时提前拒绝，而不是让请求打到 OpenAPI 拿
   * 40034005 —— 插件拿到的是结构化错误，可以自己决定降级策略。
   */
  resolve(handleId: string, message: OutboundMessage, now: number = Date.now()): ReplyResolution {
    const state = this.#handles.get(handleId);
    if (state === undefined) {
      return {
        ok: false,
        error: { reason: 'unknown_handle', detail: `未知或已回收的 handleId=${handleId}` },
      };
    }

    if (now >= state.expiresAt) {
      return {
        ok: false,
        error: { reason: 'expired', detail: '被动回复窗口已关闭', expiresAt: state.expiresAt },
      };
    }

    if (state.expiresAt - now < this.#minRemainingMs) {
      return {
        ok: false,
        error: {
          reason: 'window_closing',
          detail: `窗口剩余不足 ${Math.round(this.#minRemainingMs / 1000)} 秒，内核提前拒绝`,
          expiresAt: state.expiresAt,
          remaining: state.remaining,
        },
      };
    }

    if (state.remaining <= 0) {
      return {
        ok: false,
        error: { reason: 'exhausted', detail: '被动回复次数已用尽', remaining: 0 },
      };
    }

    // 会话级能力限制在这里挡：只有这一层知道 handle 登记时的真实场景，插件自报的
    // scope 不作数。例如输入状态只有单聊有，群聊里回复 typing 就走到这里。
    const problem = outboundScopeProblem(message, state.target.scope);
    if (problem !== null) {
      return { ok: false, error: { reason: 'unsupported_scope', detail: problem } };
    }

    const msgSeq = state.nextSeq;
    state.nextSeq += 1;
    state.remaining -= 1;

    return {
      ok: true,
      instruction: { ...state.target, message, msgId: state.msgId, msgSeq },
    };
  }

  /** 主动回收（仅关停时使用；单个事件处理结束后不要调用）。 */
  release(handleId: string): void {
    this.#handles.delete(handleId);
  }

  /** 清理所有已过期的 handle，返回清理数量。 */
  sweep(now: number = Date.now()): number {
    let removed = 0;
    for (const [id, state] of this.#handles) {
      if (now >= state.expiresAt) {
        this.#handles.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.#handles.size;
  }
}

/**
 * 由事件推出被动回复目标。
 *
 * 群聊用 group_openid、单聊用 user_openid 定位；缺少定位字段的事件没有被动窗口，
 * 返回 null（调用方据此下发 reply=null，而不是跳过投递）。
 */
function replyTargetOf(event: InboundEvent): ReplyTarget | null {
  if (event.kind === 'group') {
    const groupOpenid = event.groupOpenid;
    if (typeof groupOpenid !== 'string' || groupOpenid === '') return null;
    return { scope: 'group', groupOpenid };
  }
  if (event.kind === 'c2c') {
    const userOpenid = event.userOpenid;
    if (typeof userOpenid !== 'string' || userOpenid === '') return null;
    return { scope: 'c2c', userOpenid };
  }
  return null;
}
