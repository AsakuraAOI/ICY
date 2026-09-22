/**
 * 主动消息频控。
 *
 * 被动回复有平台兜底：窗口 5 分钟、最多 5 次，超了只是那一条失败。主动消息没有这层
 * 保护 —— 一个写错的插件可以在几秒内把机器人打到限流甚至封禁。所以闸门必须在内核里，
 * 把「插件行为」和「机器人账号安全」解耦。
 *
 * 策略：滑动窗口。窗口从每次放行的时刻向前推算，不跟随日历分钟切分 —— 否则两个相邻
 * 日历分钟各放满上限，会合成 2N 的瞬时突发。
 *
 * 拒绝是结构化结果而不是抛错：插件拿到 reason 与 retryAfterMs 后可以自己决定排队重试
 * 还是放弃，而不是等一个永远不会来的响应。
 */

/**
 * 频控额度。
 *
 * 默认值只在 throttle.ts 定义一份，config.ts 从这里取。两处各写一份默认值在这个项目里
 * 已经造成过真实分歧（并发度 8 被 manifest 的 1 静默覆盖），所以额度也走同一个原则：
 * 谁拥有这个行为，谁定义它的默认值。
 */
export interface ThrottleLimits {
  /** 单个会话每个窗口允许的条数。 */
  perConversation: number;
  /** 全部会话合计每个窗口允许的条数。 */
  global: number;
  /** 窗口长度（毫秒）。 */
  windowMs: number;
}

export const DEFAULT_THROTTLE_LIMITS: ThrottleLimits = {
  perConversation: 4,
  global: 20,
  windowMs: 60_000,
};

export type ThrottleOptions = Partial<ThrottleLimits>;

export type ThrottleReason = 'conversation_limit' | 'global_limit';

export type ThrottleResult =
  | { ok: true }
  | { ok: false; reason: ThrottleReason; limit: number; retryAfterMs: number };

export class SendThrottle {
  readonly #perConversation: number;
  readonly #global: number;
  readonly #windowMs: number;
  /** 会话键 → 本窗口内已放行的时间戳（升序）。 */
  readonly #byKey = new Map<string, number[]>();
  /** 全部会话已放行的时间戳（升序）。 */
  #all: number[] = [];

  constructor(options: ThrottleOptions = {}) {
    this.#perConversation = options.perConversation ?? DEFAULT_THROTTLE_LIMITS.perConversation;
    this.#global = options.global ?? DEFAULT_THROTTLE_LIMITS.global;
    this.#windowMs = options.windowMs ?? DEFAULT_THROTTLE_LIMITS.windowMs;
  }

  /**
   * 尝试占用一个主动消息额度。允许则 { ok: true }，否则给出结构化拒绝。
   *
   * now 可注入，测试才能不依赖真实时钟。
   */
  take(key: string, now: number = Date.now()): ThrottleResult {
    const windowStart = now - this.#windowMs;
    // 过期清理必须覆盖全部会话，而不是只清当前这一个：否则一个长期运行的机器人
    // 见过多少群，就要在内存里留下多少条再也不会被访问的空记录。
    // 放行频率本身很低（全局上限 20 条/分钟），全量扫描的代价可以忽略。
    this.#all = this.#all.filter((at) => at > windowStart);
    for (const [entryKey, list] of this.#byKey) {
      const kept = list.filter((at) => at > windowStart);
      if (kept.length === 0) this.#byKey.delete(entryKey);
      else if (kept.length !== list.length) this.#byKey.set(entryKey, kept);
    }

    const stamps = this.#byKey.get(key) ?? [];

    if (this.#all.length >= this.#global) {
      return {
        ok: false,
        reason: 'global_limit',
        limit: this.#global,
        retryAfterMs: retryAfter(this.#all[0], this.#windowMs, now),
      };
    }

    if (stamps.length >= this.#perConversation) {
      return {
        ok: false,
        reason: 'conversation_limit',
        limit: this.#perConversation,
        retryAfterMs: retryAfter(stamps[0], this.#windowMs, now),
      };
    }

    stamps.push(now);
    this.#byKey.set(key, stamps);
    this.#all.push(now);
    return { ok: true };
  }

  /** 当前窗口内有过放行的会话数。仅用于观测与测试。 */
  get conversations(): number {
    return this.#byKey.size;
  }
}

/** 距离「最旧的一次放行滑出窗口」还有多久，至少 1ms。 */
function retryAfter(oldest: number | undefined, windowMs: number, now: number): number {
  if (oldest === undefined) return windowMs;
  return Math.max(windowMs - (now - oldest), 1);
}
