/**
 * 验证模块 A：CounterService 的 provider。
 *
 * 它只做一件事：把计数能力注册成 service。没有依赖，setup 里一次注册完毕。
 * 状态活在 service 对象内部（setup 的闭包），因此同一进程里两个 Application 各自持有
 * 自己的计数 —— 模块定义对象虽然被 ESM 缓存共享，但状态不在定义上。
 */

import { defineModule } from '../app/runtime/module.js';
import { Counter, type CounterService } from './contracts.js';

export const counterModule = defineModule({
  name: 'counter',
  version: '0.1.0',

  setup(ctx) {
    let value = 0;
    const service: CounterService = {
      increment: () => {
        value += 1;
        return value;
      },
      get: () => value,
    };

    ctx.provide(Counter, service);
    ctx.logger.debug('已提供 CounterService');
  },

  start(ctx) {
    ctx.logger.info('counter 已启动');
  },

  stop(ctx) {
    // 停止时 require 仍然可用：Registry 只在 Application 关闭时整体销毁，
    // 不做运行期 remove（v0 不做动态卸载）。所以这里能安全地报出最终值。
    ctx.logger.info(`counter 已停止，最终值 ${ctx.services.require(Counter).get()}`);
  },
});

// default 导出是 loader 的约定：Application 按路径加载时读 default（或 module）。
export default counterModule;