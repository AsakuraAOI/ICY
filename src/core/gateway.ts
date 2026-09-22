/**
 * Gateway 状态机：Hello → Identify → 心跳 → Resume/重连。
 *
 * 状态图见 DESIGN.md §5.4。核心规则：
 * - 心跳间隔由 op=10 Hello 下发（实测 45000ms），心跳带最新 s，首次为 null；
 * - Identify 的 token 形如 "QQBot {AccessToken}"，MVP 不分片 shard=[0,1]；
 * - 断线优先 op=6 Resume（带 session_id + 最新 s），失败按关闭码决定走
 *   resume / 重新 identify / 致命退出；
 * - 退避阶梯见 events.ts 的 RECONNECT_BACKOFF_MS，带 jitter，打满后致命退出。
 *
 * 本类只负责「连接」与「把 op=0 Dispatch 交给 onDispatch」，事件归一化
 * 在 normalize.ts，路由在 dispatch.ts。
 */

import {
  Op,
  RECONNECT_BACKOFF_MS,
  closeAction,
  intentsToBits,
  LIFECYCLE_EVENT,
  type IntentName,
} from './events.js';
import { FatalError, TransportError } from './errors.js';
import { routes } from './routes.js';
import type { TokenManager } from './token.js';
import type { WsTransport } from './transport.js';
import type { GatewayPayload, HelloData, ReadyData } from '../types/qq.js';

export interface GatewayOptions {
  tokenManager: TokenManager;
  /** 聚合后的全部插件 intents。 */
  intents: readonly IntentName[];
  /** op=0 Dispatch 回调（READY/RESUMED 已由状态机内部消费，不会到达这里）。 */
  onDispatch: (payload: GatewayPayload) => void;
  /** 日志回调，由调用方决定落地方式。 */
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** 重连最大次数，默认 10。 */
  maxReconnects?: number;
  /** 致命关闭码（协议错误 / 无权限 / 已下架 / 已封禁）的回调，由 main.ts 决定退出码。 */
  onFatal?: (error: Error) => void;
  /** 收到 op=0 且 t=READY 时回调，携带 session_id。 */
  onReady?: (sessionId: string) => void;
}

export class Gateway {
  readonly #options: GatewayOptions;
  readonly #transport: WsTransport;

  #heartbeatIntervalMs = 45_000;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** 最近一次 Dispatch 的 s，心跳与 Resume 要回填。 */
  #seq: number | null = null;
  #sessionId: string | null = null;
  /** 收到心跳 ACK 之前不再发下一次心跳。 */
  #heartbeatAcked = true;
  #reconnectAttempts = 0;
  #stopping = false;

  constructor(transport: WsTransport, options: GatewayOptions) {
    this.#transport = transport;
    this.#options = options;
    this.#transport.onMessage((data) => this.#onMessage(data));
    this.#transport.onClose((code, reason) => void this.#onClose(code, reason));
  }

  /** 建连并进入事件循环。返回后连接保持，直到 close() 或致命错误。 */
  async start(): Promise<void> {
    const token = await this.#options.tokenManager.get();
    const url = await this.#fetchGatewayUrl(token);
    await this.#transport.connect(url);
    // 之后由 onMessage 驱动：Hello → Identify → READY。
  }

  /** 主动关闭，不再重连。 */
  stop(): void {
    this.#stopping = true;
    this.#clearHeartbeat();
    this.#transport.close(1000, 'shutdown');
  }

  async #fetchGatewayUrl(token: string): Promise<string> {
    const res = await fetch(routes.gateway(), {
      headers: { Authorization: `QQBot ${token}` },
    });
    if (!res.ok) throw new TransportError(`获取 Gateway 接入点失败 HTTP ${res.status}`);
    const body = (await res.json()) as { url?: unknown };
    if (typeof body.url !== 'string' || body.url === '') {
      throw new TransportError('获取 Gateway 接入点失败：响应缺少 url');
    }
    return body.url;
  }

  #onMessage(data: string): void {
    let payload: GatewayPayload;
    try {
      payload = JSON.parse(data) as GatewayPayload;
    } catch {
      this.#log('warn', '收到非 JSON 的 Gateway 帧，已忽略');
      return;
    }

    if (typeof payload.s === 'number') this.#seq = payload.s;

    switch (payload.op) {
      case Op.HELLO: {
        const hello = payload.d as HelloData;
        if (typeof hello?.heartbeat_interval === 'number') {
          this.#heartbeatIntervalMs = hello.heartbeat_interval;
        }
        this.#startHeartbeat();
        this.#identifyOrResume().catch((error: unknown) => {
          this.#log('warn', `Identify/Resume 发送失败：${error instanceof Error ? error.message : String(error)}`);
          this.#reconnect();
        });
        return;
      }
      case Op.HEARTBEAT_ACK:
        this.#heartbeatAcked = true;
        return;
      case Op.DISPATCH: {
        if (payload.t === LIFECYCLE_EVENT.READY) {
          const ready = payload.d as ReadyData;
          this.#sessionId = ready.session_id;
          this.#reconnectAttempts = 0;
          this.#log('info', `READY session_id=${ready.session_id}`);
          this.#options.onReady?.(ready.session_id);
          return;
        }
        if (payload.t === LIFECYCLE_EVENT.RESUMED) {
          this.#reconnectAttempts = 0;
          this.#log('info', 'RESUMED');
          return;
        }
        this.#options.onDispatch(payload);
        return;
      }
      case Op.RECONNECT:
        this.#log('warn', '服务端要求重连');
        this.#reconnect();
        return;
      case Op.INVALID_SESSION:
        this.#log('warn', '无效会话，重新 Identify');
        this.#sessionId = null;
        this.#seq = null;
        this.#identifyOrResume().catch((error: unknown) => {
          this.#log('warn', `Identify/Resume 发送失败：${error instanceof Error ? error.message : String(error)}`);
          this.#reconnect();
        });
        return;
      default:
        return;
    }
  }

  async #identifyOrResume(): Promise<void> {
    const token = await this.#options.tokenManager.get();
    if (this.#sessionId !== null && this.#seq !== null) {
      this.#send({
        op: Op.RESUME,
        d: { token: `QQBot ${token}`, session_id: this.#sessionId, seq: this.#seq },
      });
      return;
    }
    this.#send({
      op: Op.IDENTIFY,
      d: {
        token: `QQBot ${token}`,
        intents: intentsToBits(this.#options.intents),
        shard: [0, 1],
        properties: { $os: 'windows', $browser: 'icy', $device: 'icy' },
      },
    });
  }

  #send(payload: Record<string, unknown>): void {
    this.#transport.send(JSON.stringify(payload));
  }

  #startHeartbeat(): void {
    this.#clearHeartbeat();
    this.#heartbeatTimer = setInterval(() => {
      if (!this.#heartbeatAcked) {
        this.#log('warn', '心跳 ACK 超时，主动重连');
        this.#reconnect();
        return;
      }
      this.#heartbeatAcked = false;
      this.#send({ op: Op.HEARTBEAT, d: this.#seq });
    }, this.#heartbeatIntervalMs);
    // 首次心跳按文档在间隔×jitter 后立即发，这里简化为直接发一次。
    this.#heartbeatAcked = false;
    this.#send({ op: Op.HEARTBEAT, d: this.#seq });
  }

  #clearHeartbeat(): void {
    if (this.#heartbeatTimer !== null) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
  }

  async #onClose(code: number, reason: string): Promise<void> {
    this.#clearHeartbeat();
    if (this.#stopping) return;
    this.#log('warn', `连接关闭 code=${code} reason=${reason}`);

    const action = closeAction(code);
    if (action === 'fatal') {
      // #onClose 是被 onClose 回调 void 调用的，这里 throw 只会变成无人处理的
      // unhandledRejection。致命错误必须显式上报，由 main.ts 决定退出码。
      this.#stopping = true;
      const fatal = new FatalError(`Gateway 致命关闭码 ${code}（${reason}），不再重连，请检查配置`);
      this.#log('error', fatal.message);
      this.#options.onFatal?.(fatal);
      return;
    }
    if (action === 'identify') {
      this.#sessionId = null;
      this.#seq = null;
    }
    this.#reconnect();
  }

  #reconnect(): void {
    if (this.#stopping) return;
    const max = this.#options.maxReconnects ?? 10;
    if (this.#reconnectAttempts >= max) {
      this.#stopping = true;
      this.#log('error', `重连已达上限 ${max} 次，放弃`);
      this.#transport.close();
      return;
    }
    // noUncheckedIndexedAccess 下下标取值可能是 undefined，兜底成阶梯上限。
    const base =
      RECONNECT_BACKOFF_MS[Math.min(this.#reconnectAttempts, RECONNECT_BACKOFF_MS.length - 1)] ?? 60_000;
    const delay = Math.round(base * (0.5 + Math.random()));
    this.#reconnectAttempts += 1;
    this.#log('info', `${delay}ms 后重连（第 ${this.#reconnectAttempts} 次）`);
    setTimeout(() => {
      if (this.#stopping) return;
      void this.start().catch((error: unknown) => {
        this.#log('warn', `重连失败：${error instanceof Error ? error.message : String(error)}`);
        this.#reconnect();
      });
    }, delay);
  }

  #log(level: 'info' | 'warn' | 'error', message: string): void {
    this.#options.log?.(level, `[gateway] ${message}`);
  }
}