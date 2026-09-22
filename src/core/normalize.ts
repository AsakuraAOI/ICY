/**
 * 归一化：Gateway 原始 payload → 内核统一的 InboundEvent。
 *
 * 插件宿主只认识 InboundEvent，不认识 author.member_openid、group_openid、
 * message_scene.ext 这些平台私有结构。raw 字段永远保留原始 d，因为 QQ
 * 字段仍在演进，归一化层不可能一次覆盖全。
 */

import { LIFECYCLE_EVENT as CONNECTION_EVENT, Op } from './events.js';
import type {
  C2CMessageData,
  GatewayPayload,
  GroupMessageData,
  MessageAttachment,
} from '../types/qq.js';

export type { MessageAttachment };

export type EventKind = 'group' | 'c2c' | 'lifecycle' | 'unknown';

export interface InboundEvent {
  kind: EventKind;
  /** 原始事件类型，即 payload 的 t。 */
  eventType: string;
  /** payload 最外层的 id。 */
  eventId: string;
  /** payload 的 s。非 Dispatch 事件为 -1。 */
  seq: number;

  /** 消息 ID，即 d.id。被动回复与撤回用。 */
  messageId?: string;
  /** 发送者标识。群聊取 author.member_openid，单聊取 author.user_openid。 */
  senderId?: string;
  senderName?: string;
  /** 群内角色：member / admin / owner。 */
  senderRole?: string;
  senderIsBot?: boolean;

  /** 群 OpenID（群聊场景）。 */
  groupOpenid?: string;
  /** 用户 OpenID（单聊场景）。 */
  userOpenid?: string;

  /** 文本内容。群 @ 事件的这一字段已自动去掉 @机器人 前缀。 */
  content?: string;
  /** 0 普通文本 / 3 结构化卡片 / 101 并行消息 / 102 聊天记录 / 103 引用消息。 */
  contentType?: number;
  /** 消息发送时间，RFC3339 格式。 */
  timestamp?: string;

  /** 从 message_scene.ext 解析出的 msg_idx。 */
  msgIdx?: string;
  /** 从 message_scene.ext 解析出的 ref_msg_idx。 */
  refMsgIdx?: string;

  attachments?: MessageAttachment[];

  /** 永远保留的原始 d。 */
  raw: unknown;
}

/** 群消息类事件。两者的字段完全一致，区别只在触发条件。 */
const GROUP_EVENTS = new Set(['GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE']);

/** 单聊消息事件。 */
const C2C_EVENTS = new Set(['C2C_MESSAGE_CREATE']);

/** 群 / 好友生命周期事件，字段未逐字核实，只做透传。 */
const LIFECYCLE_EVENTS = new Set([
  'FRIEND_ADD',
  'FRIEND_DEL',
  'C2C_MSG_REJECT',
  'C2C_MSG_RECEIVE',
  'GROUP_ADD_ROBOT',
  'GROUP_DEL_ROBOT',
  'GROUP_MSG_REJECT',
  'GROUP_MSG_RECEIVE',
]);

/**
 * 解析 message_scene.ext。
 *
 * ext 是 key=value 格式的字符串数组，不是对象，例如
 * ["msg_idx=REFIDX_xxx==", "auth_token=xxx"]。值里本身可能含 =，
 * 所以只按第一个 = 切分。
 */
export function parseSceneExt(ext: readonly string[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (ext === undefined) return map;
  for (const item of ext) {
    const at = item.indexOf('=');
    if (at <= 0) continue;
    map.set(item.slice(0, at), item.slice(at + 1));
  }
  return map;
}

/**
 * 会话键。同一会话内的事件串行处理，不同会话之间并行。
 *
 * 注意：openid 不是 QQ 号，且不同 AppID 拿到的值不同这句成立，
 * 因此它只能作为本机器人内的会话标识，不能当跨应用主键。
 */
export function conversationKey(event: InboundEvent): string {
  switch (event.kind) {
    case 'group':
      return `qq:group:${event.groupOpenid ?? 'unknown'}`;
    case 'c2c':
      return `qq:c2c:${event.userOpenid ?? 'unknown'}`;
    default:
      return `qq:event:${event.eventId}`;
  }
}

/**
 * 把一条原始 payload 归一化成 InboundEvent。
 *
 * 返回 null 的三种情况：
 * - op 不是 0（心跳、Hello 等由 Gateway 状态机自己处理）；
 * - t 缺失（不是 Dispatch 事件）；
 * - t 是 READY / RESUMED（属于连接生命周期，同样归 Gateway）。
 */
export function normalize(payload: GatewayPayload): InboundEvent | null {
  if (payload.op !== Op.DISPATCH) return null;

  const eventType = payload.t;
  if (eventType === undefined || eventType === '') return null;
  if (eventType === CONNECTION_EVENT.READY || eventType === CONNECTION_EVENT.RESUMED) return null;

  const eventId = payload.id ?? '';
  const seq = payload.s ?? -1;

  if (GROUP_EVENTS.has(eventType)) {
    return fromGroupMessage(eventType, eventId, seq, payload.d as GroupMessageData);
  }
  if (C2C_EVENTS.has(eventType)) {
    return fromC2CMessage(eventType, eventId, seq, payload.d as C2CMessageData);
  }

  return {
    kind: LIFECYCLE_EVENTS.has(eventType) ? 'lifecycle' : 'unknown',
    eventType,
    eventId,
    seq,
    raw: payload.d,
  };
}

function fromGroupMessage(
  eventType: string,
  eventId: string,
  seq: number,
  d: GroupMessageData,
): InboundEvent {
  const event: InboundEvent = { kind: 'group', eventType, eventId, seq, raw: d };
  fillCommon(event, d, 'member');
  if (typeof d.group_openid === 'string') event.groupOpenid = d.group_openid;
  return event;
}

function fromC2CMessage(
  eventType: string,
  eventId: string,
  seq: number,
  d: C2CMessageData,
): InboundEvent {
  const event: InboundEvent = { kind: 'c2c', eventType, eventId, seq, raw: d };
  fillCommon(event, d, 'user');
  // 单聊示例里 author.id 与 author.user_openid 取值相同，因此允许回退。
  const userOpenid = d.author?.user_openid ?? d.author?.id;
  if (typeof userOpenid === 'string') event.userOpenid = userOpenid;
  return event;
}

/** 抽取群聊与单聊共有的字段。 */
function fillCommon(
  event: InboundEvent,
  d: GroupMessageData | C2CMessageData,
  idSource: 'member' | 'user',
): void {
  if (typeof d.id === 'string') event.messageId = d.id;
  if (typeof d.content === 'string') event.content = d.content;
  if (typeof d.message_type === 'number') event.contentType = d.message_type;
  if (typeof d.timestamp === 'string') event.timestamp = d.timestamp;
  if (Array.isArray(d.attachments)) event.attachments = d.attachments;

  const author = d.author;
  if (author !== undefined) {
    if (typeof author.username === 'string') event.senderName = author.username;
    if (typeof author.bot === 'boolean') event.senderIsBot = author.bot;
    if (typeof author.member_role === 'string') event.senderRole = author.member_role;
    const preferred = idSource === 'member' ? author.member_openid : author.user_openid;
    const senderId = preferred ?? author.id;
    if (typeof senderId === 'string') event.senderId = senderId;
  }

  const ext = parseSceneExt(d.message_scene?.ext);
  const msgIdx = ext.get('msg_idx');
  if (msgIdx !== undefined) event.msgIdx = msgIdx;
  const refMsgIdx = ext.get('ref_msg_idx');
  if (refMsgIdx !== undefined) event.refMsgIdx = refMsgIdx;
}
