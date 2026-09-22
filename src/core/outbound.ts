/**
 * 出站消息模型：插件能表达的「发送意图」，与 QQ 的协议字段解耦。
 *
 * 这一层存在的理由：入站与出站**不是镜像**。msg_elements / mentions / ark_data 是
 * 事件的形状，插件的发送意图是另一套形状 —— 把收到的 msg_elements 原样提交回
 * /messages 在协议上根本不成立。所以这里只描述「想发什么」，由 sendOutbound()
 * 翻译成 msg_type 与载荷字段。
 *
 * 插件永远看不到 msg_type、openid URL、upload_id、presigned_url、file_info。
 */

import { MediaFileType, type MediaFileTypeValue, type UploadMediaParams } from './media.js';
import type { MessageScope } from './routes.js';
import type {
  ArkBody,
  ArkKV,
  ArkObj,
  ArkObjKV,
  EmbedBody,
  EmbedField,
  Keyboard,
  SendMessageBody,
} from '../types/qq.js';
import type { SendResult, SendTargetParams } from './api.js';
import type { UploadMediaResponse } from '../types/qq.js';

export { MediaFileType };
export type { MediaFileTypeValue };

/** 所有消息都能附带的两样东西：内嵌键盘与引用回复。都不是独立接口。 */
export interface OutboundModifiers {
  /** 随消息一起下发的内嵌键盘。 */
  keyboard?: Keyboard;
  /** 引用回复：填被引用消息的 message_id。 */
  referenceMessageId?: string;
}

/**
 * 插件的发送意图。
 *
 * media 一种就覆盖图片 / 语音 / 视频 / 文件 —— 它们在协议上是同一条
 * 「先上传再发 msg_type=7」的链路，只有 fileType 不同。
 */
export type OutboundMessage = OutboundModifiers &
  (
    | { kind: 'text'; text: string }
    | { kind: 'markdown'; markdown: string }
    | { kind: 'ark'; ark: ArkBody }
    | { kind: 'embed'; embed: EmbedBody }
    | {
        kind: 'media';
        fileType: MediaFileTypeValue;
        /** 平台自行下载的公网地址。与 data 二选一。 */
        url?: string;
        /** base64 内容。与 url 二选一。 */
        data?: string;
        /** fileType=FILE(4) 必填。 */
        fileName?: string;
        /** 本地文件路径：内核流式摘要 + 分片随机读取，不整体加载。 */
        localPath?: string;
        /** 可选的说明文字，与媒体一起下发。 */
        text?: string;
      }
    | { kind: 'typing'; inputSecond?: number }
  );

export type OutboundKind = OutboundMessage['kind'];

export type OutboundParseResult =
  | { ok: true; message: OutboundMessage }
  | { ok: false; reason: string; detail: string };

/**
 * 校验插件交上来的发送意图。
 *
 * 只做浅层校验：形状不对、必填缺失、fileType 不在枚举内，这些重试一万次也不会
 * 变对，所以在这里就挡掉并给出稳定 reason。至于 ark / embed / keyboard 的深层
 * 字段，交给平台判 —— 内核不装懂它的 schema。
 */
export function parseOutboundMessage(value: unknown): OutboundParseResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail('invalid_body', 'body 必须是对象');
  }
  const record = value as Record<string, unknown>;

  const modifiers: OutboundModifiers = {};
  const keyboard = record.keyboard;
  if (keyboard !== undefined) {
    if (keyboard === null || typeof keyboard !== 'object' || Array.isArray(keyboard)) {
      return fail('invalid_body', 'keyboard 必须是对象');
    }
    modifiers.keyboard = keyboard as Keyboard;
  }
  const referenceMessageId = record.referenceMessageId;
  if (referenceMessageId !== undefined) {
    if (typeof referenceMessageId !== 'string' || referenceMessageId.trim() === '') {
      return fail('invalid_body', 'referenceMessageId 必须是非空字符串');
    }
    modifiers.referenceMessageId = referenceMessageId.trim();
  }

  const kind = record.kind;
  switch (kind) {
    case 'text':
    case 'markdown': {
      const field = kind === 'text' ? 'text' : 'markdown';
      const text = record[field];
      if (typeof text !== 'string' || text.trim() === '') {
        return fail('empty_message', `${field} 必须是非空字符串`);
      }
      return ok({ ...modifiers, kind, [field]: text } as OutboundMessage);
    }
    case 'ark': {
      const parsed = parseArk(record.ark);
      if (!parsed.ok) return fail('invalid_ark', parsed.detail);
      return ok({ ...modifiers, kind: 'ark', ark: parsed.value });
    }
    case 'embed': {
      const parsed = parseEmbed(record.embed);
      if (!parsed.ok) return fail('invalid_embed', parsed.detail);
      return ok({ ...modifiers, kind: 'embed', embed: parsed.value });
    }
    case 'media': {
      const fileType = record.fileType;
      if (!isMediaFileType(fileType)) {
        return fail('invalid_media', 'fileType 必须是 1（图片）/ 2（视频）/ 3（语音）/ 4（文件）');
      }
      const fileName = record.fileName;
      if (fileType === MediaFileType.FILE && (typeof fileName !== 'string' || fileName.trim() === '')) {
        return fail('invalid_media', 'fileType=4（文件）必须提供 fileName');
      }

      // 三个来源各对应一条确定的路径（见 core/media.ts），所以只能给一个：
      // url 交给平台下载，data 与 localPath 走本地模式。
      const data = typeof record.data === 'string' && record.data !== '' ? record.data : undefined;
      const localPath =
        typeof record.localPath === 'string' && record.localPath !== ''
          ? record.localPath
          : undefined;
      const url = typeof record.url === 'string' && record.url !== '' ? record.url : undefined;
      const given = [data, localPath, url].filter((value) => value !== undefined).length;
      if (given === 0) {
        return fail('invalid_media', 'media 必须提供 data / localPath / url 之一');
      }
      if (given > 1) {
        return fail('invalid_media', 'data / localPath / url 只能给一个');
      }

      const message: OutboundMessage = { ...modifiers, kind: 'media', fileType };
      if (data !== undefined) message.data = data;
      if (localPath !== undefined) message.localPath = localPath;
      if (url !== undefined) message.url = url;
      if (typeof fileName === 'string' && fileName.trim() !== '') message.fileName = fileName.trim();
      if (typeof record.text === 'string' && record.text !== '') message.text = record.text;
      return ok(message);
    }
    case 'typing': {
      const message: OutboundMessage = { ...modifiers, kind: 'typing' };
      const inputSecond = record.inputSecond;
      if (typeof inputSecond === 'number' && Number.isFinite(inputSecond) && inputSecond > 0) {
        message.inputSecond = inputSecond;
      }
      return ok(message);
    }
    default:
      return fail('invalid_kind', `未知的 kind=${String(kind)}`);
  }
}

/**
 * 这条消息是否需要 message.media 能力。
 *
 * 单独一档能力而不是并进 message.reply：media 会让内核去下载插件给的任意 URL、
 * 并向第三方预签名地址发 PUT，这是实实在在的新出网行为，值得单独授权。
 */
export function usesMediaCapability(message: OutboundMessage): boolean {
  return message.kind === 'media';
}

/** 给人看的简述，只进日志。绝不放正文，避免把用户内容写进日志。 */
export function describeOutbound(message: OutboundMessage): string {
  const extras: string[] = [];
  if (message.keyboard !== undefined) extras.push('keyboard');
  if (message.referenceMessageId !== undefined) extras.push('reference');
  const suffix = extras.length === 0 ? '' : `+${extras.join('+')}`;
  switch (message.kind) {
    case 'text':
      return `text(${message.text.length}字)${suffix}`;
    case 'markdown':
      return `markdown(${message.markdown.length}字)${suffix}`;
    case 'media':
      return `media(fileType=${message.fileType},${message.url !== undefined ? 'url' : 'data'})${suffix}`;
    case 'typing':
      return `typing(${message.inputSecond ?? 60}s)`;
    default:
      return `${message.kind}${suffix}`;
  }
}

type Parsed<T> = { ok: true; value: T } | { ok: false; detail: string };

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * ARK 的完整模型校验：`template_id` + `kv[]` → `{ key, value?, obj[] }` → `{ obj_kv[] }`。
 *
 * 形状是确定的就按确定的形状校验，不再用索引签名假装「支持完整 ARK」。平台将来新增
 * 字段时，走 `request` 逃生舱或按真实协议扩这个类型，而不是先把类型松开。
 */
function parseArk(value: unknown): Parsed<ArkBody> {
  const record = readObject(value);
  if (record === null) return { ok: false, detail: 'ark 必须是对象' };

  const templateId = record.template_id;
  if (typeof templateId !== 'number' || !Number.isInteger(templateId) || templateId <= 0) {
    return { ok: false, detail: 'ark.template_id 必须是正整数' };
  }
  const ark: ArkBody = { template_id: templateId };
  if (record.kv === undefined) return { ok: true, value: ark };
  if (!Array.isArray(record.kv)) return { ok: false, detail: 'ark.kv 必须是数组' };

  const kv: ArkKV[] = [];
  for (const item of record.kv) {
    const entry = readObject(item);
    if (entry === null || typeof entry.key !== 'string' || entry.key === '') {
      return { ok: false, detail: 'ark.kv[] 需要非空的 key' };
    }
    const variable: ArkKV = { key: entry.key };

    if (entry.value !== undefined) {
      if (typeof entry.value !== 'string') {
        return { ok: false, detail: 'ark.kv[].value 必须是字符串' };
      }
      variable.value = entry.value;
    }

    if (entry.obj !== undefined) {
      if (!Array.isArray(entry.obj)) return { ok: false, detail: 'ark.kv[].obj 必须是数组' };
      const objs: ArkObj[] = [];
      for (const objItem of entry.obj) {
        const objRecord = readObject(objItem);
        if (objRecord === null || !Array.isArray(objRecord.obj_kv)) {
          return { ok: false, detail: 'ark.kv[].obj[] 需要 obj_kv 数组' };
        }
        const objKv: ArkObjKV[] = [];
        for (const pair of objRecord.obj_kv) {
          const pairRecord = readObject(pair);
          if (
            pairRecord === null ||
            typeof pairRecord.key !== 'string' ||
            typeof pairRecord.value !== 'string'
          ) {
            return { ok: false, detail: 'obj_kv[] 需要字符串的 key 与 value' };
          }
          objKv.push({ key: pairRecord.key, value: pairRecord.value });
        }
        objs.push({ obj_kv: objKv });
      }
      variable.obj = objs;
    }

    kv.push(variable);
  }
  ark.kv = kv;
  return { ok: true, value: ark };
}

/** Embed 的完整模型校验。字段少，但形状确定，不需要索引签名。 */
function parseEmbed(value: unknown): Parsed<EmbedBody> {
  const record = readObject(value);
  if (record === null) return { ok: false, detail: 'embed 必须是对象' };

  const embed: EmbedBody = {};
  if (record.title !== undefined) {
    if (typeof record.title !== 'string') return { ok: false, detail: 'embed.title 必须是字符串' };
    embed.title = record.title;
  }
  if (record.prompt !== undefined) {
    if (typeof record.prompt !== 'string') return { ok: false, detail: 'embed.prompt 必须是字符串' };
    embed.prompt = record.prompt;
  }
  if (record.thumbnail !== undefined) {
    const thumbnail = readObject(record.thumbnail);
    if (thumbnail === null || typeof thumbnail.url !== 'string' || thumbnail.url === '') {
      return { ok: false, detail: 'embed.thumbnail 需要非空的 url' };
    }
    embed.thumbnail = { url: thumbnail.url };
  }
  if (record.fields !== undefined) {
    if (!Array.isArray(record.fields)) return { ok: false, detail: 'embed.fields 必须是数组' };
    const fields: EmbedField[] = [];
    for (const item of record.fields) {
      const field = readObject(item);
      if (field === null || typeof field.name !== 'string' || field.name === '') {
        return { ok: false, detail: 'embed.fields[] 需要非空的 name' };
      }
      fields.push({ name: field.name });
    }
    embed.fields = fields;
  }
  return { ok: true, value: embed };
}

function isMediaFileType(value: unknown): value is MediaFileTypeValue {
  return (
    value === MediaFileType.IMAGE ||
    value === MediaFileType.VIDEO ||
    value === MediaFileType.VOICE ||
    value === MediaFileType.FILE
  );
}

function ok(message: OutboundMessage): OutboundParseResult {
  return { ok: true, message };
}

function fail(reason: string, detail: string): OutboundParseResult {
  return { ok: false, reason, detail };
}

/**
 * 有些能力只存在于某一种会话。
 *
 * 在发送之前就挡掉，而不是等平台回一个没有语义的错误码 —— 调用方能拿到稳定 reason。
 */
export function outboundScopeProblem(message: OutboundMessage, scope: MessageScope): string | null {
  if (message.kind === 'typing' && scope !== 'c2c') {
    return '输入状态（kind=typing）只有单聊支持，群聊没有这个能力';
  }
  return null;
}

/** sendOutbound 用到的发送能力。QQApiClient 结构上满足它。 */
export interface OutboundSender {
  sendGroupMessage(groupOpenid: string, body: SendMessageBody): Promise<SendResult>;
  sendC2CMessage(userOpenid: string, body: SendMessageBody): Promise<SendResult>;
  uploadGroupMedia(
    params: { groupOpenid: string } & UploadMediaParams,
  ): Promise<UploadMediaResponse>;
  uploadC2CMedia(params: { userOpenid: string } & UploadMediaParams): Promise<UploadMediaResponse>;
}

/**
 * 把发送意图翻译成平台请求并真正发出去。
 *
 * 这是整个出站协议的唯一落点：msg_type、media.file_info、keyboard、
 * message_reference 的拼装只在这里出现一次，其余各层都只谈 OutboundMessage。
 * 富媒体的「上传 → file_info → msg_type=7」也在这里闭环，插件看不到中间态。
 */
export async function sendOutbound(
  sender: OutboundSender,
  scope: MessageScope,
  targetId: string,
  message: OutboundMessage,
  target: SendTargetParams = {},
): Promise<SendResult> {
  const body = await buildBody(sender, scope, targetId, message);
  body.msg_seq = target.msgSeq ?? 1;
  if (target.msgId !== undefined) body.msg_id = target.msgId;

  return scope === 'group'
    ? sender.sendGroupMessage(targetId, body)
    : sender.sendC2CMessage(targetId, body);
}

async function buildBody(
  sender: OutboundSender,
  scope: MessageScope,
  targetId: string,
  message: OutboundMessage,
): Promise<SendMessageBody> {
  const body: SendMessageBody = {};

  switch (message.kind) {
    case 'text':
      body.msg_type = 0;
      body.content = message.text;
      break;
    case 'markdown':
      body.msg_type = 2;
      body.markdown = { content: message.markdown };
      break;
    case 'ark':
      body.msg_type = 3;
      body.ark = message.ark;
      break;
    case 'embed':
      body.msg_type = 4;
      body.embed = message.embed;
      break;
    case 'typing':
      // 6 是输入状态，不是媒体。只有单聊能发，调用方已用 outboundScopeProblem 挡过。
      body.msg_type = 6;
      body.input_notify = { input_type: 1, input_second: message.inputSecond ?? 60 };
      break;
    case 'media': {
      const source: UploadMediaParams = { fileType: message.fileType };
      if (message.data !== undefined) source.data = message.data;
      if (message.localPath !== undefined) source.localPath = message.localPath;
      if (message.url !== undefined) source.url = message.url;
      if (message.fileName !== undefined) source.fileName = message.fileName;

      const uploaded =
        scope === 'group'
          ? await sender.uploadGroupMedia({ groupOpenid: targetId, ...source })
          : await sender.uploadC2CMedia({ userOpenid: targetId, ...source });

      body.msg_type = 7;
      body.media = { file_info: uploaded.file_info };
      if (message.text !== undefined) body.content = message.text;
      break;
    }
    default:
      // 判别联合已穷尽；真走到这里说明上面漏了分支，宁可报错也不要静默发空消息。
      throw new Error(`未处理的发送意图：${String((message as { kind?: unknown }).kind)}`);
  }

  // 键盘与引用回复不是独立接口，只是同一份 body 上的字段，可与任意消息类型共存。
  if (message.keyboard !== undefined) body.keyboard = message.keyboard;
  if (message.referenceMessageId !== undefined) {
    body.message_reference = { message_id: message.referenceMessageId };
  }
  return body;
}
