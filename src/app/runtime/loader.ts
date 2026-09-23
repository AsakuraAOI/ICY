/**
 * ModuleManager：模块注册、生命周期状态与资源归属。
 *
 * 它是 Runtime 的内部账本，模块拿不到它。三件事必须记在这里：
 *
 * 1. **注册与重名**：模块名全局唯一。重名不能「后者覆盖前者」—— 覆盖之后
 *    依赖图、ServiceRegistry 的 owner、日志里的模块名全都会指向错的那个模块，
 *    而且没有任何地方会报错。所以在注册点直接拒绝。
 * 2. **状态**：DISCOVERED/LOADED → setup → started → stopped/failed。对外只暴露
 *    简化值，但内部必须清楚，否则回滚时不知道该停谁、该放谁。
 * 3. **资源归属**：模块在 setup 里注册的 event listener / middleware 都挂在它的
 *    AbortController 上；显式登记的资源（ctx.onDispose）存在 disposables 里。
 *    模块停止时这里统一释放，模块自己不写清理代码也不会残留。
 *
 * v0 没有动态卸载：模块一旦注册就不再移除，Application 关停时整体销毁。
 */

import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { DependencyNode } from './dependency.js';
import { describeError } from './errors.js';
import {
  readModuleDefinition,
  type Disposable,
  type ModuleDefinition,
  type ModuleStatus,
} from './module.js';

/**
 * 按路径加载一个 App Module。
 *
 * 路径相对于 cwd —— 插件进程的 cwd 就是它自己的 manifest.dir（Supervisor 的 spawn
 * 约定），所以配置里写 `../../modules/counter/index.ts便是` 这样相对插件目录的路径，
 * 不需要把绝对路径钉进 plugin.json。
 *
 * 返回值必须是**模块定义**：`export default defineModule({...})`。
 * 这里只负责加载与形状校验，注册与生命周期交给 Application。
 */
export async function loadModuleFromPath(
  spec: string,
  cwd: string = process.cwd(),
): Promise<ModuleDefinition<unknown>> {
  const target = isAbsolute(spec) ? spec : resolve(cwd, spec);
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(pathToFileURL(target).href)) as Record<string, unknown>;
  } catch (cause) {
    throw new ModuleManagerError(spec, `加载模块失败：${spec} — ${describeError(cause)}`);
  }

  const candidate = loaded.default ?? loaded.module;
  return readModuleDefinition(candidate, spec);
}

/** 注册期错误（重名、加载失败等）。 */
export class ModuleManagerError extends Error {
  readonly moduleName: string;

  constructor(moduleName: string, message: string) {
    super(message);
    this.name = 'ModuleManagerError';
    this.moduleName = moduleName;
  }
}

/** Runtime 内部持有的模块记录。 */
export interface ModuleRecord {
  readonly name: string;
  readonly version: string;
  readonly definition: ModuleDefinition<unknown>;
  /** 模块私有配置。Runtime 只搬运不解释 schema，所以在装配时就冻结。 */
  readonly config: unknown;
  status: ModuleStatus;
  /** 模块停止时 abort：挂在它上面的 EventBus listener / pipeline middleware 自动摘掉。 */
  readonly controller: AbortController;
  /** 显式登记的资源，释放时按登记逆序。 */
  readonly disposables: Disposable[];
  /** 「实际存在」的 optional 依赖，依赖图排完后填。 */
  optionalDependencies: readonly string[];
}

export class ModuleManager {
  readonly #records = new Map<string, ModuleRecord>();
  /** 注册顺序。依赖排序结果不依赖它，但它是稳定输出的依据（与 Map 迭代顺序解耦）。 */
  readonly #order: string[] = [];

  add(definition: ModuleDefinition<unknown>, config: unknown): ModuleRecord {
    if (this.#records.has(definition.name)) {
      throw new ModuleManagerError(
        definition.name,
        `模块名重复："${definition.name}" 被注册了两次（模块名必须全局唯一）`,
      );
    }

    const record: ModuleRecord = {
      name: definition.name,
      version: definition.version,
      definition,
      config,
      status: 'loaded',
      controller: new AbortController(),
      disposables: [],
      optionalDependencies: [],
    };
    this.#records.set(record.name, record);
    this.#order.push(record.name);
    return record;
  }

  get size(): number {
    return this.#records.size;
  }

  has(name: string): boolean {
    return this.#records.has(name);
  }

  get(name: string): ModuleRecord | undefined {
    return this.#records.get(name);
  }

  require(name: string): ModuleRecord {
    const record = this.#records.get(name);
    if (record === undefined) {
      throw new ModuleManagerError(name, `模块 ${name} 没有注册`);
    }
    return record;
  }

  /** 全部记录，按注册顺序。 */
  get all(): readonly ModuleRecord[] {
    return this.#order.map((name) => this.require(name));
  }

  /** 交给依赖图的节点。requires / optional 都来自模块声明，不做任何推断。 */
  nodes(): DependencyNode[] {
    return this.all.map((record) => ({
      name: record.name,
      requires: record.definition.requires ?? [],
      optional: record.definition.optional ?? [],
    }));
  }

  setOptional(name: string, dependencies: readonly string[]): void {
    this.require(name).optionalDependencies = dependencies;
  }

  /** 登记一个模块资源。函数形式会被包成 Disposable，返回值可用于提前释放。 */
  track(name: string, resource: Disposable | (() => Promise<void> | void)): Disposable {
    const record = this.require(name);
    const disposable: Disposable = typeof resource === 'function' ? { dispose: resource } : resource;
    record.disposables.push(disposable);
    return disposable;
  }

  /**
   * 释放一个模块的全部资源：先 abort（摘掉 listener / middleware），再逆序 dispose。
   *
   * 返回失败列表而不抛：调用方（回滚 / stop）要的是「继续清理其余的」，不是中断。
   * 重复调用是安全的 —— disposables 会被清空，controller 只 abort 一次。
   */
  async release(name: string): Promise<Error[]> {
    const record = this.get(name);
    if (record === undefined) return [];

    const failures: Error[] = [];
    if (!record.controller.signal.aborted) record.controller.abort();

    const pending = [...record.disposables].reverse();
    record.disposables.length = 0;
    for (const disposable of pending) {
      try {
        await disposable.dispose();
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return failures;
  }
}