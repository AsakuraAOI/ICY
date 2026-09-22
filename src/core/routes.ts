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

export const routes = {
  /** 获取 access_token。注意：此接口失败时 HTTP 仍为 200，成败看 body.code。 */
  token: () => `${apiBase}/app/getAppAccessToken`,

  /** 获取通用 WSS 接入点。 */
  gateway: () => `${apiBase}/gateway`,
  /** 获取带分片信息的 WSS 接入点，额外返回 shards 与 session_start_limit。 */
  gatewaySharded: () => `${apiBase}/gateway/bot`,

  /** 机器人自身信息，用于 P1 阶段验证 token 是否可用。 */
  selfInfo: () => `${apiBase}/users/@me`,

  /** 发送群聊消息。本内核 MVP 的唯一发送接口。 */
  groupMessages: (groupOpenid: string) => `${apiBase}/v2/groups/${groupOpenid}/messages`,
  /** 撤回群聊消息。发送超过 2 分钟不可撤回。 */
  groupMessage: (groupOpenid: string, messageId: string) =>
    `${apiBase}/v2/groups/${groupOpenid}/messages/${messageId}`,

  /** 发送单聊消息。 */
  c2cMessages: (userOpenid: string) => `${apiBase}/v2/users/${userOpenid}/messages`,
  /** 撤回单聊消息。 */
  c2cMessage: (userOpenid: string, messageId: string) =>
    `${apiBase}/v2/users/${userOpenid}/messages/${messageId}`,
  /** 流式发送单聊消息。仅私聊支持，群聊无此能力。 */
  c2cStreamMessages: (userOpenid: string) =>
    `${apiBase}/v2/users/${userOpenid}/stream_messages`,

  /** 单聊上传富媒体（整文件 URL 方式，也是分片完成后的合并入口）。 */
  c2cFiles: (userOpenid: string) => `${apiBase}/v2/users/${userOpenid}/files`,
  /** 群聊上传富媒体。单聊与群聊上传接口不互通，文件不能跨场景使用。 */
  groupFiles: (groupOpenid: string) => `${apiBase}/v2/groups/${groupOpenid}/files`,

  // 分片上传的 upload_prepare / upload_part_finish 端点，官方页面尚未逐字核实，
  // 待补读《单聊富媒体预上传》《单聊分片上传完成》等页后再加，不凭记忆写死。
} as const;
