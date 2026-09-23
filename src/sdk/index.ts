/**
 * ICY Node.js plugin SDK.
 *
 * This module is deliberately thin: it only implements ICY's JSON-RPC/NDJSON
 * plugin transport and lifecycle boilerplate. Commands, sessions, storage,
 * schedulers and other business concepts stay outside the SDK.
 */

import { IPC_PROTOCOL_VERSION, RpcErrorCode } from '../host/types.js';
import type {
  DispatchParams,
  HostRecallResult,
  HostReplyResult,
  HostSendResult,
  InboundEvent,
  OutboundMessage,
  PluginInitParams,
  PublicReplyHandle,
} from '../host/types.js';

export { IPC_PROTOCOL_VERSION };
export type {
  HostRecallResult,
  HostReplyResult,
  HostSendResult,
  InboundEvent,
  OutboundMessage,
  PluginInitParams,
  PublicReplyHandle,
};

const MAX_LINE_BYTES = 8 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

type MaybePromise<T> = T | Promise<T>;
type RpcId = number | string;

export type MessageTarget =
  | { scope: 'group'; groupOpenid: string }
  | { scope: 'c2c'; userOpenid: string };

/** The shape returned from event/dispatch for a passive reply. */
export interface PluginReplyInstruction {
  scope: 'group' | 'c2c';
  body: OutboundMessage;
}

export interface PluginHost {
  /** Passive reply through a ReplyHandle. Requires message.reply. */
  reply(
    handle: PublicReplyHandle | string,
    body: OutboundMessage,
    timeoutMs?: number,
  ): Promise<HostReplyResult>;

  /** Proactive message. Requires message.send (and message.media for media). */
  send(target: MessageTarget, body: OutboundMessage, timeoutMs?: number): Promise<HostSendResult>;

  /** Recall a message. Requires message.recall. */
  recall(target: MessageTarget, messageId: string, timeoutMs?: number): Promise<HostRecallResult>;

  /** Structured plugin log routed through the host. */
  log(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    fields?: Record<string, unknown>,
  ): void;
}

export interface PluginInitContext<Config extends Record<string, unknown>> {
  config: Config;
  bot: PluginInitParams['bot'];
  host: PluginHost;
}

export interface PluginEventContext<Config extends Record<string, unknown>> {
  event: InboundEvent;
  reply: PublicReplyHandle | null;
  config: Config;
  bot: PluginInitParams['bot'];
  host: PluginHost;
}

export interface PluginShutdownContext<Config extends Record<string, unknown>> {
  reason?: string;
  config: Config;
  bot: PluginInitParams['bot'];
  host: PluginHost;
}

export interface PluginOptions<
  Config extends Record<string, unknown> = Record<string, unknown>,
> {
  name: string;
  version: string;
  /** Default timeout for plugin -> host calls. Defaults to 60 seconds. */
  requestTimeoutMs?: number;
  onInit?: (context: PluginInitContext<Config>) => MaybePromise<void>;
  onEvent?: (
    context: PluginEventContext<Config>,
  ) => MaybePromise<PluginReplyInstruction | null | undefined>;
  onShutdown?: (context: PluginShutdownContext<Config>) => MaybePromise<void>;
}

/** A JSON-RPC error returned by the ICY host. */
export class RpcRemoteError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data: unknown) {
    super(`ICY host returned JSON-RPC error ${code}: ${message}`);
    this.name = 'RpcRemoteError';
    this.code = code;
    this.data = data;
  }
}

/** A plugin -> host call exceeded its local SDK timeout. */
export class RpcTimeoutError extends Error {
  readonly method: string;
  readonly timeoutMs: number;

  constructor(method: string, timeoutMs: number) {
    super(`ICY host call timed out: ${method} (${timeoutMs}ms)`);
    this.name = 'RpcTimeoutError';
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

interface PendingCall {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class PluginRequestError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = 'PluginRequestError';
    this.code = code;
  }
}

/**
 * Infer a proactive-message target from a normalized event.
 * Returns null for lifecycle/unknown events or malformed message events.
 */
export function targetOf(event: InboundEvent): MessageTarget | null {
  if (
    event.kind === 'group' &&
    typeof event.groupOpenid === 'string' &&
    event.groupOpenid !== ''
  ) {
    return { scope: 'group', groupOpenid: event.groupOpenid };
  }
  if (
    event.kind === 'c2c' &&
    typeof event.userOpenid === 'string' &&
    event.userOpenid !== ''
  ) {
    return { scope: 'c2c', userOpenid: event.userOpenid };
  }
  return null;
}

/** Create a plugin instance. Call run() once after construction. */
export function createPlugin<Config extends Record<string, unknown> = Record<string, unknown>>(
  options: PluginOptions<Config>,
): IcyPlugin<Config> {
  return new IcyPlugin(options);
}

/** Convenience helper for the common create + run path. */
export function runPlugin<Config extends Record<string, unknown> = Record<string, unknown>>(
  options: PluginOptions<Config>,
): IcyPlugin<Config> {
  const plugin = new IcyPlugin(options);
  plugin.run();
  return plugin;
}

/**
 * The Node.js implementation of ICY's plugin-side protocol.
 *
 * stdout is owned by the SDK after run() starts. Plugin logs must use host.log,
 * console.error or process.stderr; console.log would corrupt the protocol stream.
 */
export class IcyPlugin<Config extends Record<string, unknown> = Record<string, unknown>> {
  readonly #options: PluginOptions<Config>;
  readonly #defaultTimeoutMs: number;
  readonly #pending = new Map<number, PendingCall>();
  readonly #host: PluginHost;

  #nextId = 1;
  #buffer: Buffer = Buffer.alloc(0);
  #running = false;
  #initialized = false;
  #closing = false;
  #config: Config | null = null;
  #bot: PluginInitParams['bot'] | null = null;

  constructor(options: PluginOptions<Config>) {
    if (options.name.trim() === '') throw new Error('plugin name cannot be empty');
    if (options.version.trim() === '') throw new Error('plugin version cannot be empty');
    if (
      options.requestTimeoutMs !== undefined &&
      (!Number.isFinite(options.requestTimeoutMs) || options.requestTimeoutMs <= 0)
    ) {
      throw new Error('requestTimeoutMs must be a positive finite number');
    }

    this.#options = options;
    this.#defaultTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#host = {
      reply: (handle, body, timeoutMs) => {
        const handleId = typeof handle === 'string' ? handle : handle.handleId;
        return this.#request<HostReplyResult>('host/reply', { handleId, body }, timeoutMs);
      },
      send: (target, body, timeoutMs) =>
        this.#request<HostSendResult>('host/send', { ...target, body }, timeoutMs),
      recall: (target, messageId, timeoutMs) =>
        this.#request<HostRecallResult>('host/recall', { ...target, messageId }, timeoutMs),
      log: (level, message, fields) => {
        const params: Record<string, unknown> = { level, message };
        if (fields !== undefined) params.fields = fields;
        this.#notify('host/log', params);
      },
    };
  }

  get host(): PluginHost {
    return this.#host;
  }

  /** Start consuming JSON-RPC NDJSON from stdin. May only be called once. */
  run(): void {
    if (this.#running) throw new Error('IcyPlugin.run() may only be called once');
    this.#running = true;

    process.stdin.on('data', (chunk: Buffer | string) => {
      this.#onData(chunk);
    });
    process.stdin.on('end', () => {
      this.#disposePending(new Error('ICY host stdin closed'));
      if (!this.#closing) process.exit(0);
    });
    process.stdin.on('error', (error) => {
      this.#fatal(`failed to read stdin: ${error.message}`);
    });
    process.stdout.on('error', (error) => {
      this.#fatal(`failed to write stdout: ${error.message}`);
    });
  }

  #request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (!this.#running || this.#closing) {
      return Promise.reject(new Error(`plugin transport is not available; ${method} was not sent`));
    }

    const id = this.#nextId++;
    const timeout = timeoutMs ?? this.#defaultTimeoutMs;
    if (!Number.isFinite(timeout) || timeout <= 0) {
      return Promise.reject(new Error('timeoutMs must be a positive finite number'));
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new RpcTimeoutError(method, timeout));
      }, timeout);
      if (typeof timer.unref === 'function') timer.unref();

      this.#pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.#write({ jsonrpc: '2.0', id, method, params });
    });
  }

  #notify(method: string, params: unknown): void {
    if (!this.#running || this.#closing) return;
    this.#write({ jsonrpc: '2.0', method, params });
  }

  #write(frame: unknown): void {
    try {
      process.stdout.write(`${JSON.stringify(frame)}\n`);
    } catch (error) {
      this.#fatal(`failed to serialize/write JSON-RPC frame: ${describe(error)}`);
    }
  }

  #onData(chunk: Buffer | string): void {
    if (this.#closing) return;
    const incoming = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    this.#buffer =
      this.#buffer.length === 0 ? incoming : Buffer.concat([this.#buffer, incoming]);

    for (;;) {
      const at = this.#buffer.indexOf(0x0a);
      if (at < 0) break;
      let line = this.#buffer.subarray(0, at).toString('utf8');
      this.#buffer = this.#buffer.subarray(at + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.trim() === '') continue;
      this.#onLine(line);
      if (this.#closing) return;
    }

    if (this.#buffer.length > MAX_LINE_BYTES) {
      this.#fatal(`host sent an NDJSON line larger than ${MAX_LINE_BYTES} bytes`);
    }
  }

  #onLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.#fatal(`host sent invalid JSON: ${truncate(line)}`);
      return;
    }

    const frame = readRecord(parsed);
    if (frame === null || frame.jsonrpc !== '2.0') {
      this.#fatal(`host sent an invalid JSON-RPC frame: ${truncate(line)}`);
      return;
    }

    const method = frame.method;
    if (typeof method === 'string') {
      const id = frame.id;
      if (typeof id === 'number' || typeof id === 'string') {
        void this.#handleRequest(id, method, frame.params);
      }
      // ICY currently has no host -> plugin notifications. Unknown notifications are
      // intentionally ignored for forward compatibility.
      return;
    }

    this.#handleResponse(frame);
  }

  #handleResponse(frame: Record<string, unknown>): void {
    const id = frame.id;
    if (typeof id !== 'number') return;
    const pending = this.#pending.get(id);
    if (pending === undefined) return; // Late response after a local timeout.

    this.#pending.delete(id);
    clearTimeout(pending.timer);

    const remoteError = readRecord(frame.error);
    if (remoteError !== null) {
      const code =
        typeof remoteError.code === 'number' ? remoteError.code : RpcErrorCode.INTERNAL_ERROR;
      const message =
        typeof remoteError.message === 'string' ? remoteError.message : 'host returned an error';
      pending.reject(new RpcRemoteError(code, message, remoteError.data));
      return;
    }

    pending.resolve(frame.result ?? null);
  }

  async #handleRequest(id: RpcId, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.#dispatchRequest(method, params);
      this.#write({ jsonrpc: '2.0', id, result: result ?? null });

      if (method === 'lifecycle/init') {
        this.#notify('plugin/ready', {
          name: this.#options.name,
          version: this.#options.version,
          protocolVersion: IPC_PROTOCOL_VERSION,
        });
      } else if (method === 'lifecycle/shutdown') {
        this.#closing = true;
        this.#disposePending(new Error('plugin is shutting down'));
        setTimeout(() => process.exit(0), 25);
      }
    } catch (error) {
      const code = error instanceof PluginRequestError ? error.code : RpcErrorCode.INTERNAL_ERROR;
      this.#write({
        jsonrpc: '2.0',
        id,
        error: { code, message: errorMessage(error) },
      });
      if (!(error instanceof PluginRequestError)) {
        process.stderr.write(`[icy-sdk] ${describe(error)}\n`);
      }
    }
  }

  async #dispatchRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'ping':
        return { ok: true };

      case 'lifecycle/init': {
        if (this.#initialized) {
          throw new PluginRequestError(RpcErrorCode.INVALID_REQUEST, 'plugin is already initialized');
        }
        const init = parseInitParams(params);
        if (init.protocolVersion !== IPC_PROTOCOL_VERSION) {
          throw new PluginRequestError(
            RpcErrorCode.INVALID_PARAMS,
            `unsupported protocol version ${init.protocolVersion}; SDK expects ${IPC_PROTOCOL_VERSION}`,
          );
        }

        this.#config = init.config as Config;
        this.#bot = init.bot;
        await this.#options.onInit?.({ config: this.#config, bot: this.#bot, host: this.#host });
        this.#initialized = true;
        return { ok: true, version: this.#options.version };
      }

      case 'event/dispatch': {
        this.#requireInitialized();
        const dispatch = parseDispatchParams(params);
        const result = await this.#options.onEvent?.({
          event: dispatch.event,
          reply: dispatch.reply,
          config: this.#config as Config,
          bot: this.#bot as PluginInitParams['bot'],
          host: this.#host,
        });
        return result ?? null;
      }

      case 'lifecycle/shutdown': {
        this.#requireInitialized();
        const record = readRecord(params);
        const reason = typeof record?.reason === 'string' ? record.reason : undefined;
        const context: PluginShutdownContext<Config> = {
          config: this.#config as Config,
          bot: this.#bot as PluginInitParams['bot'],
          host: this.#host,
        };
        if (reason !== undefined) context.reason = reason;
        await this.#options.onShutdown?.(context);
        return { ok: true, version: this.#options.version };
      }

      default:
        throw new PluginRequestError(
          RpcErrorCode.METHOD_NOT_FOUND,
          `plugin does not implement ${method}`,
        );
    }
  }

  #requireInitialized(): void {
    if (!this.#initialized || this.#config === null || this.#bot === null) {
      throw new PluginRequestError(RpcErrorCode.INVALID_REQUEST, 'plugin is not initialized');
    }
  }

  #disposePending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #fatal(message: string): void {
    if (this.#closing) return;
    this.#closing = true;
    this.#disposePending(new Error(message));
    try {
      process.stderr.write(`[icy-sdk] fatal: ${message}\n`);
    } finally {
      process.exit(1);
    }
  }
}

function parseInitParams(value: unknown): PluginInitParams {
  const record = readRecord(value);
  if (record === null || typeof record.protocolVersion !== 'number') {
    throw new PluginRequestError(
      RpcErrorCode.INVALID_PARAMS,
      'lifecycle/init requires protocolVersion',
    );
  }

  const config = readRecord(record.config) ?? {};
  const botRecord = readRecord(record.bot);
  const botId = botRecord?.id;
  if (typeof botId !== 'string' || botId === '') {
    throw new PluginRequestError(RpcErrorCode.INVALID_PARAMS, 'lifecycle/init requires bot.id');
  }

  const bot: PluginInitParams['bot'] = { id: botId };
  if (typeof botRecord?.username === 'string') bot.username = botRecord.username;
  return { protocolVersion: record.protocolVersion, config, bot };
}

function parseDispatchParams(value: unknown): DispatchParams {
  const record = readRecord(value);
  const event = readRecord(record?.event);
  if (record === null || event === null || typeof event.eventType !== 'string') {
    throw new PluginRequestError(
      RpcErrorCode.INVALID_PARAMS,
      'event/dispatch requires a normalized event',
    );
  }

  const replyValue = record.reply;
  let reply: PublicReplyHandle | null = null;
  if (replyValue !== null && replyValue !== undefined) {
    const replyRecord = readRecord(replyValue);
    if (
      replyRecord === null ||
      typeof replyRecord.handleId !== 'string' ||
      typeof replyRecord.expiresAt !== 'number' ||
      typeof replyRecord.acceptBefore !== 'number' ||
      typeof replyRecord.remaining !== 'number'
    ) {
      throw new PluginRequestError(RpcErrorCode.INVALID_PARAMS, 'event/dispatch has invalid reply');
    }
    reply = {
      handleId: replyRecord.handleId,
      expiresAt: replyRecord.expiresAt,
      acceptBefore: replyRecord.acceptBefore,
      remaining: replyRecord.remaining,
    };
  }

  return { event: event as unknown as InboundEvent, reply };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function truncate(value: string): string {
  return value.length <= 200 ? value : `${value.slice(0, 200)}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.stack ?? `${error.name}: ${error.message}` : String(error);
}
