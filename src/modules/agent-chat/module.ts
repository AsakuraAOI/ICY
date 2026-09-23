import { Messages } from '../../app/runtime/contracts.js';
import { defineModule } from '../../app/runtime/module.js';
import { actorFromEvent, inboundEventKey } from '../agent/identity.js';
import { Policy } from '../agent/policy.js';
import { Runs } from '../agent-runtime/runs.js';

interface AgentChatConfig { readonly enabled?: boolean }

/** 自然语言入口只登记后台任务；模型和工具循环不占用 QQ 入站消息处理链。 */
export const agentChatModule = defineModule<AgentChatConfig>({
  name: 'agent-chat', version: '0.2.0',
  requires: ['core', 'policy', 'runs'],
  setup(ctx) {
    if (ctx.config.enabled !== undefined && typeof ctx.config.enabled !== 'boolean') {
      throw new Error('agent-chat.enabled 必须是布尔值');
    }
    if (ctx.config.enabled !== true) {
      ctx.logger.info('Agent Chat 尚未启用');
      return;
    }
    const runs = ctx.services.require(Runs);
    if (!runs.enabled || !runs.durable) {
      throw new Error('启用 agent-chat 前必须配置 runs.enabled=true 和持久化 dbPath');
    }
    const policy = ctx.services.require(Policy);
    ctx.services.require(Messages).use(async (message, next) => {
      const scope = message.event.kind;
      if (scope !== 'group' && scope !== 'c2c') return next();
      if (message.reply === null) return next();
      const content = message.event.content?.trim() ?? '';
      if (content === '' || content.startsWith('/')) return next();

      const replyText = (text: string) => ({
        scope, body: { kind: 'text' as const, text },
      });
      const actor = actorFromEvent(message.event, message.botId);
      if (actor === null) return replyText('无法确认发送者身份，本条请求未执行。');
      if (!policy.decide(actor, 'agent.use', { kind: 'session', sessionKey: actor.sessionKey }).allowed) {
        return replyText('当前会话没有使用 Agent 的权限。');
      }
      const eventKey = inboundEventKey(message.event, actor);
      if (eventKey === null) return replyText('消息缺少有效标识，本条请求未执行。');
      try {
        const result = runs.submit({
          actor, eventKey, text: content, reply: message.reply, host: message.host,
        });
        if (result.accepted) return null;
        switch (result.reason) {
          case 'busy': return replyText('当前任务较多，请稍后再试；可用 /status 查看进度。');
          case 'expired': return replyText('本条消息的回复窗口不足，请重新发送。');
          case 'forbidden': return replyText('当前会话没有使用 Agent 的权限。');
          case 'disabled': return replyText('Agent 尚未启用。');
          case 'stopping': return replyText('服务正在重启，请稍后再试。');
          case 'too_long': return replyText('消息太长，请缩短到 4000 字以内。');
          case 'quota': return replyText('当前会话或机器人近 24 小时任务额度已用完。');
        }
      } catch (error) {
        ctx.logger.error(`Agent 任务登记失败：${error instanceof Error ? error.message : String(error)}`);
        return replyText('任务登记失败，请稍后再试。');
      }
    }, { priority: -100, id: 'agent-chat.admission', resources: ctx.resources });
    ctx.logger.info('Agent Chat 后台任务入口已启用');
  },
});

export default agentChatModule;
