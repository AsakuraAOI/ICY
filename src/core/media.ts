/**
 * 富媒体上传：把「一段内容」变成平台认得的 file_info。
 *
 * **两种上传模式是两条不同的协议，不能混为一谈：**
 *
 * 1. URL 模式（服务端拉取）
 *      POST /v2/{users|groups}/{id}/files  body { file_type, url, srv_send_msg: false }
 *    平台自己去下载那个公网地址。Bot 进程完全不碰文件内容 —— 不下载、不持有、也不算
 *    分片哈希。所以这条路径与「大文件分片」没有任何关系。
 *
 * 2. 本地模式（Bot 侧上传）
 *      POST .../upload_prepare      → upload_id + block_size + parts[{index, presigned_url}] + concurrency
 *      PUT  {presigned_url}         原始二进制，**不带 Authorization**（COS 预签名自带签名）
 *      POST .../upload_part_finish  { upload_id, part_index, block_size, md5 }
 *      POST .../files               { upload_id }   ← 没有独立的 /complete_upload
 *    整传还是分片由**本地内容大小**决定（官方 SDK 的边界是 5 MiB）。
 *
 * 本地模式又分两种来源，内存行为完全不同：
 * - base64 / Buffer：内容本来就在内存里，摘要直接算 —— 常驻内存是这类来源的固有性质。
 * - localPath：**流式扫描**一次算出 md5 / sha1 / md5_10m，每个分片再按 offset/length
 *   随机读取。全程不把整个文件读进内存 ——「为了算 hash 必须整个读进来」不成立。
 *
 * 分片的字节范围**只由协议给的 `part.index` 决定**：offset = (index - 1) * block_size。
 * 不按 parts 数组位置推断，也不靠排序 —— 服务器乱序返回也必须切对。
 * 并发度取 upload_prepare 的 concurrency，但本地上限 10：不无限信任服务端返回值。
 *
 * 错误分类：平台返回的错误原样抛 `ApiError`（保留 httpStatus / errCode / traceId），网络层
 * 失败抛 `TransportError`，只有本地取源 / 解码 / 摘要 / 编排失败才抛 `MediaUploadError`。
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat, type FileHandle } from 'node:fs/promises';

import {
  mediaUploadPath,
  uploadPartFinishPath,
  uploadPreparePath,
  type MessageScope,
} from './routes.js';
import type {
  UploadMediaBody,
  UploadMediaResponse,
  UploadPartFinishBody,
  UploadPrepareBody,
  UploadPrepareResponse,
} from '../types/qq.js';
import {
  ApiError,
  MediaUploadError,
  TransportError,
  type HttpMethod,
  type MediaUploadStage,
} from './errors.js';

/** 富媒体文件类型。同时用于上传的 file_type 与 msg_type=7 的语义。 */
export const MediaFileType = {
  IMAGE: 1,
  VIDEO: 2,
  VOICE: 3,
  FILE: 4,
} as const;
export type MediaFileTypeValue = (typeof MediaFileType)[keyof typeof MediaFileType];

/** 本地模式整传与分片的切换边界。官方 Node SDK 当前用 5 MiB。 */
export const CHUNKED_UPLOAD_THRESHOLD_BYTES = 5 * 1024 * 1024;

/** md5_10m 说的「前 10M」按 10 MiB 理解。 */
const MD5_10M_BYTES = 10 * 1024 * 1024;

/**
 * 分片并发度的本地安全上限。
 *
 * 服务端在 upload_prepare 里给建议并发度，但不能无限信任它 —— 一个错误的
 * concurrency 会让内核瞬间打出上百个并发 PUT。官方 SDK 同样夹在 10。
 */
export const MAX_CONCURRENT_PARTS = 10;

/**
 * 只需要「带鉴权的 POST」这一个能力。
 *
 * 按结构收口而不是 import QQApiClient，是为了让 media.ts 与 api.ts 之间
 * 不存在任何值级依赖：api.ts 依赖 media.ts 的上传函数，方向是单向的。
 */
export interface AuthenticatedTransport {
  request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T>;
}

/**
 * 上传入参。三个来源**只能给一个**，它们分别对应上面两条协议里的不同路径。
 */
export interface UploadMediaParams {
  fileType: MediaFileTypeValue;
  /** base64 内容。常驻内存。 */
  data?: string;
  /** 本地文件路径：流式摘要 + 分片随机读取，不整体加载。 */
  localPath?: string;
  /** 由平台自行下载的公网地址。给了它就完全不碰本地内容。 */
  url?: string;
  /** file_type=4（普通文件）必填。 */
  fileName?: string;
}

/** 本地内容源：摘要 + 按范围读取。两种来源实现同一接口，上传逻辑只认它。 */
interface LocalSource {
  readonly size: number;
  readonly digests: { md5: string; sha1: string; md5_10m: string };
  /** 读 [offset, offset+length)。 */
  read(offset: number, length: number): Promise<Buffer>;
  /** 整读。只用于小文件的整传。 */
  readAll(): Promise<Buffer>;
  close(): Promise<void>;
}

/**
 * 把分片 PUT 到 COS 预签名地址。
 *
 * 这里**绝不能**带 QQ Bot 的 Authorization —— 预签名地址自带签名与有效期，
 * 多带一个鉴权头会被 COS 判成签名不匹配。Content-Length 由 fetch 依据二进制
 * body 自动补上，不需要手写。
 */
async function putPart(presignedUrl: string, chunk: Buffer, timeoutMs: number): Promise<void> {
  let res: Response;
  try {
    res = await fetch(presignedUrl, {
      method: 'PUT',
      body: chunk,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    throw new TransportError('分片上传失败（PUT 预签名地址）：网络或超时', { cause });
  }
  if (!res.ok) {
    // COS 的拒绝不是 QQ REST 错误，归到本地上传链路 —— 至少能说出是哪一步塌的。
    throw new MediaUploadError(`分片上传被拒绝：HTTP ${res.status}`, 'part_upload');
  }
}

/** 内存源：内容本来就在内存里，摘要直接算。 */
function bufferSource(bytes: Buffer): LocalSource {
  return {
    size: bytes.byteLength,
    digests: {
      md5: hashHex('md5', bytes),
      sha1: hashHex('sha1', bytes),
      md5_10m: hashHex('md5', bytes.subarray(0, MD5_10M_BYTES)),
    },
    read: async (offset, length) => Buffer.from(bytes.subarray(offset, offset + length)),
    readAll: async () => bytes,
    close: async () => {},
  };
}

/**
 * 本地文件源：摘要走一次流式扫描，分片按 offset 随机读取。
 *
 * 全程不把整个文件读进内存 —— 这是它与内存源的关键差别，也是「分片必须整体读入」
 * 这个结论不成立的原因。
 */
async function pathSource(path: string): Promise<LocalSource> {
  let info;
  try {
    info = await stat(path);
  } catch (cause) {
    throw new MediaUploadError(`读取本地文件失败：${path}`, 'source', { cause });
  }
  if (!info.isFile()) throw new MediaUploadError(`不是普通文件：${path}`, 'source');
  if (info.size === 0) throw new MediaUploadError(`文件为空：${path}`, 'source');

  const size = info.size;
  const digests = await hashFile(path);

  let handle: FileHandle;
  try {
    handle = await open(path, 'r');
  } catch (cause) {
    throw new MediaUploadError(`打开本地文件失败：${path}`, 'source', { cause });
  }

  const read = async (offset: number, length: number): Promise<Buffer> => {
    const buffer = Buffer.allocUnsafe(length);
    try {
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
    } catch (cause) {
      rethrow(cause, `读取分片失败 offset=${offset} length=${length}`, 'part_upload');
    }
  };

  return {
    size,
    digests,
    read,
    readAll: () => read(0, size),
    close: async () => {
      try {
        await handle.close();
      } catch {
        // 可能已经关过，或进程正在退出。不值得让上传结果因此失败。
      }
    },
  };
}

/** 一次流式扫描算出整个文件与前 10 MiB 的摘要，不把文件读进内存。 */
function hashFile(path: string): Promise<{ md5: string; sha1: string; md5_10m: string }> {
  return new Promise((resolve, reject) => {
    const md5 = createHash('md5');
    const sha1 = createHash('sha1');
    const md5_10m = createHash('md5');
    let seen = 0;

    const stream = createReadStream(path);
    stream.on('data', (chunk) => {
      const bytes = chunk as Buffer;
      md5.update(bytes);
      sha1.update(bytes);
      if (seen < MD5_10M_BYTES) {
        md5_10m.update(bytes.subarray(0, MD5_10M_BYTES - seen));
      }
      seen += bytes.byteLength;
    });
    stream.on('error', (cause) => {
      reject(new MediaUploadError(`摘要本地文件失败：${path}`, 'hash', { cause }));
    });
    stream.on('end', () => {
      resolve({
        md5: md5.digest('hex'),
        sha1: sha1.digest('hex'),
        md5_10m: md5_10m.digest('hex'),
      });
    });
  });
}

function hashHex(algorithm: 'md5' | 'sha1', bytes: Uint8Array): string {
  return createHash(algorithm).update(bytes).digest('hex');
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * 只在「本地 / 编排」失败时补 stage。
 *
 * 平台错误（ApiError）与网络错误（TransportError）原样放行 —— 把 ApiError 包成
 * MediaUploadError 会让 window_expired / auth_failed 这类分类整个失效。
 */
function rethrow(cause: unknown, message: string, stage: MediaUploadStage): never {
  if (
    cause instanceof ApiError ||
    cause instanceof TransportError ||
    cause instanceof MediaUploadError
  ) {
    throw cause;
  }
  throw new MediaUploadError(message, stage, { cause });
}

/** 解 base64，容忍 data:image/png;base64, 这种前缀。 */
function decodeBase64(data: string): Buffer {
  const comma = data.startsWith('data:') ? data.indexOf(',') : -1;
  const payload = comma >= 0 ? data.slice(comma + 1) : data;
  const trimmed = payload.trim();
  if (trimmed === '') throw new MediaUploadError('上传内容为空', 'decode');
  const bytes = Buffer.from(trimmed, 'base64');
  if (bytes.byteLength === 0) {
    throw new MediaUploadError('上传内容不是合法的 base64', 'decode');
  }
  return bytes;
}

/**
 * 分片的字节范围。
 *
 * 依据是协议给的 `part.index`，**不是 parts 数组的位置**：官方实现明确用
 * `(index - 1) * block_size`。即使服务器把 parts 乱序返回，也必须切对。
 */
export function getPartRange(
  part: { index: number },
  blockSize: number,
  fileSize: number,
): { offset: number; length: number } {
  const offset = (part.index - 1) * blockSize;
  return { offset, length: Math.min(blockSize, fileSize - offset) };
}

/**
 * 上传前的协议防御校验。
 *
 * offset 完全依赖 `(index - 1) * block_size`，所以 index 一旦不合法（负数、重复、
 * 越界），就会静默上传错误的字节范围 —— 那比直接失败糟糕得多。这里宁可拒绝整个上传。
 *
 * 注意：**不要为了「保险」先 sort 再按数组位置切分**。排序只影响调度顺序，
 * 不该影响字节范围计算。
 */
export function validateParts(
  parts: unknown,
  blockSize: number,
  fileSize: number,
): asserts parts is { index: number; presigned_url: string }[] {
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new MediaUploadError('upload_prepare 响应没有任何 parts', 'prepare');
  }
  if (!Number.isInteger(blockSize) || blockSize <= 0) {
    throw new MediaUploadError(`upload_prepare 的 block_size 非法：${String(blockSize)}`, 'prepare');
  }

  const seen = new Set<number>();
  for (const raw of parts) {
    const part = readRecord(raw);
    if (part === null) throw new MediaUploadError('parts 里存在非对象条目', 'prepare');

    const index = part.index;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 1) {
      throw new MediaUploadError(`分片 index 必须是正整数，实际 ${String(index)}`, 'prepare');
    }
    if (seen.has(index)) {
      throw new MediaUploadError(`分片 index 重复：${index}`, 'prepare');
    }
    seen.add(index);

    if (typeof part.presigned_url !== 'string' || part.presigned_url === '') {
      throw new MediaUploadError(`分片 ${index} 缺少 presigned_url`, 'prepare');
    }
    if ((index - 1) * blockSize >= fileSize) {
      throw new MediaUploadError(
        `分片 ${index} 的 offset=${(index - 1) * blockSize} 超出文件大小 ${fileSize}`,
        'prepare',
      );
    }
  }

  // 缺片等于上传出一个截断的文件，而且平台未必会报错。必须在这里挡住。
  const expected = Math.ceil(fileSize / blockSize);
  const missing: number[] = [];
  for (let index = 1; index <= expected; index += 1) {
    if (!seen.has(index)) missing.push(index);
  }
  if (missing.length > 0) {
    throw new MediaUploadError(`分片不完整，缺少 index=${missing.join(',')}`, 'prepare');
  }
}

/**
 * 有上限的并发执行。
 *
 * 任一分片失败即停止派发新任务并向上抛第一个错误 —— 上传已经不可能成功了，
 * 继续打完剩下的分片只是浪费带宽。
 */
async function runWithConcurrency(
  tasks: readonly (() => Promise<void>)[],
  limit: number,
): Promise<void> {
  let next = 0;
  let failure: unknown = null;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (failure !== null) return;
      const index = next;
      next += 1;
      const task = tasks[index];
      if (task === undefined) return;
      try {
        await task();
      } catch (error) {
        if (failure === null) failure = error;
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  if (failure !== null) throw failure;
}

/**
 * 分片上传主链路。
 *
 * prepare → 逐片 PUT → 逐片 part_finish → 再用 /files { upload_id } 收口拿 file_info。
 * 没有独立的 /complete_upload 接口。
 */
async function uploadChunked(
  transport: AuthenticatedTransport,
  scope: MessageScope,
  targetId: string,
  fileType: MediaFileTypeValue,
  fileName: string,
  source: LocalSource,
  timeoutMs: number,
): Promise<UploadMediaResponse> {
  const prepareBody: UploadPrepareBody = {
    file_type: fileType,
    file_name: fileName === '' ? 'upload.bin' : fileName,
    file_size: source.size,
    md5: source.digests.md5,
    sha1: source.digests.sha1,
    md5_10m: source.digests.md5_10m,
  };

  const prepared = await transport.request<UploadPrepareResponse>(
    'POST',
    uploadPreparePath(scope, targetId),
    prepareBody,
  );
  if (typeof prepared?.upload_id !== 'string' || prepared.upload_id === '') {
    throw new MediaUploadError('upload_prepare 响应缺少 upload_id', 'prepare');
  }

  const blockSize = prepared.block_size;
  validateParts(prepared.parts, blockSize, source.size);

  // 服务端建议的并发度可以信，但要夹住上限：一个错误的 concurrency 会让内核瞬间
  // 打出上百个并发 PUT。官方 SDK 同样夹在 10。
  const suggested = prepared.concurrency;
  const concurrency = Math.min(
    typeof suggested === 'number' && Number.isFinite(suggested) && suggested >= 1
      ? Math.floor(suggested)
      : 1,
    MAX_CONCURRENT_PARTS,
  );

  const tasks = prepared.parts.map((part) => async () => {
    // 字节范围来自 part.index，与它在数组里的位置无关。
    const range = getPartRange(part, blockSize, source.size);
    const chunk = await source.read(range.offset, range.length);
    if (chunk.byteLength !== range.length) {
      throw new MediaUploadError(
        `分片读取长度不符：index=${part.index} 期望 ${range.length} 实际 ${chunk.byteLength}`,
        'part_upload',
      );
    }

    await putPart(part.presigned_url, chunk, timeoutMs);

    const finishBody: UploadPartFinishBody = {
      upload_id: prepared.upload_id,
      part_index: part.index,
      // 最后一片报实际上传长度，不照抄 prepare 给的固定 block_size。
      block_size: range.length,
      md5: hashHex('md5', chunk),
    };
    try {
      await transport.request<unknown>('POST', uploadPartFinishPath(scope, targetId), finishBody);
    } catch (cause) {
      rethrow(cause, `upload_part_finish 失败：index=${part.index}`, 'part_finish');
    }
  });

  await runWithConcurrency(tasks, concurrency);

  // 没有独立的 /complete_upload：重新 POST /files，body 换成 { upload_id }。
  const done = await transport.request<UploadMediaResponse>(
    'POST',
    mediaUploadPath(scope, targetId),
    { upload_id: prepared.upload_id },
  );
  if (typeof done?.file_info !== 'string' || done.file_info === '') {
    throw new MediaUploadError('分片上传完成后响应缺少 file_info', 'complete');
  }
  return done;
}

/**
 * 上传富媒体，返回 file_info。
 *
 * 三条来源各自对应一条确定路径，**不会互相退化**：
 * - `url`：交给平台自己下载，Bot 完全不碰内容（也因此不存在「本地分片」这回事）。
 * - `data` / `localPath`：本地模式，按内容大小决定整传还是分片。
 */
export async function uploadMedia(
  transport: AuthenticatedTransport,
  scope: MessageScope,
  targetId: string,
  params: UploadMediaParams,
  timeoutMs: number,
): Promise<UploadMediaResponse> {
  const fileType = params.fileType;
  const fileName = params.fileName?.trim() ?? '';
  if (fileType === MediaFileType.FILE && fileName === '') {
    throw new MediaUploadError('file_type=4（普通文件）必须提供 fileName', 'source');
  }

  const sources = [params.data, params.localPath, params.url].filter(
    (value) => value !== undefined,
  );
  if (sources.length > 1) {
    throw new MediaUploadError('data / localPath / url 只能给一个', 'source');
  }

  if (params.url !== undefined) {
    const url = params.url.trim();
    if (url === '') throw new MediaUploadError('url 不能为空', 'source');
    return uploadSimple(transport, scope, targetId, {
      file_type: fileType,
      url,
      srv_send_msg: false,
    });
  }

  let source: LocalSource;
  if (params.localPath !== undefined) {
    source = await pathSource(params.localPath);
  } else if (params.data !== undefined) {
    source = bufferSource(decodeBase64(params.data));
  } else {
    throw new MediaUploadError('上传富媒体必须提供 data / localPath / url 之一', 'source');
  }

  try {
    if (source.size >= CHUNKED_UPLOAD_THRESHOLD_BYTES) {
      return await uploadChunked(transport, scope, targetId, fileType, fileName, source, timeoutMs);
    }
    // 小文件整传：localPath 也读进来转 base64。小文件本来就不值得走分片。
    const bytes = await source.readAll();
    const body: UploadMediaBody = {
      file_type: fileType,
      file_data: bytes.toString('base64'),
      srv_send_msg: false,
    };
    if (fileName !== '') body.file_name = fileName;
    return await uploadSimple(transport, scope, targetId, body);
  } finally {
    await source.close();
  }
}

async function uploadSimple(
  transport: AuthenticatedTransport,
  scope: MessageScope,
  targetId: string,
  body: UploadMediaBody,
): Promise<UploadMediaResponse> {
  const res = await transport.request<UploadMediaResponse>(
    'POST',
    mediaUploadPath(scope, targetId),
    body,
  );
  if (typeof res?.file_info !== 'string' || res.file_info === '') {
    throw new MediaUploadError('上传响应缺少 file_info', 'complete');
  }
  return res;
}
