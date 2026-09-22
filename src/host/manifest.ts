/**
 * plugin.json 的解析、校验与 intents 聚合。
 *
 * 两条硬约束（DESIGN.md §6.1）：
 *
 * 1. intents 必须声明式。它是连接级参数，Identify 时一次性打包；运行中加 intents
 *    只能靠重连，所以内核必须先把所有 manifest 扫完、聚合完，再建连。
 * 2. 传了无权限的 intents，Identify 之后服务端会直接关连接（关闭码 4014）。
 *    因此聚合结果里凡是不在默认白名单内的 intent 都要在启动阶段报出来，
 *    让人先去平台申请，而不是连上再炸。
 *
 * 校验失败一律抛 ManifestError，不做「跳过这个插件继续跑」的静默降级：
 * 一个写错 intent 的插件会让整条连接连不上，静默跳过只会让人更难定位。
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import {
  DEFAULT_ALLOWED_INTENTS,
  IntentBit,
  eventsForIntents,
  type IntentName,
} from '../core/events.js';
import { DEFAULT_CONCURRENCY, DEFAULT_QUEUE_LIMIT } from '../core/dispatch.js';
import { CAPABILITIES, type Capability } from './types.js';

export const MANIFEST_FILE = 'plugin.json';

/** 插件名允许的字符集，避免它在日志与目录里制造歧义。 */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const DEFAULT_PRIORITY = 100;
// concurrency / queueLimit 的默认值只在 core/dispatch.ts 定义一份。两处各写一个默认值
// 曾经让 Dispatcher 的「默认 8」被这里的 1 静默覆盖，真实插件全部退化成串行 ——
// 这类分歧必须从结构上消灭，而不是靠人记得同步。

/** manifest 有问题，或者所在目录读不出来。 */
export class ManifestError extends Error {
  readonly file: string;

  constructor(file: string, detail: string) {
    super(`插件 manifest 有问题 ${file}：${detail}`);
    this.name = 'ManifestError';
    this.file = file;
  }
}

export interface PluginManifest {
  name: string;
  version: string;
  /** 相对插件目录的入口文件，例如 index.js。 */
  entry: string;
  intents: IntentName[];
  /** 订阅的事件名，即 payload 的 t。只有声明了才会收到投递。 */
  events: string[];
  capabilities: Capability[];
  /** 插件私有配置，来自 plugin.json 的 config 字段。内核配置永不下发。 */
  config: Record<string, unknown>;
  /** 数值小者先被调用，默认 100。 */
  priority: number;
  /** 单插件事件并发度，默认 1（保序）。 */
  concurrency: number;
  /** 单插件队列上限，满了丢最旧，默认 64。 */
  queueLimit: number;
  /** 插件目录的绝对路径，由 loader 填入。 */
  dir: string;
  /** manifest 文件路径，日志用。 */
  file: string;
}

/** 读取并解析一个插件目录下的 plugin.json。 */
export async function loadManifest(dir: string): Promise<PluginManifest> {
  const file = join(dir, MANIFEST_FILE);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (cause) {
    throw new ManifestError(file, `读取失败：${describe(cause)}`);
  }

  let raw: unknown;
  try {
    // 带 BOM 的 JSON.parse 会抛，先剥掉 BOM。
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (cause) {
    throw new ManifestError(file, `不是合法 JSON：${describe(cause)}`);
  }

  return parseManifest(raw, dir);
}

/** 校验一份已经解析成对象的 manifest。 */
export function parseManifest(raw: unknown, dir: string): PluginManifest {
  const file = join(dir, MANIFEST_FILE);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ManifestError(file, '顶层必须是一个 JSON 对象');
  }
  const record = raw as Record<string, unknown>;

  const name = requireString(record, 'name', file);
  if (!NAME_PATTERN.test(name)) {
    throw new ManifestError(file, `name 只能由字母、数字、_ - . 组成，当前为 ${JSON.stringify(name)}`);
  }

  const version = requireString(record, 'version', file);
  const entry = requireString(record, 'entry', file);
  const entryPath = resolve(dir, entry);
  if (!isInside(dir, entryPath)) {
    throw new ManifestError(file, `entry 必须位于插件目录内，当前为 ${entry}`);
  }

  const intents = readIntentNames(record, file);
  const events = readStringArray(record, 'events', file);
  const known = eventsForIntents(intents);
  for (const event of events) {
    if (!known.has(event)) {
      throw new ManifestError(
        file,
        `events 里的 ${event} 不在已声明 intents 覆盖范围内，这个插件永远收不到它`,
      );
    }
  }

  return {
    name,
    version,
    entry,
    intents,
    events,
    capabilities: readCapabilities(record, file),
    config: readConfig(record, file),
    priority: readPositiveInt(record, 'priority', file, DEFAULT_PRIORITY),
    concurrency: readPositiveInt(record, 'concurrency', file, DEFAULT_CONCURRENCY),
    queueLimit: readPositiveInt(record, 'queueLimit', file, DEFAULT_QUEUE_LIMIT),
    dir: resolve(dir),
    file,
  };
}

/** 入口文件的绝对路径。supervisor 只允许执行它，不接受插件自报路径。 */
export function manifestEntryPath(manifest: PluginManifest): string {
  return resolve(manifest.dir, manifest.entry);
}

/**
 * 聚合全部 manifest 的 intents。
 *
 * 输出按位移升序排列，这样日志里的 intents 列表与人肉比对文档时的顺序一致。
 */
export function aggregateIntents(manifests: readonly PluginManifest[]): IntentName[] {
  const set = new Set<IntentName>();
  for (const manifest of manifests) {
    for (const intent of manifest.intents) set.add(intent);
  }
  return [...set].sort((a, b) => IntentBit[a] - IntentBit[b]);
}

/** 需要先去开放平台申请权限的 intents。启动阶段就该报出来。 */
export function intentsNeedingApproval(intents: readonly IntentName[]): IntentName[] {
  return intents.filter((intent) => !DEFAULT_ALLOWED_INTENTS.includes(intent));
}

function requireString(record: Record<string, unknown>, key: string, file: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ManifestError(file, `${key} 必须是非空字符串`);
  }
  return value.trim();
}

function readStringArray(record: Record<string, unknown>, key: string, file: string): string[] {
  const value = record[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ManifestError(file, `${key} 必须是字符串数组`);
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new ManifestError(file, `${key} 里必须都是非空字符串`);
    }
    out.push(item.trim());
  }
  return out;
}

function readPositiveInt(
  record: Record<string, unknown>,
  key: string,
  file: string,
  fallback: number,
): number {
  const value = record[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ManifestError(file, `${key} 必须是正整数`);
  }
  return value;
}

function readIntentNames(record: Record<string, unknown>, file: string): IntentName[] {
  const out: IntentName[] = [];
  for (const name of readStringArray(record, 'intents', file)) {
    if (!(name in IntentBit)) {
      throw new ManifestError(file, `未知 intent：${name}（可用值见 core/events.ts 的 IntentBit）`);
    }
    const intent = name as IntentName;
    if (!out.includes(intent)) out.push(intent);
  }
  return out;
}

/**
 * 读取插件私有配置。
 *
 * 内核只校验「是 JSON 对象」这一层，不解释内容 —— 配置的 schema 归插件自己管，
 * 内核替它校验只会把插件契约越做越厚。缺省给空对象而不是 undefined，
 * 免得每个插件都写一遍判空。
 */
function readConfig(record: Record<string, unknown>, file: string): Record<string, unknown> {
  const value = record.config;
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ManifestError(file, 'config 必须是 JSON 对象');
  }
  return value as Record<string, unknown>;
}

function readCapabilities(record: Record<string, unknown>, file: string): Capability[] {
  const out: Capability[] = [];
  for (const name of readStringArray(record, 'capabilities', file)) {
    if (!(CAPABILITIES as readonly string[]).includes(name)) {
      throw new ManifestError(file, `未知能力：${name}（可用值：${CAPABILITIES.join(' / ')}）`);
    }
    const capability = name as Capability;
    if (!out.includes(capability)) out.push(capability);
  }
  return out;
}

/** 入口必须留在插件目录内：resolve 之后前缀比对，堵住 ../ 与绝对路径。 */
function isInside(dir: string, target: string): boolean {
  const base = resolve(dir);
  const rel = relative(base, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
