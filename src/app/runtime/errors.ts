/**
 * Runtime 内部错误类型与描述工具。
 *
 * 这里只放「跨文件共享」的错误：loader 的重名错误留在 loader.ts，因为它只在那儿出现。
 * 生命周期错误单独成型，是为了让调用方能区分「哪个模块、哪个阶段」失败 ——
 * 只抛一句 message 的话，回滚日志里几十个 stop 失败就分不清谁是谁。
 */

export function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Application 自身的状态错误：重复 start/stop、非法装配等。 */
export class ApplicationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ApplicationError';
  }
}

export type LifecyclePhase = 'setup' | 'start' | 'stop';

/** 模块生命周期钩子失败。cause 保留原始异常，不吞栈。 */
export class ModuleLifecycleError extends Error {
  readonly moduleName: string;
  readonly phase: LifecyclePhase;

  constructor(moduleName: string, phase: LifecyclePhase, cause: unknown) {
    super(`模块 "${moduleName}" 在 ${phase} 阶段失败：${describeError(cause)}`, { cause });
    this.name = 'ModuleLifecycleError';
    this.moduleName = moduleName;
    this.phase = phase;
  }
}

/**
 * start() 失败时的最终错误：原始失败 + 回滚过程中的可恢复失败。
 *
 * 原始失败是 cause：调用方（插件 onInit）看到的是「谁在 start 挂了」。
 * 回滚失败不能吞掉 —— 否则「已经停了一半」这种状态永远不会出现在日志里，
 * 但它们也不该覆盖原始失败，所以只做聚合暴露。
 */
export class ApplicationStartError extends Error {
  readonly failure: ModuleLifecycleError;
  readonly rollbackFailures: readonly ModuleLifecycleError[];

  constructor(failure: ModuleLifecycleError, rollbackFailures: readonly ModuleLifecycleError[]) {
    super(
      rollbackFailures.length === 0
        ? failure.message
        : `${failure.message}；回滚时另有 ${rollbackFailures.length} 个模块清理失败`,
      { cause: failure },
    );
    this.name = 'ApplicationStartError';
    this.failure = failure;
    this.rollbackFailures = rollbackFailures;
  }
}

/**
 * stop() 结束时仍有模块清理失败。
 *
 * 清理是「全部尝试完」的语义：一个模块 stop 失败不影响其余模块被停止与释放，
 * 所以错误只能聚合到最后一起抛，而不是遇到第一个就中断。
 */
export class ApplicationStopError extends Error {
  readonly failures: readonly ModuleLifecycleError[];

  constructor(failures: readonly ModuleLifecycleError[]) {
    super(
      `Application 停止时有 ${failures.length} 个模块清理失败：\n  - ${failures
        .map((failure) => failure.message)
        .join('\n  - ')}`,
    );
    this.name = 'ApplicationStopError';
    this.failures = failures;
  }
}