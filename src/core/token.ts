/**
 * TokenManager：access_token 的获取、缓存与刷新。
 *
 * 官方规则（《获取访问凭证》）：
 * - 生命周期默认 7200 秒。
 * - 有效期内重复获取会返回同一个值。
 * - 在过期前 60 秒内获取会返回新值，旧值在这 60 秒内仍然有效。
 * - 此接口失败时 HTTP 仍是 200，成败看 body 的 code。
 *
 * 因此本地缓存到「过期前 300 秒」即可，重试窗口很宽裕。
 * token 只存在于内核进程内，不随事件下发给插件。
 */

import {
  TokenError,
  TransportError,
  isTokenErrorRetryable,
  tokenErrorHint,
} from './errors.js';
import { routes } from './routes.js';

/** token 接口的原始响应。expires_in 文档标注为 number，但示例给的是字符串 "7200"。 */
interface TokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
  code?: unknown;
  message?: unknown;
}

export interface TokenManagerOptions {
  appId: string;
  clientSecret: string;
  /** 提前刷新窗口（秒），默认 300。 */
  refreshAheadSeconds?: number;
  /** 单次请求超时（毫秒），默认 15000。没有它，网络卡住会静默挂死启动。 */
  timeoutMs?: number;
  /** 最多尝试几次（只有可重试的失败才消耗次数），默认 3。 */
  maxAttempts?: number;
}

interface TokenState {
  accessToken: string;
  /** 毫秒时间戳，到这个点之后视为不可用并触发刷新。 */
  expiresAt: number;
}

export class TokenManager {
  readonly #appId: string;
  readonly #clientSecret: string;
  readonly #refreshAheadMs: number;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  #state: TokenState | null = null;
  #inflight: Promise<string> | null = null;

  constructor(options: TokenManagerOptions) {
    this.#appId = options.appId;
    this.#clientSecret = options.clientSecret;
    this.#refreshAheadMs = (options.refreshAheadSeconds ?? 300) * 1000;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#maxAttempts = Math.max(options.maxAttempts ?? 3, 1);
  }

  /** 返回可用 token。并发调用共享同一次刷新，不会打出多个请求。 */
  async get(): Promise<string> {
    const cached = this.#cached();
    if (cached !== null) return cached;

    if (this.#inflight === null) {
      this.#inflight = this.#refresh().finally(() => {
        this.#inflight = null;
      });
    }
    return this.#inflight;
  }

  /** 收到 401 / 11241 / 11243 后调用，丢弃缓存。下次 get() 会重新获取。 */
  invalidate(): void {
    this.#state = null;
  }

  /** 供日志使用：不暴露 token 本身。 */
  describe(): { hasToken: boolean; expiresAt: number | null } {
    return {
      hasToken: this.#state !== null,
      expiresAt: this.#state === null ? null : this.#state.expiresAt,
    };
  }

  #cached(): string | null {
    if (this.#state === null) return null;
    if (Date.now() >= this.#state.expiresAt) return null;
    return this.#state.accessToken;
  }

  /**
   * 获取一次 token，按错误分类决定是否重试。
   *
   * 重试范围刻意收窄：只有平台明确标注的限流码（100001）与网络层失败才重试。配置类
   * 错误与协议错误立即失败 —— 对着一个写错的 AppSecret 重试三次只是把启动时间拖长
   * 三倍、日志里多两条噪音，而没有让任何人更接近答案。
   */
  async #refresh(): Promise<string> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < this.#maxAttempts; attempt += 1) {
      if (attempt > 0) await sleep(RETRY_BACKOFF_MS[attempt - 1] ?? 1500);
      try {
        return await this.#fetchOnce();
      } catch (error) {
        if (!isRetryableTokenFailure(error)) throw error;
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    throw lastError ?? new TransportError('token 接口重试耗尽');
  }

  /** 单次请求：校验语义与重试次数无关。 */
  async #fetchOnce(): Promise<string> {
    let res: Response;
    try {
      res = await fetch(routes.token(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: this.#appId, clientSecret: this.#clientSecret }),
        // 没有超时的 fetch 在网络卡住时会静默挂死整个启动流程：没有日志、没有
        // 错误、没有任何可观测信号，比直接失败更难排查。
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (cause) {
      throw new TransportError('token 接口请求失败：网络或超时', { cause });
    }

    let body: TokenResponse;
    try {
      body = (await res.json()) as TokenResponse;
    } catch (cause) {
      throw new TransportError(`token 接口返回的不是合法 JSON（HTTP ${res.status}）`, { cause });
    }

    // 关键：此接口失败时 HTTP 仍是 200，成败必须看 body.code。
    if (typeof body.code === 'number' && body.code !== 0) {
      const detail = typeof body.message === 'string' ? body.message : '';
      throw new TokenError(body.code, detail, tokenErrorHint(body.code));
    }

    if (!res.ok) {
      throw new TransportError(`token 接口 HTTP ${res.status}`);
    }

    if (typeof body.access_token !== 'string' || body.access_token === '') {
      throw new TransportError('token 接口响应缺少 access_token');
    }

    const expiresInSeconds = Number(body.expires_in);
    if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
      throw new TransportError(`token 接口返回的 expires_in 无法解析：${String(body.expires_in)}`);
    }

    // 下限 60 秒，避免 refreshAhead 大于生命周期时把缓存窗口压成负数。
    const ttlMs = Math.max(expiresInSeconds * 1000 - this.#refreshAheadMs, 60_000);
    this.#state = {
      accessToken: body.access_token,
      expiresAt: Date.now() + ttlMs,
    };
    return this.#state.accessToken;
  }
}

/** 重试退避（毫秒）。尝试次数很少，固定阶梯就够，不需要指数运算。 */
const RETRY_BACKOFF_MS = [500, 1500] as const;

/**
 * 这个失败是否值得重试。
 *
 * 只有两类：平台明确标注的限流码（100001），以及网络层失败 —— 启动瞬间网络未就绪、
 * DNS 未预热都是常态。其余一律不重试：配置写错重试一万次也是错。
 */
function isRetryableTokenFailure(error: unknown): boolean {
  if (error instanceof TokenError) return isTokenErrorRetryable(error.code);
  return error instanceof TransportError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
