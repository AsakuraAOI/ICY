/**
 * Application：模块装配、生命周期与消息入口的所有者。
 *
 * 它是 App Runtime 的唯一「整个应用」概念，模块拿不到它。
 *
 * 生命周期顺序是有约束的（与 ICY 的插件模型同构，但层内是进程内调用）：
 *
 *   add/load → 校验依赖 → 拓扑排序 → setup（正序）→ 冻结 service → start（正序）
 *   停止：reverse(start 顺序) → 释放资源
 *
 * 两条硬规则：
 *
 * 1. **启动失败必须回滚**，不能留下「半启动运行」。start 阶段第 N 个模块失败时，
 *    前面 N-1 个已经跑完 start 的模块必须被停掉；setup 过但没 start 的模块也要把
 *    资源放掉。回滚过程中某个 stop 失败不中断其余清理 —— 继续停，最后聚合。
 * 2. **service 只在 setup 阶段注册**，setup 全部跑完即冻结。运行期新增/替换 service
 *    是静默的数据竞争，Registry 直接拒绝。
 *
 * dispatch 是消息的唯一入口：它只做一件事 —— 把消息交给 MessagePipeline，
 * 并且把结果原样返回。消息协议不在这一层重新设计。
 */

import { buildDependencyGraph } from './dependency.js';
import {
  ApplicationError,
  ApplicationStartError,
  ApplicationStopError,
  describeError,
  ModuleLifecycleError,
} from './errors.js';
import { loadModuleFromPath, ModuleManager, type ModuleRecord } from './loader.js';
import {
  type Disposable,
  type ModuleContext,
  type ModuleDefinition,
  type ModuleSetupContext,
  type ModuleStatus,
} from './module.js';
import { Messages, type MessageDispatch, type MessageResult } from './contracts.js';
import { childLogger, NOOP_LOGGER, type Logger } from './logger.js';
import { ServiceRegistry, type ServiceToken } from './services.js';

export type ApplicationState =
  | 'created'
  | 'starting'
  | 'started'
  | 'stopping'
  | 'stopped'
  | 'failed';

export interface ApplicationOptions {
  /** 模块日志落点。插件里接 host.log；脚本与测试里接 console。 */
  readonly logger?: Logger;
  /**
   * 模块路径解析基准。
   *
   * 默认 process.cwd()：插件进程的 cwd 就是它自己的目录（Supervisor 的 spawn 约定），
   * 所以 plugin.json 里写 `../../modules/counter/index.ts` 这种相对路径即可，
   * 不需要把绝对路径钉进 manifest。
   */
  readonly moduleBaseDir?: string;
}

/** 给诊断与测试看的模块状态快照。 */
export interface ModuleStatusView {
  readonly name: string;
  readonly version: string;
  readonly status: ModuleStatus;
  /** 实际存在的 optional 依赖（依赖图排完后填）。 */
  readonly optionalDependencies: readonly string[];
}

export class Application {
  readonly #manager = new ModuleManager();
  readonly #services = new ServiceRegistry();
  readonly #log: Logger;
  readonly #moduleBase: string;

  #state: ApplicationState = 'created';
  #order: readonly string[] = [];
  #started: string[] = [];

  constructor(options: ApplicationOptions = {}) {
    this.#log = options.logger ?? NOOP_LOGGER;
    this.#moduleBase = options.moduleBaseDir ?? process.cwd();
  }

  get state(): ApplicationState {
    return this.#state;
  }

  /** 依赖图算出的拓扑序。start 之前为 []。 */
  get dependencyOrder(): readonly string[] {
    return this.#order;
  }

  /** 模块状态快照。诊断与测试用；模块自己拿不到。 */
  get modules(): readonly ModuleStatusView[] {
    return this.#manager.all.map((record) => ({
      name: record.name,
      version: record.version,
      status: record.status,
      optionalDependencies: record.optionalDependencies,
    }));
  }

  /**
   * ServiceRegistry 本体。
   *
   * 暴露它是为了诊断与测试：模块侧只能拿到只读视图（由 #contextFor 提供），
   * 拿不到这个对象。所以这里泄不出模块权限。
   */
  get services(): ServiceRegistry {
    return this.#services;
  }

  /** 注册一个模块。只能在 start() 之前调用：v0 没有动态卸载。 */
  add(definition: ModuleDefinition<unknown>, config: unknown = {}): this {
    if (this.#state !== 'created') {
      throw new ApplicationError(
        `模块只能在 start() 之前注册；当前状态是 ${this.#state}（v0 不支持动态加载模块）`,
      );
    }

    const frozen = freezeConfig(config);
    const record = this.#manager.add(definition, frozen);
    this.#log.debug(`注册模块 ${record.name}@${record.version}`);
    return this;
  }

  /** 按路径加载一个模块并注册。路径相对插件进程 cwd（插件目录）。 */
  async load(spec: string, config: unknown = {}): Promise<this> {
    if (this.#state !== 'created') {
      throw new ApplicationError(
        `模块只能在 start() 之前加载；当前状态是 ${this.#state}（v0 不支持动态加载模块）`,
      );
    }

    const definition = await loadModuleFromPath(spec, this.#moduleBase);
    this.#log.info(`已加载模块 ${definition.name}@${definition.version}（${spec}）`);
    return this.add(definition, config);
  }

  /**
   * 启动。
   *
   * 与 DESIGN.md §6.1 的插件启动顺序同构：先校验依赖（失败就不启动任何东西），
   * 再按拓扑序 setup、冻结 service，最后按同一顺序 start。
   */
  async start(): Promise<void> {
    if (this.#state === 'started') {
      throw new ApplicationError('Application 已经启动，不要重复 start');
    }
    if (this.#state !== 'created') {
      throw new ApplicationError(`Application 当前状态是 ${this.#state}，不能启动`);
    }
    if (this.#manager.size === 0) {
      throw new ApplicationError('没有注册任何模块，Application 没有可启动的东西');
    }

    this.#state = 'starting';
    this.#log.info(`装配 ${this.#manager.size} 个 App Module，开始依赖校验`);

    // 1. 依赖校验 + 拓扑排序。missing / cycle 都必须在任何 setup 之前失败：
    //    一半模块已经 setup 完再发现有环，回滚面会大很多，且没有意义。
    let order: readonly string[];
    try {
      const graph = buildDependencyGraph(this.#manager.nodes());
      order = graph.order;
      for (const [name, dependencies] of graph.optionalDependencies) {
        this.#manager.setOptional(name, dependencies);
      }
    } catch (error) {
      this.#state = 'failed';
      throw error;
    }

    this.#order = order;
    this.#log.info(`依赖顺序：${order.join(' → ')}`);

    // 2. setup（正序）。setup 阶段唯一被允许修改 registry 的时机。
    const setupDone: string[] = [];
    for (const name of order) {
      const record = this.#manager.require(name);
      try {
        await record.definition.setup(this.#setupContextFor(record));
        record.status = 'setup';
        setupDone.push(name);
      } catch (cause) {
        const failure = new ModuleLifecycleError(name, 'setup', cause);
        // 失败的那个模块自己也要放掉：它在 setup 里可能已经注册了 listener / middleware，
        // 只是还没走到最后一行就抛了。只释放「成功的那些」会留下它的半截资源。
        const rollbackFailures = await this.#releaseModules([...setupDone, name]);
        this.#state = 'failed';
        this.#log.error(`setup 失败并已回滚：${failure.message}`);
        throw new ApplicationStartError(failure, rollbackFailures);
      }
    }

    // 3. 冻结 registry。此后 provide 一律拒绝 —— 运行期不静默覆盖 service。
    this.#services.freeze();
    this.#log.info(
      `setup 完成：${setupDone.length} 个模块，service ${this.#services.size} 个，开始 start`,
    );

    // 4. start（正序）。失败即回滚已启动的部分。
    const started: string[] = [];
    for (const name of order) {
      const record = this.#manager.require(name);
      try {
        await record.definition.start?.(this.#contextFor(record));
        record.status = 'started';
        started.push(name);
      } catch (cause) {
        const failure = new ModuleLifecycleError(name, 'start', cause);
        this.#log.error(`模块 ${name} 启动失败，开始回滚：${failure.message}`);
        const rollbackFailures = await this.#rollback(started);
        this.#state = 'failed';
        throw new ApplicationStartError(failure, rollbackFailures);
      }
    }

    this.#started = started;
    this.#state = 'started';
    this.#log.info(`Application 已启动：${started.join(' → ')}`);
  }

  /**
   * 消息入口。
   *
   * 只做两件事：找到 MessagePipeline、原样返回它的结果。管道缺失时返回 null ——
   * 没有 core 模块的应用不应该让 ICY 收到一个 JSON-RPC error，那会把内核日志弄脏，
   * 而且对这条消息来说「没人处理」是正确语义。
   */
  async dispatch(dispatch: MessageDispatch): Promise<MessageResult> {
    if (this.#state !== 'started') {
      this.#log.warn(`Application 状态是 ${this.#state}，拒绝处理消息`);
      return null;
    }

    const pipeline = this.#services.get(Messages);
    if (pipeline === undefined) {
      this.#log.warn('没有模块提供 MessagePipeline，消息无法处理');
      return null;
    }

    // middleware 的异常包含 owner/id（见 MessagePipeline）：这里记录之后原样抛出 ——
    // 不吞，是因为「某个模块的消息处理炸了」必须能被看到；不换错误，是因为包装过的
    // owner/id 已经足够定位，再包一层只会让调用方多剥一层。
    try {
      return await pipeline.dispatch(dispatch);
    } catch (error) {
      this.#log.error(`消息处理失败：${describeError(error)}`);
      throw error;
    }
  }

  /**
   * 停止。
   *
   * 顺序严格是 start 的逆序。一个模块 stop 失败不影响其余模块被停止与释放：
   * 全部跑完，最后聚合抛出。
   */
  async stop(): Promise<void> {
    if (this.#state === 'stopped') {
      throw new ApplicationError('Application 已经停止，不要重复 stop');
    }
    if (this.#state === 'stopping') {
      throw new ApplicationError('Application 正在停止中');
    }
    if (this.#state === 'failed') {
      // start 失败已经完整回滚过（stop 与 release 都跑完了），这里只改状态，
      // 不能重跑一遍 stop 钩子 —— 那会让模块看到一个它们没见过的第二次停止。
      this.#state = 'stopped';
      this.#log.info('Application 启动已失败并回滚，标记为已停止');
      return;
    }

    this.#state = 'stopping';
    const failures = await this.#rollback(this.#started);
    this.#started = [];
    this.#state = failures.length === 0 ? 'stopped' : 'failed';

    if (failures.length > 0) {
      throw new ApplicationStopError(failures);
    }
    this.#log.info(`Application 已停止：${this.#order.length} 个模块`);
  }

  /**
   * 回滚：停掉已 start 的模块（逆序），再释放全部模块资源。
   *
   * 两步分开的原因：stop 是模块自己的业务清理（可能失败），release 是 Runtime 的
   * 资源清理（listener / middleware / AbortController）。一个模块 stop 抛异常，
   * 它的 listener 仍然必须被摘掉，否则下一轮启动会看到幽灵订阅。
   */
  async #rollback(started: readonly string[]): Promise<readonly ModuleLifecycleError[]> {
    const failures: ModuleLifecycleError[] = [];

    for (const name of [...started].reverse()) {
      const record = this.#manager.require(name);
      record.status = 'stopping';
      try {
        await record.definition.stop?.(this.#contextFor(record));
        record.status = 'stopped';
      } catch (cause) {
        failures.push(new ModuleLifecycleError(name, 'stop', cause));
        record.status = 'failed';
      }
    }

    failures.push(...(await this.#releaseModules(this.#manager.all.map((record) => record.name))));
    return failures;
  }

  /** 释放资源。逆序释放，一个失败不中断其余。 */
  async #releaseModules(names: readonly string[]): Promise<ModuleLifecycleError[]> {
    const failures: ModuleLifecycleError[] = [];
    for (const name of [...names].reverse()) {
      const errors = await this.#manager.release(name);
      for (const error of errors) {
        failures.push(new ModuleLifecycleError(name, 'stop', error));
      }
    }
    return failures;
  }

  /** 模块可见的 Context。刻意不包含 Application / ModuleManager / 依赖图。 */
  #contextFor(record: ModuleRecord): ModuleContext {
    return {
      module: { name: record.name, version: record.version },
      config: record.config as Readonly<unknown>,
      services: this.#services.readerFor(record.name),
      logger: childLogger(this.#log, record.name),
      signal: record.controller.signal,
      resources: { owner: record.name, signal: record.controller.signal },
      onDispose: (resource) => this.#trackDisposable(record.name, resource),
    };
  }

  #setupContextFor(record: ModuleRecord): ModuleSetupContext {
    return {
      ...this.#contextFor(record),
      provide: <T,>(token: ServiceToken<T>, service: T): void => {
        this.#services.provide(token, service, record.name);
      },
    };
  }

  #trackDisposable(name: string, resource: Disposable | (() => Promise<void> | void)): Disposable {
    return this.#manager.track(name, resource);
  }
}

/**
 * 冻结模块配置。
 *
 * 浅冻结：Runtime 不解释 config 的 schema，但至少要挡住「运行期改顶层字段」
 * 这种能让两个模块看到不同配置的写法。
 */
function freezeConfig(config: unknown): unknown {
  if (config !== null && typeof config === 'object' && !Array.isArray(config)) {
    return Object.freeze(config);
  }
  return config;
}

export function describeApplicationState(app: Application): string {
  const modules = app.modules
    .map((module) => `${module.name}@${module.version}:${module.status}`)
    .join(', ');
  return `state=${app.state} modules=[${modules}]`;
}

export { describeError };