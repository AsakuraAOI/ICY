/**
 * App Runtime 的公开面（runtime 层）。
 *
 * 这里导出的是「机制」：模块定义与上下文、ServiceRegistry、依赖图、EventBus /
 * MessagePipeline 的契约（contracts.ts）、以及 Application 本体。
 *
 * 刻意不导出 ModuleManager 之外的内部实现细节：模块拿到的是受控 Context，
 * 而不是 Runtime 内部状态。
 */

export { Application, describeApplicationState } from './application.js';
export type { ApplicationOptions, ApplicationState, ModuleStatusView } from './application.js';
export { buildDependencyGraph, DependencyError } from './dependency.js';
export type {
  DependencyCycle,
  DependencyGraph,
  DependencyIssue,
  DependencyNode,
  DuplicateModule,
  MissingDependency,
} from './dependency.js';
export {
  ApplicationError,
  ApplicationStartError,
  ApplicationStopError,
  describeError,
  ModuleLifecycleError,
} from './errors.js';
export type { LifecyclePhase } from './errors.js';
export { loadModuleFromPath, ModuleManagerError } from './loader.js';
export { childLogger, createConsoleLogger, NOOP_LOGGER } from './logger.js';
export type { Logger, LogLevel } from './logger.js';
export { defineModule, ModuleDefinitionError, readModuleDefinition } from './module.js';
export type {
  Disposable,
  MaybePromise,
  ModuleContext,
  ModuleDefinition,
  ModuleInfo,
  ModuleResources,
  ModuleSetupContext,
  ModuleStatus,
} from './module.js';
export { defineService, ServiceError, ServiceRegistry } from './services.js';
export type { ServiceReader, ServiceToken } from './services.js';
export { defineEvent, EventError, Events, Messages } from './contracts.js';
export type {
  EventBus,
  EventDeliveryFailure,
  EventDeliveryResult,
  EventHandler,
  EventSubscribeOptions,
  EventToken,
  MessageContext,
  MessageDispatch,
  MessageMiddleware,
  MessageMiddlewareOptions,
  MessageNext,
  MessagePipeline,
  MessageResult,
} from './contracts.js';