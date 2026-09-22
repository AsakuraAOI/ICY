/**
 * WsTransport：WebSocket 传输抽象。
 *
 * 上层（gateway.ts）只认这个接口，不认具体实现。Node ≥ 22 内置全局 WebSocket
 * 时直接用内置实现，保住「零运行时依赖」；否则启动即报错，提示升级 Node 或
 * 换装了 ws 的适配实现。本内核不允许静默降级。
 */

export interface WsTransport {
  connect(url: string): Promise<void>;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: (code: number, reason: string) => void): void;
}

export class TransportUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransportUnavailableError';
  }
}

/** 返回当前运行时的内置 WebSocket 构造器，没有则为 null。 */
export function builtinWebSocketCtor(): (new (url: string) => WebSocket) | null {
  const ctor = globalThis.WebSocket;
  return typeof ctor === 'function' ? ctor : null;
}

/** 基于 Node 内置全局 WebSocket 的实现。 */
export class BuiltinWsTransport implements WsTransport {
  #ws: WebSocket | null = null;
  #messageHandlers: Array<(data: string) => void> = [];
  #closeHandlers: Array<(code: number, reason: string) => void> = [];

  connect(url: string): Promise<void> {
    const ctor = builtinWebSocketCtor();
    if (ctor === null) {
      return Promise.reject(
        new TransportUnavailableError(
          '当前 Node 运行时没有内置 WebSocket。请升级到 Node ≥ 22，或为 WsTransport 提供 ws 适配实现。',
        ),
      );
    }

    return new Promise<void>((resolve, reject) => {
      const ws = new ctor(url);
      this.#ws = ws;

      const onOpen = (): void => {
        cleanup();
        resolve();
      };
      const onError = (): void => {
        cleanup();
        reject(new TransportUnavailableError('WebSocket 连接失败'));
      };
      const cleanup = (): void => {
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onError);
      };

      // 一旦连上，error 不再走 connect 的 reject；close 统一由 onClose 上报。
      ws.addEventListener('open', onOpen, { once: true });
      ws.addEventListener('error', onError, { once: true });

      ws.addEventListener('message', (evt: MessageEvent) => {
        const data = typeof evt.data === 'string' ? evt.data : String(evt.data);
        for (const h of this.#messageHandlers) h(data);
      });
      // 本项目的 lib 是纯 ES2023，没有 DOM 的 CloseEvent 全局类型；
      // 按结构取字段，缺省 1006（异常关闭）、空 reason。
      ws.addEventListener('close', (evt) => {
        const close = evt as unknown as { code?: unknown; reason?: unknown };
        const code = typeof close.code === 'number' ? close.code : 1006;
        const reason = typeof close.reason === 'string' ? close.reason : '';
        for (const h of this.#closeHandlers) h(code, reason);
      });
    });
  }

  send(data: string): void {
    if (this.#ws === null || this.#ws.readyState !== WebSocket.OPEN) {
      throw new TransportUnavailableError('WebSocket 未连接，send 被拒');
    }
    this.#ws.send(data);
  }

  close(code?: number, reason?: string): void {
    if (this.#ws === null) return;
    const ws = this.#ws;
    this.#ws = null;
    // 已关闭的 socket 再 close 是 no-op，不会抛。
    if (reason !== undefined) ws.close(code, reason);
    else if (code !== undefined) ws.close(code);
    else ws.close();
  }

  onMessage(handler: (data: string) => void): void {
    this.#messageHandlers.push(handler);
  }

  onClose(handler: (code: number, reason: string) => void): void {
    this.#closeHandlers.push(handler);
  }
}