/**
 * 插件契约类型 —— 内核唯一对插件公开的 API 面。
 *
 * 插件进程只认识这里定义的结构：不认识 TokenManager、不认识 QQApiClient，
 * 也不认识 message_scene.ext 这类平台私有字段。插件想要的新能力，必须先在这里
 * 落成类型，再实现对应的 IPC 方法。
 *
 * 帧格式见 DESIGN.md §6.2：JSON-RPC 2.0，NDJSON over stdio。
 */

import type { IntentName } from '../core/events.js';
import type { InboundEvent } from '../core/normalize.js';
import type { OutboundMessage } from '../core/outbound.js';
import type { PublicReplyHandle, ReplyRequest } from '../core/pending.js';

export type { IntentName, InboundEvent, OutboundMessage, PublicReplyHandle, ReplyRequest };

/**
 * IPC 协议版本。握手时比对，不一致直接拒绝加载。
 *
 * v2：回复与主动消息改成 OutboundMessage，并新增 message.media 能力。
 * v3：PublicReplyHandle 增加 acceptBefore，供异步处理方按宿主提前拒绝策略计算预算。
 */
export const IPC_PROTOCOL_VERSION = 3;

/**
 * 插件可声明的能力。没声明的能力，调用即被内核拒绝。
 *
 * message.media 单独一档，不并进 message.reply：它会让内核去下载插件给的任意 URL、
 * 并向第三方预签名地址发 PUT，是实实在在的新出网行为，值得单独授权。
 */
export const CAPABILITIES = [
  'message.reply',
  'message.send',
  'message.media',
  'message.recall',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/**
 * host → plugin 的方法表。
 *
 * 这些名字是插件进程必须实现的方法，由内核通过 JSON-RPC 调用。
 */
export const HostMethod = {
  INIT: 'lifecycle/init',
  SHUTDOWN: 'lifecycle/shutdown',
  DISPATCH: 'event/dispatch',
  PING: 'ping',
} as const;
export type HostMethodName = (typeof HostMethod)[keyof typeof HostMethod];

/**
 * plugin → host 的方法表。
 *
 * 这些名字是内核实现的方法，插件通过 JSON-RPC 调用；插件进程自己实现它们
 * 没有意义，内核会以 METHOD_NOT_FOUND 拒绝。
 */
export const PluginMethod = {
  REPLY: 'host/reply',
  SEND: 'host/send',
  RECALL: 'host/recall',
  LOG: 'host/log',
  READY: 'plugin/ready',
} as const;
export type PluginMethodName = (typeof PluginMethod)[keyof typeof PluginMethod];

/** lifecycle/init 的参数：插件启动时唯一能拿到的上下文。 */
export interface PluginInitParams {
  protocolVersion: number;
  /** 插件自己的配置，来自 plugin.json 的 config 字段。内核配置永不下发。 */
  config: Record<string, unknown>;
  bot: {
    /** 机器人 AppID，仅用于日志归因，不是机密。 */
    id: string;
    username?: string;
  };
}

/** lifecycle/init 与 lifecycle/shutdown 的返回。 */
export interface PluginLifecycleResult {
  ok: boolean;
  /** 插件自报的版本，与 manifest.version 不一致时内核记警告，不拒绝。 */
  version?: string;
}

/** plugin/ready 通知的参数。 */
export interface PluginReadyParams {
  name: string;
  version: string;
  protocolVersion: number;
}

/** event/dispatch 的参数。reply 为 null 表示本事件没有被动回复窗口。 */
export interface DispatchParams {
  event: InboundEvent;
  reply: PublicReplyHandle | null;
}

/** host/reply 的参数：插件只能提交 handleId 与「想发什么」。 */
export interface HostReplyParams {
  handleId: string;
  body: OutboundMessage;
}

/** host/reply 的返回。失败是结构化结果，不是 JSON-RPC error。 */
export type HostReplyResult =
  | { ok: true; messageId: string; msgSeq: number }
  | { ok: false; reason: string; detail: string };

/**
 * host/send 的参数：主动消息，需要 message.send 能力，且受内核侧频控。
 *
 * 群聊与单聊走不同端点、定位字段也不同，所以这里是判别联合而不是两个可选字段 ——
 * 后者会允许「两个都传」或「两个都不传」这种无意义的状态，还得在运行时再判一次。
 */
export type HostSendParams =
  | { scope: 'group'; groupOpenid: string; body: OutboundMessage }
  | { scope: 'c2c'; userOpenid: string; body: OutboundMessage };

export interface HostSendResult {
  ok: boolean;
  messageId?: string;
  detail?: string;
}

/**
 * host/recall 的参数：撤回本机器人发送过的消息。
 *
 * `messageId` 直接来自 `host/reply` / `host/send` 的成功返回 —— 插件本来就持有它，
 * 所以这里不需要再包一层句柄。这也意味着插件只能撤回自己发过的消息（它拿不到别人的
 * 消息 ID，除非收到的群事件里带着 d.id，那属于管理员撤回场景）。
 */
export type HostRecallParams =
  | { scope: 'group'; groupOpenid: string; messageId: string }
  | { scope: 'c2c'; userOpenid: string; messageId: string };

/** host/recall 的返回。失败是结构化结果，不是 JSON-RPC error。 */
export interface HostRecallResult {
  ok: boolean;
  reason?: string;
  detail?: string;
}

/** host/log 的参数。 */
export interface HostLogParams {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  fields?: Record<string, unknown>;
}

/** 所有通知帧（housekeeping 类）的通用形状；plugin/ready 是其中之一。 */
export interface RpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

/** 带 id 的请求；回应必须回同一个 id。 */
export interface RpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface RpcSuccess {
  jsonrpc: '2.0';
  id: number | string | null;
  result: unknown;
}

export interface RpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcFailure {
  jsonrpc: '2.0';
  id: number | string | null;
  error: RpcErrorObject;
}

export type RpcMessage = RpcRequest | RpcNotification | RpcSuccess | RpcFailure;

/** JSON-RPC 2.0 标准错误码，外加内核自用的 HOST_REJECTED。 */
export const RpcErrorCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** 内核主动拒绝：能力不足、被动窗口已关、次数超限。 */
  HOST_REJECTED: -32000,
} as const;
