/**
 * 错误分类。
 *
 * QQ 平台的三条链路各用不同方式表示失败，它们之间不能互相混用：
 *
 * | 链路       | 判定依据                                  |
 * | ---------- | ----------------------------------------- |
 * | token 接口 | HTTP 恒为 200，成败看 body 的 code         |
 * | OpenAPI    | HTTP 状态码 + body 的 err_code（成功为 0） |
 * | Gateway    | WebSocket 关闭码                           |
 *
 * `message` 字段的文案官方随时可能调整，任何判断都不允许依赖它。
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/**
 * token 接口失败。
 * 注意：此接口失败时 HTTP 仍然返回 200，失败信息在 body 的 code 里。
 */
export class TokenError extends Error {
  readonly code: number;

  constructor(code: number, detail: string) {
    super(`token 接口失败 code=${code}${detail === '' ? '' : ` (${detail})`}`);
    this.name = 'TokenError';
    this.code = code;
  }
}

/**
 * token 错误的处置建议。
 * - 100001 Too many requests → 可重试
 * - 100007 appid invalid / 100016 invalid appid or secret / 10004 机器人不存在
 *   → 配置或机器人状态问题，重试无用
 */
export function isTokenErrorRetryable(code: number): boolean {
  return code === 100001;
}

export function isTokenErrorFatal(code: number): boolean {
  return code === 100007 || code === 100016 || code === 10004;
}

export interface ApiErrorInit {
  httpStatus: number;
  path: string;
  errCode: number | null;
  traceId: string | null;
  body: unknown;
  detail: string;
}

/** OpenAPI 失败。判定依据是 HTTP 状态码 + body 的 err_code。 */
export class ApiError extends Error {
  readonly httpStatus: number;
  readonly path: string;
  readonly errCode: number | null;
  readonly traceId: string | null;
  readonly body: unknown;

  constructor(init: ApiErrorInit) {
    const errPart = init.errCode === null ? '' : ` err_code=${init.errCode}`;
    const detailPart = init.detail === '' ? '' : ` (${init.detail})`;
    super(`OpenAPI 失败 HTTP ${init.httpStatus} ${init.path}${errPart}${detailPart}`);
    this.name = 'ApiError';
    this.httpStatus = init.httpStatus;
    this.path = init.path;
    this.errCode = init.errCode;
    this.traceId = init.traceId;
    this.body = init.body;
  }
}

/** 需要丢弃 token 缓存并重取一次的失败。 */
export function isAuthFailure(error: ApiError): boolean {
  return error.httpStatus === 401 || error.errCode === 11241 || error.errCode === 11243;
}

/**
 * 被动回复窗口已过期 / 次数超限 / msg_id 越权。
 * 群聊窗口只有 5 分钟、最多 5 次，这是 AI 类插件最容易撞的错误。
 */
export function isPassiveWindowExpired(error: ApiError): boolean {
  switch (error.errCode) {
    case 40034005: // 回复消息 msg_id 已过期
    case 304103: // 消息 ID 已过期，不能回复
    case 40034128: // 被动回复时间或次数超限
    case 40034024: // msg_id 无效或越权
    case 40034026: // event_id 已过期
      return true;
    default:
      return false;
  }
}

/** 相同 msg_id + msg_seq 重复发送。递增 msg_seq 即可避开。 */
export function isDuplicateMessage(error: ApiError): boolean {
  return error.errCode === 40054005;
}

/** 机器人不在群里 / 已不是群成员。 */
export function isNotGroupMember(error: ApiError): boolean {
  return error.errCode === 40054003 || error.errCode === 40034101;
}

/** 机器人被禁言。 */
export function isBotMuted(error: ApiError): boolean {
  return error.errCode === 40054002;
}

/** 网络层失败：fetch 抛错、超时、响应不是合法 JSON。 */
export class TransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TransportError';
  }
}

/**
 * 不可恢复的错误，重连只会徒劳循环。
 *
 * 对应 Gateway 关闭码 4001/4002/4010/4012/4013/4014（协议或 intents 权限问题）
 * 与 4914（机器人已下架，只允许连沙箱）/ 4915（已封禁）。
 * 遇到这些必须停下来让人处理，而不是继续退避重连。
 */
export class FatalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FatalError';
  }
}
