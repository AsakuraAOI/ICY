/**
 * QQApiClient：OpenAPI 的统一入口。
 *
 * 职责：
 * - 每个请求自动带 token，401 / 11241 / 11243 失效时丢弃缓存重取一次再重试一次；
 * - 失败统一归一为 ApiError，记录 err_code 与 trace_id；
 * - 只暴露发群文本这一 MVP 发送原语，其余走 request 逃生舱。
 *
 * message 字段的文案官方可能随时调整，任何逻辑都不允许依赖它。
 */

import { routes } from './routes.js';
import type { BotSelfInfo, SendMessageBody, SendMessageResponse } from '../types/qq.js';
import { ApiError, TransportError, isAuthFailure, type HttpMethod } from './errors.js';
import type { TokenManager } from './token.js';

export interface SendResult {
  messageId: string;
  timestamp: string;
}

export interface QQApiClientOptions {
  tokenManager: TokenManager;
  /** 单次请求超时，默认 15 秒。 */
  timeoutMs?: number;
}

export class QQApiClient {
  readonly #tokens: TokenManager;
  readonly #timeoutMs: number;

  constructor(options: QQApiClientOptions) {
    this.#tokens = options.tokenManager;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  /** 发送群文本。MVP 唯一发送路径。 */
  async sendGroupText(params: {
    groupOpenid: string;
    content: string;
    msgId?: string;
    /** 不传默认 1（不是 0）。 */
    msgSeq?: number;
  }): Promise<SendResult> {
    const body: SendMessageBody = {
      msg_type: 0,
      content: params.content,
      msg_seq: params.msgSeq ?? 1,
    };
    if (params.msgId !== undefined) body.msg_id = params.msgId;

    const res = await this.request<SendMessageResponse>(
      'POST',
      routes.groupMessages(params.groupOpenid),
      body,
    );
    return { messageId: res.id, timestamp: res.timestamp };
  }

  /**
   * 发送单聊文本。
   *
   * 与群聊共用 SendMessageBody，被动回复窗口同样是 5 分钟 / 最多 5 次，
   * 因此 msg_id 与 msg_seq 的用法与 sendGroupText 完全一致。
   */
  async sendC2CText(params: {
    userOpenid: string;
    content: string;
    msgId?: string;
    msgSeq?: number;
  }): Promise<SendResult> {
    const body: SendMessageBody = {
      msg_type: 0,
      content: params.content,
      msg_seq: params.msgSeq ?? 1,
    };
    if (params.msgId !== undefined) body.msg_id = params.msgId;

    const res = await this.request<SendMessageResponse>(
      'POST',
      routes.c2cMessages(params.userOpenid),
      body,
    );
    return { messageId: res.id, timestamp: res.timestamp };
  }

  /**
   * 机器人自身信息。
   *
   * 这是唯一一条只读、无副作用的接口，因此适合在启动阶段用来验证凭证真的可用
   * （DESIGN.md 的 P1），并把 username 带给插件用于日志归因。
   */
  async getSelfInfo(): Promise<BotSelfInfo> {
    const self = await this.request<BotSelfInfo>('GET', routes.selfInfo());
    if (typeof self.id !== 'string' || self.id === '') {
      throw new TransportError('机器人自身信息响应缺少 id');
    }
    return self;
  }

  /**
   * 撤回群消息。
   *
   * 平台限制：发送超过 2 分钟不可撤回。成功返回 HTTP 200 且**无响应体**，所以这里
   * 返回 void —— 调用方不能假设拿得到任何回执。
   *
   * 权限分两档：机器人是群管理员时可撤回自己的消息与普通成员的消息；普通成员身份
   * 下只能撤回自己发送的。内核不替插件判断这一档，越权会被平台拒绝（40062003）。
   */
  async recallGroupMessage(params: { groupOpenid: string; messageId: string }): Promise<void> {
    await this.request<unknown>(
      'DELETE',
      routes.groupMessage(params.groupOpenid, params.messageId),
    );
  }

  /**
   * 撤回单聊消息。只能撤回机器人自己发送给该用户的消息，同样受 2 分钟限制。
   */
  async recallC2CMessage(params: { userOpenid: string; messageId: string }): Promise<void> {
    await this.request<unknown>('DELETE', routes.c2cMessage(params.userOpenid, params.messageId));
  }

  /** 原始逃生舱，仅内核内部与受信任插件使用。 */
  async request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
    const token = await this.#tokens.get();
    try {
      return await this.#roundtrip<T>(method, path, body, token);
    } catch (error) {
      // token 失效：丢弃缓存、重取、只重试一次。
      if (error instanceof ApiError && isAuthFailure(error)) {
        this.#tokens.invalidate();
        const fresh = await this.#tokens.get();
        return this.#roundtrip<T>(method, path, body, fresh);
      }
      throw error;
    }
  }

  async #roundtrip<T>(method: HttpMethod, path: string, body: unknown, token: string): Promise<T> {
    // exactOptionalPropertyTypes 下 RequestInit.body 不接受显式 undefined：
    // 必须让这个属性整个不出现，所以按需构造 init 而不是塞 undefined。
    const init: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `QQBot ${token}`,
      },
      signal: AbortSignal.timeout(this.#timeoutMs),
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    let res: Response;
    try {
      res = await fetch(path, init);
    } catch (cause) {
      throw new TransportError(`OpenAPI 请求失败 ${method} ${path}：网络或超时`, { cause });
    }

    let parsed: unknown = null;
    const text = await res.text();
    if (text !== '') {
      try {
        parsed = JSON.parse(text);
      } catch (cause) {
        throw new TransportError(`OpenAPI 返回的不是合法 JSON（HTTP ${res.status}）`, { cause });
      }
    }

    const record = (parsed !== null && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
    const errCode = typeof record.err_code === 'number' ? record.err_code : null;
    const traceId =
      (typeof record.trace_id === 'string' ? record.trace_id : null) ??
      res.headers.get('X-Tps-trace-ID');

    if (!res.ok || (errCode !== null && errCode !== 0)) {
      throw new ApiError({
        httpStatus: res.status,
        path,
        errCode,
        traceId,
        body: parsed,
        detail: typeof record.message === 'string' ? record.message : '',
      });
    }

    return parsed as T;
  }
}