/**
 * 验证模块 D：监听 typed Event，验证 EventBus 的 fanout。
 *
 * 它自己不做任何回复，只是在消息被看到时记一行日志并计数 —— 这正是 Event 的语义：
 * 「某件事情发生了」，没有返回值，也不需要确定性的接收方。
 *
 * 计数对外通过 Audit service 暴露，这样测试不必去猜日志格式；日志同时保留，
 * 用来证明模块日志确实经 ctx.logger → host.log 回到了 ICY 内核。
 *
 * listener 通过 resources: ctx.resources 注册：模块停止时 AbortController 一 abort，
 * 这条 listener 自动被摘掉，模块自己不需要写任何清理代码。
 */

import { defineModule } from '../app/runtime/module.js';
import { Events } from '../app/runtime/contracts.js';
import { Audit, MessageSeen, type AuditService } from './contracts.js';

export const auditorModule = defineModule({
  name: 'auditor',
  version: '0.1.0',
  requires: ['core'],

  setup(ctx) {
    const events = ctx.services.require(Events);

    let count = 0;
    let lastContent: string | null = null;

    const service: AuditService = {
      count: () => count,
      lastContent: () => lastContent,
    };
    ctx.provide(Audit, service);

    events.on(
      MessageSeen,
      (payload) => {
        count += 1;
        lastContent = payload.content;
        ctx.logger.info(
          `message.received scope=${payload.scope} content=${payload.content}（第 ${count} 条）`,
        );
      },
      { id: 'auditor.message', resources: ctx.resources },
    );
  },
});

export default auditorModule;