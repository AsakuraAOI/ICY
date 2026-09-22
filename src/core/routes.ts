/**
 * 所有 OpenAPI 路径的唯一来源。
 *
 * 业务代码里不允许出现拼好的 path 字符串，一律走这里。
 * 域名已在官方 20260810 变更记录中统一为 api.bot.qq.com。
 */

const DEFAULT_API_BASE = 'https://api.bot.qq.com';

let apiBase = DEFAULT_API_BASE;

/** 允许覆盖基址，用于代理 / 沙箱 / 私有部署。 */
export function setApiBase(url: string): void {
  apiBase = url.replace(/\/+$/, '');
}

export function getApiBase(): string {
  return apiBase;
}

/** 会话场景。C2C 与群聊的端点结构完全对称，只有路径片段不同。 */
export type MessageScope = 'c2c' | 'group';

/**
 * 会话资源路径前缀。
 *
 * 单聊与群聊的全部差异只在这一个片段上：`/v2/users/{openid}` 与
 * `/v2/groups/{group_openid}`。消息、文件、分片上传都挂在它下面，
 * 所以这里收成唯一一处，其余路径一律从它派生。
 */
function conversationBase(scope: MessageScope, targetId: string): string {
  const segment = scope === 'c2c' ? 'users' : 'groups';
  return `${apiBase}/v2/${segment}/${targetId}`;
}

/**
 * 统一消息发送入口。
 *
 * 文本 / Markdown / ARK / Embed / 输入状态 / 富媒体**全部**走这一个端点，
 * 区别只在请求体的 msg_type。没有 /ark、/embed 这类独立 endpoint。
 */
export function messagePath(scope: MessageScope, targetId: string): string {
  return `${conversationBase(scope, targetId)}/messages`;
}

/**
 * 富媒体上传（整文件）。
 *
 * 同时是分片上传的**完成**入口：分片全部传完后重新 POST 这里，
 * body 从 { file_type, ... } 换成 { upload_id }。没有独立的 /complete_upload。
 */
export function mediaUploadPath(scope: MessageScope, targetId: string): string {
  return `${conversationBase(scope, targetId)}/files`;
}

/** 分片上传 Step 1：准备，拿 upload_id 与各分片的预签名地址。 */
export function uploadPreparePath(scope: MessageScope, targetId: string): string {
  return `${conversationBase(scope, targetId)}/upload_prepare`;
}

/** 分片上传 Step 3：通知平台某个分片已传完。 */
export function uploadPartFinishPath(scope: MessageScope, targetId: string): string {
  return `${conversationBase(scope, targetId)}/upload_part_finish`;
}

/** 撤回消息。发送超过 2 分钟不可撤回，成功无响应体。 */
export function recallPath(scope: MessageScope, targetId: string, messageId: string): string {
  return `${conversationBase(scope, targetId)}/messages/${messageId}`;
}

export const routes = {
  /** 获取 access_token。注意：此接口失败时 HTTP 仍为 200，成败看 body.code。 */
  token: () => `${apiBase}/app/getAppAccessToken`,

  /** 获取通用 WSS 接入点。 */
  gateway: () => `${apiBase}/gateway`,
  /** 获取带分片信息的 WSS 接入点，额外返回 shards 与 session_start_limit。 */
  gatewaySharded: () => `${apiBase}/gateway/bot`,

  /** 机器人自身信息，用于 P1 阶段验证 token 是否可用。 */
  selfInfo: () => `${apiBase}/users/@me`,

  /** 发送群聊消息。等价于 messagePath('group', gid)。 */
  groupMessages: (groupOpenid: string) => messagePath('group', groupOpenid),
  /** 撤回群聊消息。等价于 recallPath('group', gid, mid)。 */
  groupMessage: (groupOpenid: string, messageId: string) =>
    recallPath('group', groupOpenid, messageId),

  /** 发送单聊消息。等价于 messagePath('c2c', uid)。 */
  c2cMessages: (userOpenid: string) => messagePath('c2c', userOpenid),
  /** 撤回单聊消息。 */
  c2cMessage: (userOpenid: string, messageId: string) =>
    recallPath('c2c', userOpenid, messageId),
  /** 流式发送单聊消息。仅私聊支持，群聊无此能力。 */
  c2cStreamMessages: (userOpenid: string) =>
    `${apiBase}/v2/users/${userOpenid}/stream_messages`,

  /** 单聊上传富媒体（整文件，也是分片完成后的合并入口）。 */
  c2cFiles: (userOpenid: string) => mediaUploadPath('c2c', userOpenid),
  /** 群聊上传富媒体。单聊与群聊上传接口不互通，文件不能跨场景使用。 */
  groupFiles: (groupOpenid: string) => mediaUploadPath('group', groupOpenid),
} as const;
