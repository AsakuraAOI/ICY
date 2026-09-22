/**
 * QQ Bot API v2 协议常量：opcode / intents / 事件名 / Gateway 关闭码。
 *
 * 本文件只做命名，不含逻辑。状态机在 gateway.ts，路由在 dispatch.ts。
 * 依据：官方文档《通用数据结构》《WebSocket 方式》《消息收发概述》。
 */

/** Gateway opcode。文档 CODE 列。 */
export const Op = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
  /** 仅 webhook：机器人收到平台推送后的回包。 */
  HTTP_CALLBACK_ACK: 12,
  /** 仅 webhook：开放平台对回调地址的验证。 */
  CALLBACK_VERIFY: 13,
} as const;

export type OpCode = (typeof Op)[keyof typeof Op];

/**
 * Intents 位移。
 *
 * 权限注意：只有 GUILDS / GUILD_MEMBERS / PUBLIC_GUILD_MESSAGES 默认有权限，
 * 其余必须向平台申请。Identify 时传了无权限的 intents，服务端会直接关闭连接。
 * 另外：某个已授权的 intent 权限若被取消，当前连接不报错但收不到该事件，
 * 重连时才会报错——所以启动时应做一次权限预检而不是连上再炸。
 */
export const IntentBit = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  /** 仅私域机器人可设置。 */
  GUILD_MESSAGES: 1 << 9,
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  DIRECT_MESSAGE: 1 << 12,
  /** 普通 QQ 群 + 单聊。本内核 MVP 唯一需要的 intents。 */
  GROUP_AND_C2C_EVENT: 1 << 25,
  INTERACTION: 1 << 26,
  MESSAGE_AUDIT: 1 << 27,
  /** 仅私域机器人可设置。 */
  FORUMS_EVENT: 1 << 28,
  AUDIO_ACTION: 1 << 29,
  PUBLIC_GUILD_MESSAGES: 1 << 30,
} as const;

/** 插件 manifest 里可以声明的 intents 名字。 */
export type IntentName = keyof typeof IntentBit;

/** 默认即有权限、无需申请的 intents。 */
export const DEFAULT_ALLOWED_INTENTS: readonly IntentName[] = [
  'GUILDS',
  'GUILD_MEMBERS',
  'PUBLIC_GUILD_MESSAGES',
];

/** 每个 intent 覆盖的事件名（payload 的 t 字段取值）。 */
export const INTENT_EVENTS: Record<IntentName, readonly string[]> = {
  GUILDS: [
    'GUILD_CREATE',
    'GUILD_UPDATE',
    'GUILD_DELETE',
    'CHANNEL_CREATE',
    'CHANNEL_UPDATE',
    'CHANNEL_DELETE',
  ],
  GUILD_MEMBERS: ['GUILD_MEMBER_ADD', 'GUILD_MEMBER_UPDATE', 'GUILD_MEMBER_REMOVE'],
  GUILD_MESSAGES: ['MESSAGE_CREATE', 'MESSAGE_DELETE'],
  GUILD_MESSAGE_REACTIONS: ['MESSAGE_REACTION_ADD', 'MESSAGE_REACTION_REMOVE'],
  DIRECT_MESSAGE: ['DIRECT_MESSAGE_CREATE', 'DIRECT_MESSAGE_DELETE'],
  GROUP_AND_C2C_EVENT: [
    'C2C_MESSAGE_CREATE',
    'FRIEND_ADD',
    'FRIEND_DEL',
    'C2C_MSG_REJECT',
    'C2C_MSG_RECEIVE',
    'GROUP_AT_MESSAGE_CREATE',
    'GROUP_ADD_ROBOT',
    'GROUP_DEL_ROBOT',
    'GROUP_MSG_REJECT',
    'GROUP_MSG_RECEIVE',
    // 《群消息（全量模式）》页明确标注同属本 intent，
    // 但《通用数据结构》的事件枚举漏了它，此处补上。
    'GROUP_MESSAGE_CREATE',
  ],
  INTERACTION: ['INTERACTION_CREATE'],
  MESSAGE_AUDIT: ['MESSAGE_AUDIT_PASS', 'MESSAGE_AUDIT_REJECT'],
  FORUMS_EVENT: [
    'FORUM_THREAD_CREATE',
    'FORUM_THREAD_UPDATE',
    'FORUM_THREAD_DELETE',
    'FORUM_POST_CREATE',
    'FORUM_POST_DELETE',
    'FORUM_REPLY_CREATE',
    'FORUM_REPLY_DELETE',
    'FORUM_PUBLISH_AUDIT_RESULT',
  ],
  AUDIO_ACTION: ['AUDIO_START', 'AUDIO_FINISH', 'AUDIO_ON_MIC', 'AUDIO_OFF_MIC'],
  PUBLIC_GUILD_MESSAGES: ['AT_MESSAGE_CREATE', 'PUBLIC_MESSAGE_DELETE'],
};

/** 非 intents 驱动、连接建立后必发的生命周期事件。 */
export const LIFECYCLE_EVENT = {
  READY: 'READY',
  RESUMED: 'RESUMED',
} as const;

/** 把 manifest 声明的 intents 名字聚合成 Identify 要传的整数。 */
export function intentsToBits(intents: readonly IntentName[]): number {
  let bits = 0;
  for (const name of intents) bits |= IntentBit[name];
  return bits;
}

/** 由 intents 反推这个连接可能收到的事件名集合。 */
export function eventsForIntents(intents: readonly IntentName[]): ReadonlySet<string> {
  const set = new Set<string>();
  for (const name of intents) {
    for (const event of INTENT_EVENTS[name]) set.add(event);
  }
  return set;
}

/** Gateway 关闭码 → 重连策略。 */
export type CloseAction = 'resume' | 'identify' | 'fatal';

export function closeAction(code: number): CloseAction {
  switch (code) {
    case 4006: // 无效 session id，无法继续 resume
    case 4007: // seq 错误
      return 'identify';
    case 4008: // 发送 payload 过快
    case 4009: // 连接过期
      return 'resume';
    case 4001: // 无效 opcode
    case 4002: // 无效 payload
    case 4010: // 无效 shard
    case 4012: // 无效 version
    case 4013: // 无效 intent
    case 4014: // intent 无权限
    case 4914: // 机器人已下架，只允许连接沙箱环境
    case 4915: // 机器人已封禁
      return 'fatal';
    default:
      // 4900~4913 内部错误，以及未列举的码，按 identify 兜底。
      return 'identify';
  }
}

/** 重连退避阶梯（毫秒），配合 jitter 使用。不要无延迟 while(true)。 */
export const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000, 60000] as const;
