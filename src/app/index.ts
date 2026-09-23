/**
 * App Runtime 公共入口。
 *
 * 同一个包里导出两层：
 * - runtime/：Application、模块定义、ServiceRegistry、依赖图、Event/Message 契约
 * - core/：必装 Core Module（EventBus + MessagePipeline 的具体实现与工厂）
 *
 * 只导出「机制」：业务能力（command / storage / scheduler / reminder / AI）属于真实
 * App Module，不属于这个入口，也不属于 ICY Core。
 */

export * from './runtime/index.js';
export { createCoreModule } from './core/index.js';
export { createEventBus, EventBusImpl } from './core/events.js';
export {
  createMessagePipeline,
  MessagePipelineImpl,
  MiddlewareError,
  PipelineRegistrationError,
  PipelineReentryError,
} from './core/pipeline.js';