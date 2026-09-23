/**
 * Core Module：App Runtime 内必装的机制模块。
 *
 * v0 只提供两样东西，都是「机制」而不是「业务」：
 *
 * - EventBus：广播「某件事发生了」
 * - MessagePipeline：按顺序处理一条消息，并按 ICY SDK 的回复形状返回结果
 *
 * 刻意不在这里实现：command parser / storage / scheduler / permission / AI /
 * database / session。任何「所有模块都会依赖，所以都往里塞」的东西都会把 Core Module
 * 变成 God Module —— 加进来的每一行都必须先问一句「这是机制，还是业务」。
 *
 * 依赖方向：core → runtime（契约与 defineModule 都在 runtime 层），
 * 绝不会出现 runtime → core。所以 Core Module 可以被 Application 当普通模块加载，
 * 而 Application 不需要知道它存在。
 */

import { defineModule, type ModuleDefinition } from '../runtime/module.js';
import { Events, Messages } from '../runtime/contracts.js';
import { createEventBus } from './events.js';
import { createMessagePipeline } from './pipeline.js';

export function createCoreModule(): ModuleDefinition<Record<string, unknown>> {
  return defineModule<Record<string, unknown>>({
    name: 'core',
    version: '0.1.0',
    setup(ctx) {
      const bus = createEventBus();
      const pipeline = createMessagePipeline();

      // Registry 只在 setup 阶段可写，这两行就是整个 Core Module 的全部注册行为。
      ctx.provide(Events, bus);
      ctx.provide(Messages, pipeline);

      ctx.logger.debug('core module 提供了 EventBus 与 MessagePipeline');
    },
  });
}

export { createEventBus, EventBusImpl } from './events.js';
export {
  createMessagePipeline,
  MessagePipelineImpl,
  MiddlewareError,
  PipelineRegistrationError,
  PipelineReentryError,
} from './pipeline.js';