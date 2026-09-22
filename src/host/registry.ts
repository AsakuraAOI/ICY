/**
 * 插件发现与能力索引。
 *
 * 发现阶段必须发生在建连之前：intents 是连接级参数，Identify 时一次性打包，
 * 运行中加不了（只能重连）。所以这里一次性把插件目录扫完、manifest 全部校验完，
 * 交给 main.ts 聚合 intents 后再去连 Gateway。
 *
 * 校验失败不静默跳过：一个写错 intent 的插件会让整条连接连不上（关闭码 4014），
 * 跳过它只会让问题更难定位。没有 plugin.json 的目录才跳过，因为插件的
 * node_modules、data 这类子目录本来就不该被当成插件。
 */

import { access, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { loadManifest, MANIFEST_FILE, type PluginManifest } from './manifest.js';
import type { Capability } from './types.js';

/** 插件根目录本身有问题（不存在、读不了、插件名重复）。 */
export class PluginDirError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PluginDirError';
  }
}

/** 扫一个插件根目录，返回全部通过校验的 manifest，按插件名排序。 */
export async function discoverPlugins(rootDir: string): Promise<PluginManifest[]> {
  const root = resolve(rootDir);

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (cause) {
    throw new PluginDirError(`插件目录读不出来：${root}`, { cause });
  }

  const manifests: PluginManifest[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (!(await exists(join(root, entry.name, MANIFEST_FILE)))) continue;
    manifests.push(await loadManifest(join(root, entry.name)));
  }

  manifests.sort((a, b) => a.name.localeCompare(b.name));

  const seen = new Set<string>();
  for (const manifest of manifests) {
    if (seen.has(manifest.name)) {
      throw new PluginDirError(`插件名重复：${manifest.name}（目录 ${manifest.dir}）`);
    }
    seen.add(manifest.name);
  }

  return manifests;
}

/**
 * 能力索引：按事件名查订阅者（已按 priority 升序），按插件名查能力。
 *
 * priority 排序决定 fanout 顺序，也就是「谁先拿到这条事件」。数值小者先，
 * 与 DESIGN.md §7.3 一致。
 */
export class PluginCatalog {
  readonly #manifests: readonly PluginManifest[];
  readonly #byName = new Map<string, PluginManifest>();
  readonly #byEvent = new Map<string, PluginManifest[]>();

  constructor(manifests: readonly PluginManifest[]) {
    this.#manifests = [...manifests].sort(
      (a, b) => a.priority - b.priority || a.name.localeCompare(b.name),
    );

    for (const manifest of this.#manifests) {
      this.#byName.set(manifest.name, manifest);
      for (const event of manifest.events) {
        const list = this.#byEvent.get(event);
        if (list === undefined) this.#byEvent.set(event, [manifest]);
        else list.push(manifest);
      }
    }
  }

  /** 全部插件，按 priority 升序。 */
  get all(): readonly PluginManifest[] {
    return this.#manifests;
  }

  get size(): number {
    return this.#manifests.length;
  }

  get(name: string): PluginManifest | undefined {
    return this.#byName.get(name);
  }

  /** 订阅某事件的插件，已按 priority 升序。 */
  subscribers(eventType: string): readonly PluginManifest[] {
    return this.#byEvent.get(eventType) ?? [];
  }

  /** 这个插件有没有声明该能力。没声明就调用，会被内核拒绝。 */
  can(name: string, capability: Capability): boolean {
    return this.#byName.get(name)?.capabilities.includes(capability) ?? false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}