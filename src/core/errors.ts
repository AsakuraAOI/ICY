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

  constructor(code: number, detail: string, hint = '') {
    super(
      `token 接口失败 code=${code}${detail === '' ? '' : ` (${detail})`}${hint === '' ? '' : `：${hint}`}`,
    );
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

/**
 * token 错误码的处置建议，会被拼进错误消息。
 *
 * 不拼的话，日志里只剩一串 code —— 使用者唯一能做的事就是反复重启，而配置类错误重启
 * 一万次也还是错。处置建议必须跟着错误一起出现，而不是留在文档里等人去查。
 */
export function tokenErrorHint(code: number): string {
  if (isTokenErrorFatal(code)) {
    return '这是配置问题，重试无用。请检查 QQ_APP_ID / QQ_APP_SECRET 是否与开放平台一致、机器人是否已创建';
  }
  if (isTokenErrorRetryable(code)) return '平台限流，稍后重试';
  return '';
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
    // trace_id 是唯一能把一次失败追回平台侧的依据。调用方统一拿 message 记日志，
    // 不做特殊处理，所以它必须出现在 message 里，否则等于抓到了却不落地。
    const tracePart = init.traceId === null ? '' : ` trace_id=${init.traceId}`;
    const detailPart = init.detail === '' ? '' : ` (${init.detail})`;
    super(`OpenAPI 失败 HTTP ${init.httpStatus} ${init.path}${errPart}${tracePart}${detailPart}`);
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

/**
 * 发送失败对插件可见的稳定原因。
 *
 * 插件不该自己解析 err_code —— 那是平台私有字段，取值和文案都可能变。但插件确实需要
 * 区分「被动窗口过期了，重试也没用」和「网络抖了一下，值得退避重试」，所以内核把常见的
 * 几种失败翻译成固定枚举。
 */
export type SendFailureReason =
  | 'window_expired'
  | 'duplicate_msg_seq'
  | 'not_group_member'
  | 'muted'
  | 'auth_failed'
  | 'network'
  | 'media_upload'
  | 'unknown';

/**
 * 把发送路径的失败翻译成稳定 reason。
 *
 * 顺序有讲究：ApiError 与 TransportError 先判，MediaUploadError 最后 —— 上传链路里
 * 的 API 错误必须保留原本的分类（window_expired / auth_failed 之类），
 * 不能被「它发生在上传阶段」这件事覆盖掉。
 */
export function describeSendFailure(error: unknown): SendFailureReason {
  if (error instanceof ApiError) {
    if (isPassiveWindowExpired(error)) return 'window_expired';
    if (isDuplicateMessage(error)) return 'duplicate_msg_seq';
    if (isNotGroupMember(error)) return 'not_group_member';
    if (isBotMuted(error)) return 'muted';
    if (isAuthFailure(error)) return 'auth_failed';
    return 'unknown';
  }
  if (error instanceof TransportError) return 'network';
  // 本地失败：取源 / 解码 / 摘要 / 分片编排。具体是哪一步在 message 的 stage= 前缀里。
  if (error instanceof MediaUploadError) return 'media_upload';
  return 'unknown';
}

/**
 * 撤回失败对插件可见的稳定原因。
 *
 * 撤回窗口只有 2 分钟（比被动回复的 5 分钟更紧），且权限规则分两档：群管理员可撤回
 * 自己的消息与普通成员的消息，普通成员只能撤回自己发的。插件必须能区分「过期了」
 * 和「没权限」，前者重试无用，后者说明用法错了。
 */
export type RecallFailureReason =
  | 'recall_expired'
  | 'no_permission'
  | 'invalid_message_id'
  | 'retryable'
  | 'auth_failed'
  | 'network'
  | 'unknown';

/** 把撤回路径的失败翻译成稳定 reason。依据官方错误码表，不依赖 message 文案。 */
export function describeRecallFailure(error: unknown): RecallFailureReason {
  if (error instanceof ApiError) {
    switch (error.errCode) {
      case 40064004: // 已超出消息撤回时限
        return 'recall_expired';
      case 40062003: // 无操作权限
        return 'no_permission';
      case 40061001: // 请求参数无效
      case 40061002: // msgid 无效
      case 306009: // 用户 openid 无效
        return 'invalid_message_id';
      case 50065001: // 消息撤回失败，请稍后重试
        return 'retryable';
      default:
        return isAuthFailure(error) ? 'auth_failed' : 'unknown';
    }
  }
  if (error instanceof TransportError) return 'network';
  return 'unknown';
}

/** 网络层失败：fetch 抛错、超时、响应不是合法 JSON。 */
export class TransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TransportError';
  }
}

/**
 * 富媒体上传链路的本地失败。
 *
 * 这不是平台协议问题，而是本项目自己的错误 taxonomy 问题：上传是一条多阶段编排
 * （取源 → 解码 → 摘要 → prepare → 分片 PUT → part_finish → 合并），任何一步塌掉
 * 都应该能说出是哪一步，而不是统统退化成 unknown。
 *
 * **只在本地处理或协议编排失败时使用。** 如果底层拿到的是 QQ REST 的错误响应，
 * 必须原样抛出 `ApiError`（保留 httpStatus / errCode / traceId / path），
 * 不要为了「统一」把它包成 MediaUploadError —— 那会把唯一能追回平台侧的信息丢掉。
 */
export type MediaUploadStage =
  | 'source'
  | 'decode'
  | 'hash'
  | 'prepare'
  | 'part_upload'
  | 'part_finish'
  | 'complete';

export class MediaUploadError extends Error {
  readonly kind = 'media_upload';
  readonly stage: MediaUploadStage;

  constructor(message: string, stage: MediaUploadStage, options?: ErrorOptions) {
    // stage 拼进 message：调用方统一只记 message，留在字段里等于没落地。
    super(`[stage=${stage}] ${message}`, options);
    this.name = 'MediaUploadError';
    this.stage = stage;
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
