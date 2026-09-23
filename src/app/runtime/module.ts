/**
 * App Module 的定义与上下文。
 *
 * App Module 不是 ICY Plugin：它是 App Runtime 进程内的 TypeScript 模块，共享
 * Service / Event / Pipeline，不走 IPC，也没有独立进程。
 *
 * 上下文刻意做小：模块拿不到 Application、ModuleManager、依赖图，也拿不到别的
 * 模块的上下文。它只能通过 ServiceRegistry 主动调用、通过 EventBus / Pipeline
 * 被动协作 —— Runtime 内部实现不外泄。
 */

import type { Logger } from './logger.js';
import type { ServiceReader, ServiceToken } from './services.js';

export type MaybePromise<T> = T | Promise<T>;

/**
 * 可释放资源。EventBus.on / MessagePipeline.use 都返回它。
 *
 * dispose 允许返回 Promise：真实资源（定时器、连接）的释放可能是异步的，
 * Runtime 会 await 它。同步实现（返回 void）同样满足这个签名。
 */
export interface Disposable {
  dispose(): MaybePromise<void>;
}

/** 模块名允许的字符集，与插件 manifest 的规则保持一致。 */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class ModuleDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModuleDefinitionError';
  }
}

export interface ModuleInfo {
  readonly name: string;
  readonly version: string;
}

/**
 * 模块的资源归属。
 *
 * EventBus 与 MessagePipeline 都接它：owner 用于日志与失败归因，signal 用于在模块
 * 停止时自动摘掉该模块注册的全部监听 —— 模块不写 dispose 也不会残留。
 */
export interface ModuleResources {
  readonly owner: string;
  readonly signal: AbortSignal;
}

export interface ModuleContext<C = unknown> {
  readonly module: ModuleInfo;
  readonly config: Readonly<C>;
  readonly services: ServiceReader;
  readonly logger: Logger;
  readonly signal: AbortSignal;
  /** 传给 EventBus / MessagePipeline 的归属信息，等价于 { owner: module.name, signal }。 */
  readonly resources: ModuleResources;
  /** 登记本模块拥有的资源；模块停止时按登记逆序释放。 */
  onDispose(resource: Disposable | (() => MaybePromise<void>)): Disposable;
}

/** setup 阶段额外拿到 provide：服务注册只发生在 setup。 */
export interface ModuleSetupContext<C = unknown> extends ModuleContext<C> {
  provide<T>(token: ServiceToken<T>, service: T): void;
}

/**
 * 模块定义。
 *
 * requires 表达「这些模块必须存在」；optional 表达「存在就用，不存在也不影响启动」。
 * v0 不做 semver 求解：这里只有模块名，没有版本区间。
 */
export interface ModuleDefinition<C = unknown> {
  name: string;
  version: string;
  requires?: readonly string[];
  optional?: readonly string[];
  setup(ctx: ModuleSetupContext<C>): MaybePromise<void>;
  start?(ctx: ModuleContext<C>): MaybePromise<void>;
  stop?(ctx: ModuleContext<C>): MaybePromise<void>;
}

/**
 * 模块生命周期状态。
 *
 * DISCOVERED/LOADED 由 loader 与 Application.add 决定；STOPPING 只在 stop/回滚的
 * 那一瞬间存在，用来让「正在停」与「已停」可区分 —— 否则 stop() 失败之后模块会永远
 * 停在 started 上，下一次 stop() 又会重跑一遍 stop 钩子。
 */
export type ModuleStatus = 'loaded' | 'setup' | 'started' | 'stopping' | 'stopped' | 'failed';

/**
 * 校验一个「来自外部」的模块对象。
 *
 * loader 的动态 import 结果与纯 JS 模块（例如 modules/ 下的 .js）都是 unknown，
 * 类型系统在这里帮不上忙 — 但形状校验必须和 defineModule 完全一致，
 * 否则同一个模块「走 TS 声明」与「走配置加载」会得到两套不同的接受标准。
 * 因此只保留这一份实现，defineModule 复用同一函数。
 */
export function readModuleDefinition(value: unknown, source: string): ModuleDefinition<unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ModuleDefinitionError(`${source} 导出的 module 必须是对象`);
  }
  const record = value as Record<string, unknown>;

  const name = record.name;
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    throw new ModuleDefinitionError(
      `${source} 的 module 名不合法：${JSON.stringify(name)}（只能由字母、数字、_ - . 组成）`,
    );
  }
  if (typeof record.version !== 'string' || record.version.trim() === '') {
    throw new ModuleDefinitionError(`module "${name}" 缺少非空 version（来自 ${source}）`);
  }
  if (typeof record.setup !== 'function') {
    throw new ModuleDefinitionError(`module "${name}" 必须提供 setup()（来自 ${source}）`);
  }
  checkNames(name, 'requires', record.requires);
  checkNames(name, 'optional', record.optional);

  // 形状到这里已经确定。config 的内容归模块自己解释：Runtime 只传递，不校验 schema。
  return value as unknown as ModuleDefinition<unknown>;
}

/**
 * 声明一个模块。
 *
 * 只做形状校验与类型推导，不注册任何东西 —— 注册发生在 Application.add()，
 * 生命周期发生在 start() / stop()。
 */
export function defineModule<C = unknown>(definition: ModuleDefinition<C>): ModuleDefinition<C> {
  return readModuleDefinition(definition, 'defineModule') as ModuleDefinition<C>;
}

function checkNames(moduleName: string, field: string, value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new ModuleDefinitionError(`module "${moduleName}" 的 ${field} 必须是字符串数组`);
  }
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new ModuleDefinitionError(
        `module "${moduleName}" 的 ${field} 里必须都是非空字符串`,
      );
    }
  }
}