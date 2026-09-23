/**
 * 验证模块 B：声明 requires: ['core', 'counter']，通过 ServiceRegistry 消费 CounterService。
 *
 * 验证三件事：
 * 1. 依赖排序 —— counter 的 setup 必须先跑，否则这里 require 会失败。
 * 2. typed token —— require(Counter) 直接得到 CounterService，没有裸字符串，也没有类型断言。
 * 3. provider / consumer 分工 —— 状态在 A，调用在 B。
 *
 * 它同时注册一条 pipeline middleware：内容为 `count` 时消费消息并回复 `prefix:N`，
 * 其余内容 return next() 交给后面的 middleware（这就是中断 / 放行的语义）。
 */

import { defineModule } from '../app/runtime/module.js';
import { Events, Messages } from '../app/runtime/contracts.js';
import { Counter, MessageSeen, replyScopeOf } from './contracts.js';

export const greeterModule = defineModule<{ prefix: string }>({
  name: 'greeter',
  version: '0.1.0',
  requires: ['core', 'counter'],

  setup(ctx) {
    // setup 阶段依赖已经就绪：counter 的 setup 一定跑在前面。
    const counter = ctx.services.require(Counter);
    const events = ctx.services.require(Events);
    const messages = ctx.services.require(Messages);
    const prefix = typeof ctx.config.prefix === 'string' ? ctx.config.prefix : 'count';

    messages.use(
      async (message, next) => {
        if (message.event.content !== 'count') return next();

        const scope = replyScopeOf(message.event);
        if (scope === null) return next();

        const value = counter.increment();
        // 广播「看到了一条消息」。emit 不会因为某个 listener 失败而抛错，
        // 失败的 listener 由事件总线聚合返回 —— 这里只关心广播发生过。
        const delivered = await events.emit(MessageSeen, {
          scope,
          content: message.event.content ?? '',
        });
        ctx.logger.debug(`message.seen 已广播，投递 ${delivered.delivered} 个 listener`);

        return { scope, body: { kind: 'text', text: `${prefix}:${value}` } };
      },
      { priority: 10, id: 'greeter.count', resources: ctx.resources },
    );
  },
});

export default greeterModule;