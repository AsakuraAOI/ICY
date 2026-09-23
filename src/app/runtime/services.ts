/**
 * ServiceRegistry：模块之间的「主动调用」机制。
 *
 * Service 的语义是「请明确执行一件事，并返回结果」。它和 EventBus 的分工是硬的：
 * 需要返回值、需要知道失败原因、需要确定性的调用方 → Service；只是「通知一件事发生了」
 * → Event。拿 EventBus 模拟 RPC 会把调用方的错误处理路径整个抹掉。
 *
 * 归属规则（v0）：
 * - 一个 token 只能有一个 provider，重复 provide 直接报错，不做「后者覆盖」。
 *   覆盖是静默的数据竞争：谁先 setup 谁被悄悄替换，日志里看不出任何异常。
 * - provide 只在 setup 阶段合法。setup 全部跑完后 Registry 冻结，运行期注册一律拒绝。
 * - 记录 provider module，require 失败时把「谁要、谁没提供」都写进错误里。
 *
 * v0 不做动态卸载：Application 关停时整体销毁，没有 remove()。
 */

declare const serviceType: unique symbol;

/**
 * 带类型的 service 句柄。
 *
 * id 是运行时唯一的键；带 `declare const` 的可选品牌属性只参与类型推导，
 * 运行时不存在。这样模块之间传的是 token 而不是裸字符串，
 * `require(Storage)` 能直接得到 StorageService，不需要任何强制类型转换。
 */
export interface ServiceToken<T> {
  readonly id: string;
  /** 仅用于类型推导，运行时不存在。 */
  readonly [serviceType]?: T;
}

/** service 相关的注册/查找错误。token 单独留一个字段，方便日志与测试断言。 */
export class ServiceError extends Error {
  readonly token: string;

  constructor(token: string, message: string) {
    super(message);
    this.name = 'ServiceError';
    this.token = token;
  }
}

/**
 * 声明一个 service token。
 *
 * 只负责校验 id 并返回句柄；注册发生在 setup 阶段的 ctx.provide()。
 */
export function defineService<T>(id: string): ServiceToken<T> {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new ServiceError(String(id), 'service id 必须是非空字符串');
  }
  return { id: id.trim() };
}

/**
 * 模块侧看到的 service 视图。
 *
 * 故意不暴露 ServiceRegistry 本体：模块看不到别人的注册表，也无法枚举或覆写。
 * require() 的错误信息会带上调用方模块名，这个绑定由 Runtime 在生成视图时注入。
 */
export interface ServiceReader {
  /** 拿不到时返回 undefined。用于「是否存在」这类可降级判断。 */
  get<T>(token: ServiceToken<T>): T | undefined;
  /** 拿不到时直接抛错。用于声明了硬依赖、缺失就该启动失败的场景。 */
  require<T>(token: ServiceToken<T>): T;
  has(token: ServiceToken<unknown>): boolean;
}

interface ServiceEntry {
  readonly service: unknown;
  /** 提供它的模块名。 */
  readonly owner: string;
}

export class ServiceRegistry {
  readonly #entries = new Map<string, ServiceEntry>();
  #frozen = false;

  /**
   * 为某个模块生成只读视图。
   *
   * 视图持有消费者模块名，require 失败时才能报出
   * 「模块 "reminder" 需要 service "scheduler"，但没有任何模块提供它」，
   * 而不是一句无法归因的 token 缺失。
   */
  readerFor(consumer: string): ServiceReader {
    return {
      get: <T>(token: ServiceToken<T>): T | undefined => this.get(token),
      require: <T>(token: ServiceToken<T>): T => this.require(token, consumer),
      has: (token: ServiceToken<unknown>): boolean => this.has(token),
    };
  }

  get<T>(token: ServiceToken<T>): T | undefined {
    return this.#entries.get(token.id)?.service as T | undefined;
  }

  has(token: ServiceToken<unknown>): boolean {
    return this.#entries.has(token.id);
  }

  /** provider module。测试与诊断用。 */
  ownerOf(token: ServiceToken<unknown>): string | undefined {
    return this.#entries.get(token.id)?.owner;
  }

  get size(): number {
    return this.#entries.size;
  }

  get frozen(): boolean {
    return this.#frozen;
  }

  require<T>(token: ServiceToken<T>, consumer: string): T {
    const entry = this.#entries.get(token.id);
    if (entry === undefined) {
      throw new ServiceError(
        token.id,
        `模块 "${consumer}" 需要 service "${token.id}"，但没有任何模块提供它`,
      );
    }
    return entry.service as T;
  }

  /**
   * 注册一个 service。owner 必须是提供方的模块名 —— 归属信息不靠调用方传入，
   * 而是由 Runtime 从注册的模块上下文里带过来。
   */
  provide<T>(token: ServiceToken<T>, service: T, owner: string): void {
    // undefined / null 会让 require() 的返回值变成「拿到了，但是空的」，
    // 调用方会在更远的地方炸。在注册点就挡掉。
    if (service === undefined || service === null) {
      throw new ServiceError(
        token.id,
        `模块 "${owner}" 提供的 service "${token.id}" 是 ${String(service)}`,
      );
    }

    if (this.#frozen) {
      throw new ServiceError(
        token.id,
        `模块 "${owner}" 在 setup 阶段之后注册 service "${token.id}"；运行期不能新增或替换 service`,
      );
    }

    const existing = this.#entries.get(token.id);
    if (existing !== undefined) {
      throw new ServiceError(
        token.id,
        `service "${token.id}" 被重复提供：已由模块 "${existing.owner}" 提供，模块 "${owner}" 不能再提供`,
      );
    }

    this.#entries.set(token.id, { service, owner });
  }

  /** setup 全部完成后冻结。冻结之后的 provide 一律拒绝（运行期不能静默覆盖 service）。 */
  freeze(): void {
    this.#frozen = true;
  }
}