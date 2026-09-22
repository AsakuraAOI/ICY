/**
 * QQApiClient：OpenAPI 的统一入口。
 *
 * 职责：
 * - 每个请求自动带 token，401 / 11241 / 11243 失效时丢弃缓存重取一次再重试一次；
 * - 失败统一归一为 ApiError，记录 err_code 与 trace_id；
 * - 把「发消息」收成两个通用原语（群 / 单聊各一个）：文本、Markdown、ARK、Embed、
 *   输入状态、富媒体全部走它们，只在 msg_type 上分叉 —— 平台本来也只有一个发送端点；
 * - 富媒体的「上传 → file_info → 发送」两段式收在 core/media.ts，这里只做编排。
 *
 * message 字段的文案官方可能随时调整，任何逻辑都不允许依赖它。
 */

import { messagePath, routes, type MessageScope } from './routes.js';
import { uploadMedia, MediaFileType, type MediaFileTypeValue, type UploadMediaParams } from './media.js';
import type {
  ArkBody,
  BotSelfInfo,
  EmbedBody,
  Keyboard,
  SendMessageBody,
  SendMessageResponse,
  UploadMediaResponse,
} from '../types/qq.js';
import { ApiError, TransportError, isAuthFailure, type HttpMethod } from './errors.js';
import type { TokenManager } from './token.js';

export interface SendResult {
  messageId: string;
  timestamp: string;
}

/** 被动回复 / 主动消息共用的定位参数。 */
export interface SendTargetParams {
  msgId?: string;
  /** 不传默认 1（不是 0）。相同 msg_id + msg_seq 重复发送会失败。 */
  msgSeq?: number;
}

/** 发送「已经上传好的」富媒体时的参数。 */
export interface SendMediaParams {
  /** 上传接口返回的 file_info。 */
  fileInfo: string;
  /** 可选说明文字，与媒体一起下发。 */
  content?: string;
  msgId?: string;
  msgSeq?: number;
}

/** 上传并发送富媒体时的参数：上传入参 + 发送入参。 */
export interface MediaSendParams extends UploadMediaParams {
  content?: string;
  msgId?: string;
  msgSeq?: number;
}

export interface QQApiClientOptions {
  tokenManager: TokenManager;
  /** 单次请求超时，默认 15 秒。 */
  timeoutMs?: number;
  /** 上传相关请求的超时，默认 60 秒。分片上传按片计，整条链路会更久。 */
  uploadTimeoutMs?: number;
}

/** 补上 msg_seq 与 msg_id。msg_seq 默认 1 而不是 0：平台按它判重。 */
function withTarget(body: SendMessageBody, params: SendTargetParams): SendMessageBody {
  body.msg_seq = params.msgSeq ?? 1;
  if (params.msgId !== undefined) body.msg_id = params.msgId;
  return body;
}

/** 组装文本 body（msg_type=0）。 */
function textBody(content: string, params: SendTargetParams): SendMessageBody {
  return withTarget({ msg_type: 0, content }, params);
}

/** 组装富媒体 body（msg_type=7）。content 可选，平台允许媒体带一段说明文字。 */
function mediaBody(params: SendMediaParams): SendMessageBody {
  const body: SendMessageBody = { msg_type: 7, media: { file_info: params.fileInfo } };
  if (params.content !== undefined) body.content = params.content;
  return withTarget(body, params);
}

export class QQApiClient {
  readonly #tokens: TokenManager;
  readonly #timeoutMs: number;
  readonly #uploadTimeoutMs: number;

  constructor(options: QQApiClientOptions) {
    this.#tokens = options.tokenManager;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#uploadTimeoutMs = options.uploadTimeoutMs ?? 60_000;
  }

  /**
   * 通用发送原语（群聊）。
   *
   * 平台只有一个发送端点，msg_type 决定载荷字段，所以内核也只留一个原语：
   * 文本 / Markdown / ARK / Embed / 输入状态 / 富媒体全从这里出去。传进来的
   * body 原样序列化，内核不替调用方改写字段。
   */
  async sendGroupMessage(groupOpenid: string, body: SendMessageBody): Promise<SendResult> {
    return this.#send('group', groupOpenid, body);
  }

  /** 发送群文本。msg_type=0 的便捷写法。 */
  async sendGroupText(params: {
    groupOpenid: string;
    content: string;
    msgId?: string;
    /** 不传默认 1（不是 0）。 */
    msgSeq?: number;
  }): Promise<SendResult> {
    return this.sendGroupMessage(params.groupOpenid, textBody(params.content, params));
  }

  /**
   * 上传富媒体（群聊），拿到 file_info。
   *
   * 整传还是分片由 core/media.ts 决定，调用方不需要知道 5 MiB 这个边界，
   * 也不需要重复实现底层 HTTP。
   */
  async uploadGroupMedia(
    params: { groupOpenid: string } & UploadMediaParams,
  ): Promise<UploadMediaResponse> {
    const { groupOpenid, ...rest } = params;
    return uploadMedia(this, 'group', groupOpenid, rest, this.#uploadTimeoutMs);
  }

  /**
   * 发送已上传的富媒体（msg_type=7，群聊）。
   *
   * 这是两段式里可复用的那一半：同一个 file_info 可以配不同的 msg_id / msg_seq
   * 多次发送，不必每次重传。
   */
  async sendGroupMedia(params: SendMediaParams & { groupOpenid: string }): Promise<SendResult> {
    return this.sendGroupMessage(params.groupOpenid, mediaBody(params));
  }

  /**
   * 通用发送原语（单聊）。
   *
   * 与群聊共用 SendMessageBody；被动回复窗口同样是 5 分钟 / 最多 5 次，
   * 所以 msg_id 与 msg_seq 的用法与群聊完全一致。
   */
  async sendC2CMessage(userOpenid: string, body: SendMessageBody): Promise<SendResult> {
    return this.#send('c2c', userOpenid, body);
  }

  /** 发送单聊文本。msg_type=0 的便捷写法。 */
  async sendC2CText(params: {
    userOpenid: string;
    content: string;
    msgId?: string;
    msgSeq?: number;
  }): Promise<SendResult> {
    return this.sendC2CMessage(params.userOpenid, textBody(params.content, params));
  }

  /** 上传富媒体（单聊）。与群聊上传接口不互通，file_info 不能跨场景使用。 */
  async uploadC2CMedia(
    params: { userOpenid: string } & UploadMediaParams,
  ): Promise<UploadMediaResponse> {
    const { userOpenid, ...rest } = params;
    return uploadMedia(this, 'c2c', userOpenid, rest, this.#uploadTimeoutMs);
  }

  /** 发送已上传的富媒体（msg_type=7，单聊）。 */
  async sendC2CMedia(params: SendMediaParams & { userOpenid: string }): Promise<SendResult> {
    return this.sendC2CMessage(params.userOpenid, mediaBody(params));
  }

  /**
   * 机器人自身信息。
   *
   * 这是唯一一条只读、无副作用的接口，因此适合在启动阶段用来验证凭证真的可用
   * （DESIGN.md 的 P1），并把 username 带给插件用于日志归因。
   */
  async getSelfInfo(): Promise<BotSelfInfo> {
    const self = await this.request<BotSelfInfo>('GET', routes.selfInfo());
    if (typeof self.id !== 'string' || self.id === '') {
      throw new TransportError('机器人自身信息响应缺少 id');
    }
    return self;
  }

  /**
   * 撤回群消息。
   *
   * 平台限制：发送超过 2 分钟不可撤回。成功返回 HTTP 200 且**无响应体**，所以这里
   * 返回 void —— 调用方不能假设拿得到任何回执。
   *
   * 权限分两档：机器人是群管理员时可撤回自己的消息与普通成员的消息；普通成员身份
   * 下只能撤回自己发送的。内核不替插件判断这一档，越权会被平台拒绝（40062003）。
   */
  async recallGroupMessage(params: { groupOpenid: string; messageId: string }): Promise<void> {
    await this.request<unknown>(
      'DELETE',
      routes.groupMessage(params.groupOpenid, params.messageId),
    );
  }

  /**
   * 撤回单聊消息。只能撤回机器人自己发送给该用户的消息，同样受 2 分钟限制。
   */
  async recallC2CMessage(params: { userOpenid: string; messageId: string }): Promise<void> {
    await this.request<unknown>('DELETE', routes.c2cMessage(params.userOpenid, params.messageId));
  }

  // ------------------------------------------------------------ 分类型便捷写法
  // 下面这些都不是独立协议：ARK / Embed / Keyboard 只是 body 上的字段，媒体只是
  // 「先上传再发 msg_type=7」。它们存在的意义是让调用方不必自己拼 msg_type。

  /** 发送 ARK 卡片（msg_type=3）。平台没有 /ark 端点。 */
  async sendGroupArk(
    params: { groupOpenid: string; ark: ArkBody } & SendTargetParams,
  ): Promise<SendResult> {
    return this.sendGroupMessage(
      params.groupOpenid,
      withTarget({ msg_type: 3, ark: params.ark }, params),
    );
  }

  async sendC2CArk(
    params: { userOpenid: string; ark: ArkBody } & SendTargetParams,
  ): Promise<SendResult> {
    return this.sendC2CMessage(
      params.userOpenid,
      withTarget({ msg_type: 3, ark: params.ark }, params),
    );
  }

  /** 发送 Embed（msg_type=4）。同样没有独立端点。 */
  async sendGroupEmbed(
    params: { groupOpenid: string; embed: EmbedBody } & SendTargetParams,
  ): Promise<SendResult> {
    return this.sendGroupMessage(
      params.groupOpenid,
      withTarget({ msg_type: 4, embed: params.embed }, params),
    );
  }

  async sendC2CEmbed(
    params: { userOpenid: string; embed: EmbedBody } & SendTargetParams,
  ): Promise<SendResult> {
    return this.sendC2CMessage(
      params.userOpenid,
      withTarget({ msg_type: 4, embed: params.embed }, params),
    );
  }

  /** 发送带内嵌键盘的文本（msg_type=0 + keyboard 字段，一次提交）。 */
  async sendGroupKeyboard(
    params: { groupOpenid: string; content: string; keyboard: Keyboard } & SendTargetParams,
  ): Promise<SendResult> {
    return this.sendGroupMessage(
      params.groupOpenid,
      withTarget({ msg_type: 0, content: params.content, keyboard: params.keyboard }, params),
    );
  }

  async sendC2CKeyboard(
    params: { userOpenid: string; content: string; keyboard: Keyboard } & SendTargetParams,
  ): Promise<SendResult> {
    return this.sendC2CMessage(
      params.userOpenid,
      withTarget({ msg_type: 0, content: params.content, keyboard: params.keyboard }, params),
    );
  }

  /**
   * C2C 输入状态（msg_type=6）。
   *
   * 6 是「正在输入」，不是媒体消息 —— 它同样走 /messages，也同样要 msg_seq。
   * 群聊没有这个能力。
   */
  async sendC2CInputNotify(
    params: { userOpenid: string; inputType?: number; inputSecond?: number } & SendTargetParams,
  ): Promise<SendResult> {
    const notify = {
      input_type: params.inputType ?? 1,
      input_second: params.inputSecond ?? 60,
    };
    return this.sendC2CMessage(
      params.userOpenid,
      withTarget({ msg_type: 6, input_notify: notify }, params),
    );
  }

  /**
   * 两个通用原语共用的发送实现。
   *
   * scope 只决定端点与定位字段，msg_type 与载荷由 body 决定 —— 这就是平台
   * 「所有消息都发到 /messages」这件事在内核里的落点。
   */
  async #send(scope: MessageScope, targetId: string, body: SendMessageBody): Promise<SendResult> {
    const res = await this.request<SendMessageResponse>(
      'POST',
      messagePath(scope, targetId),
      body,
    );
    return { messageId: res.id, timestamp: res.timestamp };
  }

  /**
   * 先上传、再发 msg_type=7。
   *
   * 图片 / 语音 / 视频 / 文件共用这一条链路，只有 file_type 不同 —— 不存在四套
   * 独立的发送协议，也不存在让调用方自己判断「该不该分片」的地方。
   */
  async #uploadAndSend(
    scope: MessageScope,
    targetId: string,
    fileType: MediaFileTypeValue,
    params: MediaSendParams,
  ): Promise<SendResult> {
    const source: UploadMediaParams = { fileType };
    if (params.data !== undefined) source.data = params.data;
    if (params.url !== undefined) source.url = params.url;
    if (params.fileName !== undefined) source.fileName = params.fileName;
    if (params.localPath !== undefined) source.localPath = params.localPath;

    const uploaded = await uploadMedia(this, scope, targetId, source, this.#uploadTimeoutMs);
    return this.#send(scope, targetId, mediaBody({ ...params, fileInfo: uploaded.file_info }));
  }

  /** 上传并发送图片。 */
  async sendGroupImage(params: { groupOpenid: string } & MediaSendParams): Promise<SendResult> {
    return this.#uploadAndSend('group', params.groupOpenid, MediaFileType.IMAGE, params);
  }
  async sendC2CImage(params: { userOpenid: string } & MediaSendParams): Promise<SendResult> {
    return this.#uploadAndSend('c2c', params.userOpenid, MediaFileType.IMAGE, params);
  }
  /** 上传并发送语音。 */
  async sendGroupVoice(params: { groupOpenid: string } & MediaSendParams): Promise<SendResult> {
    return this.#uploadAndSend('group', params.groupOpenid, MediaFileType.VOICE, params);
  }
  async sendC2CVoice(params: { userOpenid: string } & MediaSendParams): Promise<SendResult> {
    return this.#uploadAndSend('c2c', params.userOpenid, MediaFileType.VOICE, params);
  }
  /** 上传并发送视频。 */
  async sendGroupVideo(params: { groupOpenid: string } & MediaSendParams): Promise<SendResult> {
    return this.#uploadAndSend('group', params.groupOpenid, MediaFileType.VIDEO, params);
  }
  async sendC2CVideo(params: { userOpenid: string } & MediaSendParams): Promise<SendResult> {
    return this.#uploadAndSend('c2c', params.userOpenid, MediaFileType.VIDEO, params);
  }
  /** 上传并发送普通文件（file_type=4，必须给 fileName）。 */
  async sendGroupFile(params: { groupOpenid: string } & MediaSendParams): Promise<SendResult> {
    return this.#uploadAndSend('group', params.groupOpenid, MediaFileType.FILE, params);
  }
  async sendC2CFile(params: { userOpenid: string } & MediaSendParams): Promise<SendResult> {
    return this.#uploadAndSend('c2c', params.userOpenid, MediaFileType.FILE, params);
  }

  /** 原始逃生舱，仅内核内部与受信任插件使用。 */
  async request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
    const token = await this.#tokens.get();
    try {
      return await this.#roundtrip<T>(method, path, body, token);
    } catch (error) {
      // token 失效：丢弃缓存、重取、只重试一次。
      if (error instanceof ApiError && isAuthFailure(error)) {
        this.#tokens.invalidate();
        const fresh = await this.#tokens.get();
        return this.#roundtrip<T>(method, path, body, fresh);
      }
      throw error;
    }
  }

  async #roundtrip<T>(method: HttpMethod, path: string, body: unknown, token: string): Promise<T> {
    // exactOptionalPropertyTypes 下 RequestInit.body 不接受显式 undefined：
    // 必须让这个属性整个不出现，所以按需构造 init 而不是塞 undefined。
    const init: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `QQBot ${token}`,
      },
      signal: AbortSignal.timeout(this.#timeoutMs),
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    let res: Response;
    try {
      res = await fetch(path, init);
    } catch (cause) {
      throw new TransportError(`OpenAPI 请求失败 ${method} ${path}：网络或超时`, { cause });
    }

    let parsed: unknown = null;
    const text = await res.text();
    if (text !== '') {
      try {
        parsed = JSON.parse(text);
      } catch (cause) {
        throw new TransportError(`OpenAPI 返回的不是合法 JSON（HTTP ${res.status}）`, { cause });
      }
    }

    const record = (parsed !== null && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
    const errCode = typeof record.err_code === 'number' ? record.err_code : null;
    const traceId =
      (typeof record.trace_id === 'string' ? record.trace_id : null) ??
      res.headers.get('X-Tps-trace-ID');

    if (!res.ok || (errCode !== null && errCode !== 0)) {
      throw new ApiError({
        httpStatus: res.status,
        path,
        errCode,
        traceId,
        body: parsed,
        detail: typeof record.message === 'string' ? record.message : '',
      });
    }

    return parsed as T;
  }
}