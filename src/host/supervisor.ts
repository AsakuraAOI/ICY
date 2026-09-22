/**
 * 插件子进程的监督：spawn、生命周期、超时、崩溃重启与 quarantine。
 *
 * 状态图见 DESIGN.md §6.3。三条硬规则：
 *
 * 1. 每个阶段都有超时，绝不无限等：spawn 5s、初始化（lifecycle/init +
 *    plugin/ready）10s、shutdown 5s。
 * 2. 崩溃重启走指数退避；60 秒内崩 3 次即 quarantine，不再自动拉起，
 *    只在日志里报。反复拉起一个必崩的插件只会把日志刷爆。
 * 3. 插件的 stdout 是协议流、stderr 是日志流。stderr 逐行转发并带
 *    plugin=<name> 前缀；stdout 的非协议内容由 RpcPeer 判定为协议污染，
 *    按崩溃处理。
 *
 * 本文件不认 QQ 协议：host/reply 的窗口校验与真正发送由 main.ts 注入的
 * onReply 回调完成，supervisor 只做能力检查与转发 gen。
 */

import { spawn, type ChildProcess } from 'node:child_process';

import type { LogLevel, PluginEndpoint } from '../core/dispatch.js';
import type { InboundEvent } from '../core/normalize.js';
import type { PublicReplyHandle, ReplyRequest } from '../core/pending.js';
import { HostRejectionError, RpcPeer } from './ipc.js';
import { manifestEntryPath, type PluginManifest } from './manifest.js';
import type { PluginCatalog } from './registry.js';
import {
  HostMethod,
  IPC_PROTOCOL_VERSION,
  PluginMethod,
  RpcErrorCode,
  type DispatchParams,
  type HostLogParams,
  type HostReplyParams,
  type HostReplyResult,
  type HostSendParams,
  type HostSendResult,
  type PluginInitParams,
  type PluginReadyParams,
} from './types.js';

/** 插件进程的监督状态。 */
export type PluginState =
  | 'spawning'
  | 'initializing'
  | 'running'
  | 'restarting'
  | 'stopping'
  | 'stopped'
  | 'quarantined';

export interface SupervisorTimeouts {
  /** 等子进程真的起来 ≤ 5s。 */
  spawnMs: number;
  /** 等 lifecycle/init 与 plugin/ready 合计 ≤ 10s。 */
  readyMs: number;
  /** SIGTERM 之后等它自己退出的宽限期 ≤ 5s，超时 SIGKILL。 */
  terminateGraceMs: number;
  /** 主动 shutdown 的超时 ≤ 5s。 */
  shutdownMs: number;
  /** 单次 IPC 请求默认超时。 */
  callMs: number;
  /** 单事件 dispatch 超时 ≤ 4.5 分钟（被动窗口 5 分钟之内）。 */
  dispatchMs: number;
  /**
   * 健康检查间隔（毫秒）。0 表示关闭。
   *
   * 只覆盖「进程还活着但已经不能干活」这一种失败：插件退出有 exit 事件兜底，
   * 而事件循环被卡死、IPC 不再响应的插件不会退出，只会安静地吞掉所有事件。
   */
  healthCheckMs: number;
}

export const DEFAULT_SUPERVISOR_TIMEOUTS: SupervisorTimeouts = {
  spawnMs: 5_000,
  readyMs: 10_000,
  terminateGraceMs: 5_000,
  shutdownMs: 5_000,
  callMs: 15_000,
  dispatchMs: 270_000,
  healthCheckMs: 30_000,
};

/** 崩溃计数窗口。 */
const CRASH_WINDOW_MS = 60_000;
/** 窗口内允许的崩溃次数上限，超过即 quarantine。 */
const CRASH_LIMIT = 3;
/** 崩溃重启的退避阶梯（毫秒）。 */
const RESTART_BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000] as const;

export interface SupervisorOptions {
  /** 插件能力索引，用于 host/send 的能力检查。 */
  catalog: PluginCatalog;
  bot: { id: string; username?: string };
  log: (level: LogLevel, message: string) => void;
  /** host/reply 的落地：内核校验被动窗口后真正发送。 */
  onReply: (pluginName: string, params: HostReplyParams) => Promise<HostReplyResult>;
  /** host/send 的落地：主动消息，受频控。 */
  onSend: (pluginName: string, params: HostSendParams) => Promise<HostSendResult>;
  /** 插件被 quarantine 的通知（不再自动拉起）。 */
  onQuarantine?: (pluginName: string, reason: string) => void;
  /** 覆盖子进程可执行文件，默认 process.execPath。测试用。 */
  execPath?: string;
  timeouts?: Partial<SupervisorTimeouts>;
}

/**
 * 一个插件进程。对外只暴露 start / stop / dispatch / asEndpoint，
 * 状态机与重启策略全部封在内部，调用方拿不到子进程句柄。
 */
export class PluginProcess {
  readonly #manifest: PluginManifest;
  readonly #options: SupervisorOptions;
  readonly #timeouts: SupervisorTimeouts;
  readonly #log: (level: LogLevel, message: string) => void;

  #state: PluginState = 'stopped';
  #child: ChildProcess | null = null;
  #peer: RpcPeer | null = null;

  #readyResolve: (() => void) | null = null;
  #readyReject: ((error: Error) => void) | null = null;
  #readyTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * plugin/ready 已经到达。
   *
   * 插件通常在回应 lifecycle/init 的同一批 stdout 里就发出 plugin/ready，
   * 两帧可能落在同一个 chunk 里被同步处理完 —— 那时 #waitForReady() 还没被调用，
   * 解析器已经把它消费掉了。没有这个标志就会白等一个满超时（冒烟自检实测过）。
   */
  #readySignaled = false;

  /** 主动 stop() 期间置位：之后任何 exit 都按「正常停止」处理，不触发重启。 */
  #stopping = false;
  /** 初始化阶段已经重启过一次。 */
  #initRestarted = false;
  /** 健康检查定时器，只有 running 期间存在。 */
  #healthTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * 正在处理中的事件数。
   *
   * 健康检查必须跳过计数非 0 的时刻：插件是单线程的，处理一条长事件时它的
   * 事件循环整个被占住，ping 必然超时 —— 那时掐进程是误杀，而且往往正好
   * 落在被动回复窗口里，代价比不检查更高。
   */
  #activeDispatches = 0;
  /** running 阶段的崩溃时间戳，用于 60s/3 次的窗口判定。 */
  #crashTimes: number[] = [];
  #restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(manifest: PluginManifest, options: SupervisorOptions) {
    this.#manifest = manifest;
    this.#options = options;
    this.#timeouts = { ...DEFAULT_SUPERVISOR_TIMEOUTS, ...options.timeouts };
    this.#log = (level, message) => {
      options.log(level, `[plugin=${manifest.name}] ${message}`);
    };
  }

  get name(): string {
    return this.#manifest.name;
  }

  get state(): PluginState {
    return this.#state;
  }

  /** 路由层的插件端点视图。队列与并发由核心的 Dispatcher 负责。 */
  asEndpoint(): PluginEndpoint {
    return {
      name: this.#manifest.name,
      priority: this.#manifest.priority,
      events: this.#manifest.events,
      concurrency: this.#manifest.concurrency,
      queueLimit: this.#manifest.queueLimit,
      dispatch: (event, reply) => this.dispatch(event, reply),
    };
  }

  /**
   * 拉起插件并走到 running。任何时候都不抛：失败按策略记入 restarting /
   * quarantined，由状态与日志体现。调用方（Supervisor）只需 await 完再看状态。
   */
  async start(): Promise<void> {
    if (
      this.#state === 'running' ||
      this.#state === 'initializing' ||
      this.#state === 'spawning' ||
      this.#state === 'quarantined'
    ) {
      return;
    }

    this.#stopping = false;
    this.#state = 'spawning';
    // 上一次进程代的就绪信号与在途计数都不能跨代复用。
    this.#readySignaled = false;
    this.#activeDispatches = 0;

    const child = this.#spawn();
    this.#child = child;
    child.on('error', (cause: Error) => {
      this.#log('error', `子进程错误：${cause.message}`);
    });
    child.on('exit', (code, signal) => {
      this.#onExit(code, signal);
    });
    this.#forwardStderr(child);

    try {
      await this.#waitForSpawn(child);
    } catch (error) {
      this.#child = null;
      // spawn 阶段失败没有可用的进程可谈，按 DESIGN 直接 quarantine，不重试。
      this.#quarantine(describe(error));
      return;
    }

    this.#state = 'initializing';
    try {
      this.#peer = this.#createPeer(child);
      await this.#handshake();
    } catch (error) {
      this.#log('warn', `初始化失败：${describe(error)}`);
      // 只负责让进程消失；重启/隔离的决策统一由 #onExit 做，避免两处同时决策。
      if (this.#child === child) await this.#terminate(child, this.#timeouts.terminateGraceMs);
      return;
    }

    this.#state = 'running';
    this.#log('info', `插件就绪 version=${this.#manifest.version}`);
    this.#startHealthCheck();
  }

  /** 正常关停：先 lifecycle/shutdown，再 SIGTERM，最后 SIGKILL。不抛。 */
  async stop(): Promise<void> {
    if (this.#state === 'stopped' || this.#state === 'quarantined') {
      this.#state = 'stopped';
      return;
    }

    this.#stopping = true;
    if (this.#restartTimer !== null) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = null;
    }

    const peer = this.#peer;
    const child = this.#child;
    if (peer !== null && child !== null && !peer.closed) {
      try {
        await peer.request(HostMethod.SHUTDOWN, { reason: 'kernel shutdown' }, this.#timeouts.shutdownMs);
      } catch (error) {
        this.#log('warn', `lifecycle/shutdown 未确认：${describe(error)}`);
      }
    }

    if (child !== null) await this.#terminate(child, this.#timeouts.shutdownMs);

    this.#cleanup();
    this.#state = 'stopped';
    this.#log('info', '插件已停止');
  }

  /** 转发一条事件。插件未在 running 时直接丢弃并记日志，不排队。 */
  async dispatch(event: InboundEvent, reply: PublicReplyHandle | null): Promise<ReplyRequest | null> {
    const peer = this.#peer;
    if (peer === null || this.#state !== 'running') {
      this.#log('warn', `插件未就绪（${this.#state}），事件 ${event.eventType} 被丢弃`);
      return null;
    }

    const params: DispatchParams = { event, reply };
    let result: unknown;
    this.#activeDispatches += 1;
    try {
      result = await peer.request<unknown>(HostMethod.DISPATCH, params, this.#timeouts.dispatchMs);
    } catch (error) {
      this.#log('warn', `event/dispatch 失败：${describe(error)}`);
      return null;
    } finally {
      this.#activeDispatches -= 1;
    }

    return this.#readReplyRequest(result);
  }

  // ---------------------------------------------------------------- spawn

  #spawn(): ChildProcess {
    const entry = manifestEntryPath(this.#manifest);
    return spawn(this.#options.execPath ?? process.execPath, [entry], {
      cwd: this.#manifest.dir,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }

  #waitForSpawn(child: ChildProcess): Promise<void> {
    const timeoutMs = this.#timeouts.spawnMs;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`子进程 ${timeoutMs}ms 内没有 spawn（${manifestEntryPath(this.#manifest)}）`));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      child.once('spawn', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
      child.once('error', (cause: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`子进程启动失败：${cause.message}`));
      });
    });
  }

  /** 插件的 stderr 是日志流，逐行转发；stdout 留给 RpcPeer。 */
  #forwardStderr(child: ChildProcess): void {
    child.stderr?.on('data', (chunk: Buffer | string) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim() === '') continue;
        // 级别由插件自己在文本里标注，内核不解析，统一按 info 转发。
        this.#log('info', `stderr: ${line}`);
      }
    });
  }

  // ----------------------------------------------------------------- ipc

  #createPeer(child: ChildProcess): RpcPeer {
    // stderr 转发已在 start() 里接过一次，这里再接一遍会让每行日志重复输出。
    const stdout = child.stdout;
    const stdin = child.stdin;
    if (stdout === null || stdin === null) {
      throw new Error('子进程没有可用的 stdio 管道');
    }

    return new RpcPeer({
      readable: stdout,
      writable: stdin,
      onRequest: (method, params) => this.#onPluginRequest(method, params),
      onNotification: (method, params) => {
        this.#onPluginNotification(method, params);
      },
      onFault: (error) => {
        this.#onProtocolFault(error);
      },
      defaultTimeoutMs: this.#timeouts.callMs,
    });
  }

  async #handshake(): Promise<void> {
    const peer = this.#peer;
    if (peer === null) throw new Error('IPC 尚未建立');

    const bot = this.#options.bot;
    const params: PluginInitParams = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      // manifest 目前没有 config 字段，先给空对象；插件私有配置是后续迭代的事。
      config: {},
      bot: bot.username === undefined ? { id: bot.id } : { id: bot.id, username: bot.username },
    };

    const result = await peer.request<unknown>(HostMethod.INIT, params, this.#timeouts.readyMs);
    if (result === null || typeof result !== 'object') {
      throw new Error('lifecycle/init 没有返回对象');
    }
    if ((result as Record<string, unknown>).ok !== true) {
      throw new Error('lifecycle/init 没有返回 ok=true');
    }

    await this.#waitForReady();
  }

  #waitForReady(): Promise<void> {
    // 就绪信号可能早就到了（与 init 响应同批抵达），此时直接返回，
    // 不重新开一个必然超时的等待。
    if (this.#readySignaled) return Promise.resolve();

    const timeoutMs = this.#timeouts.readyMs;
    return new Promise<void>((resolve, reject) => {
      this.#readyTimer = setTimeout(() => {
        this.#readyTimer = null;
        this.#readyResolve = null;
        this.#readyReject = null;
        reject(new Error(`插件 ${timeoutMs}ms 内没有发出 plugin/ready`));
      }, timeoutMs);

      this.#readyResolve = () => {
        resolve();
      };
      this.#readyReject = (error) => {
        reject(error);
      };
    });
  }

  #onPluginRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case PluginMethod.REPLY:
        return this.#onHostReply(params);
      case PluginMethod.SEND:
        return this.#onHostSend(params);
      default:
        return Promise.reject(
          new HostRejectionError(
            `内核没有实现插件方法 ${method}`,
            RpcErrorCode.METHOD_NOT_FOUND,
          ),
        );
    }
  }

  #onPluginNotification(method: string, params: unknown): void {
    switch (method) {
      case PluginMethod.READY:
        this.#onReady(params);
        return;
      case PluginMethod.LOG:
        this.#onPluginLog(params);
        return;
      default:
        this.#log('warn', `插件发出了未知通知 ${method}`);
    }
  }

  #onReady(params: unknown): void {
    this.#readySignaled = true;

    const ready = (params ?? {}) as PluginReadyParams;
    if (
      typeof ready.protocolVersion === 'number' &&
      ready.protocolVersion !== IPC_PROTOCOL_VERSION
    ) {
      this.#log(
        'warn',
        `协议版本不一致：插件 ${ready.protocolVersion} / 内核 ${IPC_PROTOCOL_VERSION}`,
      );
    }

    if (this.#readyTimer !== null) {
      clearTimeout(this.#readyTimer);
      this.#readyTimer = null;
    }
    const resolve = this.#readyResolve;
    this.#readyResolve = null;
    this.#readyReject = null;
    resolve?.();
  }

  #onPluginLog(params: unknown): void {
    const record = readRecord(params);
    if (record === null) return;
    const level = record.level;
    const message = record.message;
    const fields = record.fields;
    const suffix = fields === undefined ? '' : ` ${safeJson(fields)}`;
    this.#log(isLogLevel(level) ? level : 'info', `${typeof message === 'string' ? message : ''}${suffix}`);
  }

  async #onHostReply(params: unknown): Promise<HostReplyResult> {
    if (!this.#manifest.capabilities.includes('message.reply')) {
      throw new HostRejectionError(`插件 ${this.#manifest.name} 未声明 message.reply 能力`);
    }

    const record = readRecord(params);
    const handleId = record?.handleId;
    const text = record?.text;
    if (typeof handleId !== 'string' || handleId === '' || typeof text !== 'string') {
      throw new HostRejectionError(
        'host/reply 需要 { handleId: string, text: string }',
        RpcErrorCode.INVALID_PARAMS,
      );
    }

    return this.#options.onReply(this.#manifest.name, { handleId, text });
  }

  async #onHostSend(params: unknown): Promise<HostSendResult> {
    if (!this.#options.catalog.can(this.#manifest.name, 'message.send')) {
      throw new HostRejectionError(`插件 ${this.#manifest.name} 未声明 message.send 能力`);
    }

    const record = readRecord(params);
    const scope = record?.scope;
    const groupOpenid = record?.groupOpenid;
    const text = record?.text;
    if (scope !== 'group' || typeof groupOpenid !== 'string' || typeof text !== 'string') {
      throw new HostRejectionError(
        'host/send 目前只支持 { scope: "group", groupOpenid: string, text: string }',
        RpcErrorCode.INVALID_PARAMS,
      );
    }

    return this.#options.onSend(this.#manifest.name, { scope: 'group', groupOpenid, text });
  }

  /** 协议流损坏：立刻掐掉进程，剩下的交给 exit 之后的崩溃策略。 */
  #onProtocolFault(error: Error): void {
    this.#log('error', `协议流损坏：${error.message}`);
    this.#peer?.dispose(error.message);
    this.#child?.kill('SIGKILL');
  }

  #readReplyRequest(result: unknown): ReplyRequest | null {
    if (result === null || result === undefined) return null;

    const record = readRecord(result);
    if (record === null) {
      this.#log('warn', '插件返回的回复不是对象，已忽略');
      return null;
    }

    const content = record.content;
    if (typeof content !== 'string' || content.trim() === '') {
      this.#log('warn', '插件返回的回复缺少 content，已忽略');
      return null;
    }

    // scope 只允许 group / c2c。插件自报的 scope 只是自述，真正的目标由内核持有的
    // 句柄决定（见 pending.ts 的 resolve），这里只拦住明显非法的取值。
    const scope = record.scope;
    if (scope !== undefined && scope !== 'group' && scope !== 'c2c') {
      this.#log('warn', `不支持的回复范围 ${String(scope)}，已忽略`);
      return null;
    }

    return { scope: scope === 'c2c' ? 'c2c' : 'group', content };
  }

  // ------------------------------------------------------------- 健康检查

  #startHealthCheck(): void {
    const intervalMs = this.#timeouts.healthCheckMs;
    if (intervalMs <= 0) return;
    this.#clearHealthCheck();
    const timer = setInterval(() => {
      void this.#ping();
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    this.#healthTimer = timer;
  }

  #clearHealthCheck(): void {
    if (this.#healthTimer !== null) {
      clearInterval(this.#healthTimer);
      this.#healthTimer = null;
    }
  }

  /**
   * 周期性 ping。失败即判定插件已失去响应，掐掉进程 —— 之后的重启 / 隔离决策
   * 走 #onExit，与崩溃完全同一条路径，不在这里另立一套策略。
   */
  async #ping(): Promise<void> {
    const peer = this.#peer;
    if (peer === null || this.#state !== 'running' || peer.closed) return;
    if (this.#activeDispatches > 0) return;

    try {
      await peer.request(HostMethod.PING, {}, this.#timeouts.callMs);
    } catch (error) {
      this.#log('warn', `健康检查失败，插件无响应：${describe(error)}`);
      this.#clearHealthCheck();
      this.#peer?.dispose('健康检查失败');
      this.#child?.kill('SIGKILL');
    }
  }

  // ------------------------------------------------------------- 崩溃策略

  #onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.#clearHealthCheck();
    this.#activeDispatches = 0;
    this.#peer?.dispose(`子进程退出 code=${String(code)} signal=${String(signal)}`);
    this.#peer = null;
    this.#child = null;

    if (this.#readyTimer !== null) {
      clearTimeout(this.#readyTimer);
      this.#readyTimer = null;
    }
    const reject = this.#readyReject;
    this.#readyResolve = null;
    this.#readyReject = null;
    reject?.(new Error(`插件进程退出 code=${String(code)} signal=${String(signal)}`));

    if (this.#state === 'quarantined') return;

    const detail = `code=${String(code)} signal=${String(signal)}`;
    if (this.#stopping || this.#state === 'stopped') {
      this.#state = 'stopped';
      return;
    }

    if (this.#state === 'spawning') {
      this.#quarantine(`spawn 阶段就退出了（${detail}）`);
      return;
    }

    if (this.#state === 'initializing') {
      if (this.#initRestarted) {
        this.#quarantine(`初始化失败并重启一次后仍然退出（${detail}）`);
        return;
      }
      this.#initRestarted = true;
      this.#log('warn', `初始化阶段退出（${detail}），重启一次`);
      this.#scheduleRestart(0);
      return;
    }

    // running：按 60 秒窗口计数。
    const now = Date.now();
    this.#crashTimes = [...this.#crashTimes.filter((at) => now - at <= CRASH_WINDOW_MS), now];
    if (this.#crashTimes.length >= CRASH_LIMIT) {
      this.#quarantine(
        `${CRASH_WINDOW_MS / 1000} 秒内崩溃 ${this.#crashTimes.length} 次（${detail}）`,
      );
      return;
    }

    const index = Math.min(this.#crashTimes.length - 1, RESTART_BACKOFF_MS.length - 1);
    const delay = RESTART_BACKOFF_MS[index] ?? 8_000;
    this.#log('warn', `崩溃（${detail}），${delay}ms 后重启`);
    this.#scheduleRestart(delay);
  }

  #scheduleRestart(delayMs: number): void {
    if (this.#stopping) return;
    this.#state = 'restarting';
    if (this.#restartTimer !== null) clearTimeout(this.#restartTimer);
    const timer = setTimeout(() => {
      this.#restartTimer = null;
      if (this.#stopping) return;
      void this.start();
    }, delayMs);
    if (typeof timer.unref === 'function') timer.unref();
    this.#restartTimer = timer;
  }

  #quarantine(reason: string): void {
    if (this.#state === 'quarantined') return;
    this.#state = 'quarantined';
    this.#cleanup();
    this.#log('error', `插件已 quarantine，不再自动拉起：${reason}`);
    this.#options.onQuarantine?.(this.#manifest.name, reason);
  }

  /** 让子进程退出：SIGTERM → 宽限期 → SIGKILL。已经在跑的宽限期不等第二遍。 */
  async #terminate(child: ChildProcess, graceMs: number): Promise<void> {
    if (hasExited(child)) return;

    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
    });

    child.kill('SIGTERM');
    const timer = setTimeout(() => {
      this.#log('warn', `子进程 ${graceMs}ms 内没有退出，SIGKILL`);
      child.kill('SIGKILL');
    }, graceMs);

    await exited;
    clearTimeout(timer);
  }

  #cleanup(): void {
    this.#clearHealthCheck();
    if (this.#restartTimer !== null) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = null;
    }
    if (this.#readyTimer !== null) {
      clearTimeout(this.#readyTimer);
      this.#readyTimer = null;
    }
    this.#readyResolve = null;
    this.#readyReject = null;
    this.#peer?.dispose('内核回收插件');
    this.#peer = null;
  }
}

/** 全部插件进程的集合。发现与 intents 聚合发生在建连之前（见 registry.ts）。 */
export class Supervisor {
  readonly #catalog: PluginCatalog;
  readonly #options: SupervisorOptions;
  readonly #processes = new Map<string, PluginProcess>();

  constructor(catalog: PluginCatalog, options: SupervisorOptions) {
    this.#catalog = catalog;
    this.#options = options;
  }

  /** 拉起所有插件。单个插件失败不影响其他插件，状态在 states 里查。 */
  async startAll(): Promise<void> {
    const starts = this.#catalog.all.map((manifest) => {
      const process = new PluginProcess(manifest, this.#options);
      this.#processes.set(manifest.name, process);
      return process.start();
    });
    await Promise.all(starts);
  }

  /** 路由层的插件端点列表。未就绪的插件也会返回，它自己会拒收事件。 */
  endpoints(): PluginEndpoint[] {
    return [...this.#processes.values()].map((process) => process.asEndpoint());
  }

  /** 已 quarantine 的插件名，供 main.ts 在日志/退出码里体现。 */
  get quarantined(): string[] {
    return [...this.#processes.values()]
      .filter((process) => process.state === 'quarantined')
      .map((process) => process.name);
  }

  stateOf(name: string): PluginState | null {
    return this.#processes.get(name)?.state ?? null;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.#processes.values()].map((process) => process.stop()));
  }
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '[无法序列化]';
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}