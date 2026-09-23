/**
 * 验证模块 C：向 MessagePipeline 注册 middleware，并把 `ping` 处理成 `pong`。
 *
 * priority = -10：数值小者先执行，所以它排在 greeter 的 `count` 中间件（priority 10）之前。
 * 两条 middleware 一起演示了 pipeline 的两条路径：**消费**（ping 直接返回，不再 next()）
 * 与 **放行**（其他内容 return next()）。
 *
 * 返回的就是 ICY SDK 的 PluginReplyInstruction，消息协议在这一层没有被重新设计。
 */

import { defineModule } from '../app/runtime/module.js';
import { Messages } from '../app/runtime/contracts.js';
import { replyScopeOf } from './contracts.js';

export const pingerModule = defineModule({
  name: 'pinger',
  version: '0.1.0',
  requires: ['core'],

  setup(ctx) {
    const messages = ctx.services.require(Messages);

    messages.use(
      async (message, next) => {
        if (message.event.content !== 'ping') return next();

        const scope = replyScopeOf(message.event);
        if (scope === null) return next();

        return { scope, body: { kind: 'text', text: 'pong' } };
      },
      { priority: -10, id: 'pinger.ping', resources: ctx.resources },
    );
  },
});

export default pingerModule;