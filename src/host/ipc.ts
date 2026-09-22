/**
 * JSON-RPC 2.0 over stdio，NDJSON 帧。
 *
 * 硬约束（DESIGN.md §6.2）：插件的 stdout 只能出现协议帧，任何日志必须走 stderr。
 * 所以这里对 stdout 逐行解析，一旦某行不是合法的 JSON-RPC 帧，就判定插件污染了
 * 协议流，立刻 dispose 并上报 onFault —— 不猜测、不跳过、不复用一条已经不可信的
 * 通道。同样的判定也适用于无法匹配的响应 id。
 *
 * 本文件是纯传输层：不认识 QQ 协议，也不认识插件语义。
 */

import { RpcErrorCode } from './types.js';

/** 单行字节上限。插件打印超长日志又忘了换行时，不能把内核内存吃光。 */
const MAX_LINE_BYTES = 8 * 1024 * 1024;

/** 协议流被污染，或通道已关闭。 */
export class RpcProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RpcProtocolError';
  }
}

/** 内核发出的请求在超时前没等到响应。 */
export class RpcTimeoutError extends Error {
  readonly method: string;
  readonly timeoutMs: number;

  constructor(method: string, timeoutMs: number) {
    super(`IPC 请求超时：${method}（${timeoutMs}ms 内没有响应）`);
    this.name = 'RpcTimeoutError';
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

/** 插件用 JSON-RPC error 回应了内核的请求。 */
export class RpcRemoteError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data: unknown) {
    super(`插件返回错误 code=${code}：${message}`);
    this.name = 'RpcRemoteError';
    this.code = code;
    this.data = data;
  }
}

/**
 * 内核主动拒绝（能力不足 / 被动窗口已关 / 次数超限）。
 *
 * 用 JSON-RPC error 回给插件而不是悄悄吞掉：插件拿到的是结构化结果，可以自己
 * 决定降级策略，而不是等一个永远不来的响应。
 */
export class HostRejectionError extends Error {
  readonly code: number;

  constructor(message: string, code: number = RpcErrorCode.HOST_REJECTED) {
    super(message);
    this.name = 'HostRejectionError';
    this.code = code;
  }
}

export interface RpcPeerOptions {
  /** 子进程 stdout。 */
  readable: NodeJS.ReadableStream;
  /** 子进程 stdin。 */
  writable: NodeJS.WritableStream;
  /** 处理插件发来的请求（host/reply、host/send）。抛错会变成 JSON-RPC error。 */
  onRequest: (method: string, params: unknown) => Promise<unknown>;
  /** 处理插件发来的通知（plugin/ready、host/log）。 */
  onNotification?: (method: string, params: unknown) => void;
  /** 协议流损坏。supervisor 据此判定插件异常。 */
  onFault: (error: Error) => void;
  /** 默认请求超时，15 秒。 */
  defaultTimeoutMs?: number;
}

interface PendingCall {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RpcPeer {
  readonly #options: RpcPeerOptions;
  readonly #defaultTimeoutMs: number;
  readonly #pending = new Map<number, PendingCall>();
  #nextId = 1;
  #buffer: Buffer = Buffer.alloc(0);
  #closed = false;
  #closedReason = '';

  constructor(options: RpcPeerOptions) {
    this.#options = options;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 15_000;

    options.readable.on('data', (chunk: Buffer | string) => {
      this.#onData(chunk);
    });
    options.readable.on('end', () => {
      // stdout 结束说明插件进程没了。不在这里上 fault：进程退出由 supervisor 的
      // exit 事件统一处理，同一件事只报一次。
      this.dispose('插件 stdout 已结束');
    });
    options.readable.on('error', (cause: Error) => {
      this.#fault(new RpcProtocolError(`读取插件 stdout 失败：${cause.message}`));
    });
    // 插件已退出时写 stdin 会报错，这里必须吞掉，否则会升级成未捕获异常。
    options.writable.on('error', () => {});
  }

  get closed(): boolean {
    return this.#closed;
  }

  get closedReason(): string {
    return this.#closedReason;
  }

  /** 发一个请求并等响应。超时、通道关闭、插件报错都会 reject。 */
  request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (this.#closed) {
      return Promise.reject(
        new RpcProtocolError(`IPC 通道已关闭（${this.#closedReason}），${method} 未发出`),
      );
    }

    const id = this.#nextId++;
    const timeout = timeoutMs ?? this.#defaultTimeoutMs;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new RpcTimeoutError(method, timeout));
      }, timeout);
      if (typeof timer.unref === 'function') timer.unref();

      this.#pending.set(id, { method, resolve: (value) => resolve(value as T), reject, timer });
      this.#write({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** 发一个通知，不等响应。 */
  notify(method: string, params: unknown): void {
    if (this.#closed) return;
    this.#write({ jsonrpc: '2.0', method, params });
  }

  /** 关闭通道：拒绝全部在途请求，丢弃半行缓冲。幂等。 */
  dispose(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closedReason = reason;
    this.#buffer = Buffer.alloc(0);

    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new RpcProtocolError(`IPC 通道关闭（${reason}），${pending.method} 未完成`));
    }
    this.#pending.clear();
  }

  #write(payload: unknown): void {
    if (this.#closed) return;
    try {
      this.#options.writable.write(`${JSON.stringify(payload)}\n`);
    } catch (cause) {
      this.#fault(new RpcProtocolError(`写入插件 stdin 失败：${describe(cause)}`));
    }
  }

  #onData(chunk: Buffer | string): void {
    if (this.#closed) return;

    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    this.#buffer = this.#buffer.length === 0 ? buf : Buffer.concat([this.#buffer, buf]);

    for (;;) {
      const at = this.#buffer.indexOf(0x0a);
      if (at < 0) break;
      let line = this.#buffer.subarray(0, at).toString('utf8');
      this.#buffer = this.#buffer.subarray(at + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.trim() === '') continue;
      this.#onLine(line);
      if (this.#closed) return;
    }

    if (this.#buffer.length > MAX_LINE_BYTES) {
      this.#fault(
        new RpcProtocolError(`插件协议出现超过 ${MAX_LINE_BYTES} 字节的单行，判定为协议污染`),
      );
    }
  }

  #onLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.#fault(
        new RpcProtocolError(`插件 stdout 出现非 JSON 的行（日志必须走 stderr）：${truncate(line)}`),
      );
      return;
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.#fault(new RpcProtocolError(`插件的 stdout 出现非法的 JSON-RPC 帧：${truncate(line)}`));
      return;
    }

    const frame = parsed as Record<string, unknown>;
    const method = frame.method;
    if (typeof method !== 'string') {
      this.#onResponse(frame);
      return;
    }

    const id = frame.id;
    if (typeof id === 'number' || typeof id === 'string') {
      void this.#onRequest(id, method, frame.params);
      return;
    }
    this.#options.onNotification?.(method, frame.params);
  }

  #onResponse(frame: Record<string, unknown>): void {
    const id = frame.id;
    if (typeof id !== 'number') {
      // 内核发出的请求 id 全是数字，对不上就是这个插件自己实现错了协议。
      this.#fault(new RpcProtocolError(`收到无法匹配的响应帧：id=${String(id)}`));
      return;
    }

    const pending = this.#pending.get(id);
    if (pending === undefined) return; // 超时之后迟到的响应，丢弃。
    this.#pending.delete(id);
    clearTimeout(pending.timer);

    const error = frame.error;
    if (error !== null && typeof error === 'object') {
      const record = error as Record<string, unknown>;
      const code = typeof record.code === 'number' ? record.code : RpcErrorCode.INTERNAL_ERROR;
      const message = typeof record.message === 'string' ? record.message : '插件未提供错误描述';
      pending.reject(new RpcRemoteError(code, message, record.data));
      return;
    }

    pending.resolve(frame.result ?? null);
  }

  async #onRequest(id: number | string, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.#options.onRequest(method, params);
      this.#write({ jsonrpc: '2.0', id, result: result ?? null });
    } catch (error) {
      const code = error instanceof HostRejectionError ? error.code : RpcErrorCode.INTERNAL_ERROR;
      this.#write({ jsonrpc: '2.0', id, error: { code, message: describe(error) } });
    }
  }

  #fault(error: Error): void {
    if (this.#closed) return;
    this.dispose(error.message);
    this.#options.onFault(error);
  }
}

function truncate(line: string): string {
  return line.length <= 200 ? line : `${line.slice(0, 200)}…（共 ${line.length} 字符）`;
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}