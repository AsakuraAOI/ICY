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

import { TokenError, TransportError } from './errors.js';
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
  #state: TokenState | null = null;
  #inflight: Promise<string> | null = null;

  constructor(options: TokenManagerOptions) {
    this.#appId = options.appId;
    this.#clientSecret = options.clientSecret;
    this.#refreshAheadMs = (options.refreshAheadSeconds ?? 300) * 1000;
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

  async #refresh(): Promise<string> {
    const res = await fetch(routes.token(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: this.#appId, clientSecret: this.#clientSecret }),
    });

    let body: TokenResponse;
    try {
      body = (await res.json()) as TokenResponse;
    } catch (cause) {
      throw new TransportError(`token 接口返回的不是合法 JSON（HTTP ${res.status}）`, { cause });
    }

    // 关键：此接口失败时 HTTP 仍是 200，成败必须看 body.code。
    if (typeof body.code === 'number' && body.code !== 0) {
      const detail = typeof body.message === 'string' ? body.message : '';
      throw new TokenError(body.code, detail);
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
