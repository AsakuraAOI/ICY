/**
 * Runtime ↔ Core Module 之间的共享契约。
 *
 * 为什么 token 与接口定义在 runtime 而不是 core：
 * Application 必须自己把消息交给 MessagePipeline（它也是消息进出的唯一点），
 * 如果 token 定义在 src/app/core，Runtime 就得 import 一个「具体模块」—— 依赖方向
 * 立刻变成 runtime → core，而 core 只是被 Runtime 加载的模块之一。
 * 所以：**机制的名字**（token + 接口）留在 runtime 层，**机制的实现**放在 core 模块里，
 * 依赖方向始终是 core → runtime。
 *
 * 本文件只有类型、token 与 defineEvent，没有任何实现与状态：模块可以安全地 import 它。
 */

import type {
  InboundEvent,
  PluginHost,
  PluginReplyInstruction,
  PublicReplyHandle,
} from '../../sdk/index.js';
import type { Disposable, MaybePromise, ModuleResources } from './module.js';
import { defineService, type ServiceToken } from './services.js';

// 模块作者只需要 import 这一个契约文件就能同时拿到 defineService 与 defineEvent：
// token 的定义面只应该有一处，避免「event token 从 A 引入、service token 从 B 引入」。
export { defineService };
export type { ServiceToken };

// ------------------------------------------------------------------ EventBus 契约

declare const eventType: unique symbol;

/** 带类型的 event 句柄。id 是运行时唯一的键，品牌属性只参与类型推导。 */
export interface EventToken<T> {
  readonly id: string;
  /** 仅用于类型推导，运行时不存在。 */
  readonly [eventType]?: T;
}

export class EventError extends Error {
  readonly token: string;

  constructor(token: string, message: string) {
    super(message);
    this.name = 'EventError';
    this.token = token;
  }
}

/**
 * 声明一个 event token。
 *
 * 与 defineService 的区别是语义而不是形状：Event 表达「某件事发生了」，
 * 只是广播，没有返回值、没有失败归因、没有确定性的接收方。
 */
export function defineEvent<T>(id: string): EventToken<T> {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new EventError(String(id), 'event id 必须是非空字符串');
  }
  return { id: id.trim() };
}

export type EventHandler<T> = (payload: T) => MaybePromise<void>;

/** 一个 listener 失败的结构化记录。owner 是注册它的模块名。 */
export interface EventDeliveryFailure {
  readonly owner: string;
  readonly error: Error;
}

/**
 * emit 的结果。
 *
 * 刻意不是 `void` / `boolean`：调用方需要知道「几个 listener 收到了」以及
 * 「谁失败了、失败原因是什么」。handler 之间互相隔离，一个失败不影响其他，
 * 所以失败只能以列表形式聚合返回，不能抛出去。
 */
export interface EventDeliveryResult {
  readonly delivered: number;
  readonly failed: readonly EventDeliveryFailure[];
}

export interface EventSubscribeOptions {
  /** 诊断名，默认 `event#<序号>`。 */
  readonly id?: string;
  /** 模块归属。带 signal 时模块停止会自动摘掉 listener。 */
  readonly resources?: ModuleResources;
}

export interface EventBus {
  /** 注册 listener。返回的 Disposable 摘除是幂等的。 */
  on<T>(token: EventToken<T>, handler: EventHandler<T>, options?: EventSubscribeOptions): Disposable;
  /** 广播。等所有 listener settle 之后才 resolve；永远不因为 listener 失败而 reject。 */
  emit<T>(token: EventToken<T>, payload: T): Promise<EventDeliveryResult>;
  /** 当前 listener 总数。用于测试与诊断资源是否被释放。 */
  readonly size: number;
}

/** Core Module 必须提供：事件总线。 */
export const Events: ServiceToken<EventBus> = defineService<EventBus>('events');

// ------------------------------------------------------------ MessagePipeline 契约

/** 一条待处理的消息。由 App Runtime Plugin 从 ICY 的 event/dispatch 组装。 */
export interface MessageDispatch {
  readonly event: InboundEvent;
  readonly reply: PublicReplyHandle | null;
  readonly host: PluginHost;
  /** 模块停止时用它中断长处理。省略时管道补一个永不 abort 的信号。 */
  readonly signal?: AbortSignal;
}

/** middleware 看到的上下文。 */
export interface MessageContext {
  readonly event: InboundEvent;
  readonly reply: PublicReplyHandle | null;
  readonly host: PluginHost;
  readonly signal: AbortSignal;
}

/**
 * 管道最终返回值 —— 直接就是 ICY SDK 的 PluginReplyInstruction。
 *
 * 刻意不定义第二套消息协议：Pipeline 的产出必须能无损映射回 ICY 的 onEvent 返回，
 * null 表示「这条消息没人回复」。
 */
export type MessageResult = PluginReplyInstruction | null;

export type MessageNext = () => Promise<MessageResult>;

/** Koa 风格 middleware：自己决定何时把控制权交给下一位。 */
export type MessageMiddleware = (
  ctx: MessageContext,
  next: MessageNext,
) => Promise<MessageResult>;

export interface MessageMiddlewareOptions {
  /** 诊断名，默认 `middleware#<注册序号>`。 */
  readonly id?: string;
  /** 数值小者先执行；同值按注册顺序（稳定）。默认 0。 */
  readonly priority?: number;
  /** 模块归属：owner 用于日志与失败归因，signal 用于模块停止时自动摘除。 */
  readonly resources?: ModuleResources;
}

export interface MessagePipeline {
  use(middleware: MessageMiddleware, options?: MessageMiddlewareOptions): Disposable;
  /** 按顺序跑完整条链。没有 middleware 时返回 null。 */
  dispatch(dispatch: MessageDispatch): Promise<MessageResult>;
  /** 当前 middleware 数量。 */
  readonly size: number;
  /** 按执行顺序列出 `owner:id`，诊断与测试用。 */
  describe(): readonly string[];
}

/** Core Module 必须提供：消息处理链。 */
export const Messages: ServiceToken<MessagePipeline> = defineService<MessagePipeline>('messages');