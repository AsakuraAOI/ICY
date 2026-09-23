import { Messages } from '../../app/runtime/contracts.js';
import { defineModule } from '../../app/runtime/module.js';
import { actorFromEvent } from '../agent/identity.js';
import { Policy } from '../agent/policy.js';
import { ToolFailure, Tools } from '../agent/tools.js';
import { Runs } from '../agent-runtime/runs.js';
import type { StoredRun } from '../agent-runtime/store.js';

/** 确定性命令入口。返回回复即消费消息；任何斜杠输入都不会进入 LLM。 */
export const commandRouterModule = defineModule({
  name: 'command-router', version: '0.1.0',
  requires: ['core', 'policy', 'runs', 'tools'],
  setup(ctx) {
    const policy = ctx.services.require(Policy);
    const runs = ctx.services.require(Runs);
    const tools = ctx.services.require(Tools);
    ctx.services.require(Messages).use(async (message, next) => {
      const scope = message.event.kind;
      if (scope !== 'group' && scope !== 'c2c') return next();
      const content = message.event.content?.trim() ?? '';
      if (!content.startsWith('/')) return next();
      const reply = (text: string) => ({ scope, body: { kind: 'text' as const, text } });
      const actor = actorFromEvent(message.event, message.botId);
      if (actor === null) return reply('无法确认发送者身份，命令未执行。');
      const match = /^\/([a-z][a-z0-9_-]*)(?:\s+(.+))?$/i.exec(content);
      if (match === null) return reply('命令格式无效；发送 /help 查看可用命令。');
      const command = match[1]?.toLowerCase();
      const argument = match[2];
      if (command === 'help' && argument === undefined) {
        const commands = ['/help'];
        const resource = { kind: 'session' as const, sessionKey: actor.sessionKey };
        if (policy.decide(actor, 'runs.read', resource).allowed) commands.push('/status');
        if (policy.decide(actor, 'runs.cancel', resource).allowed) commands.push('/cancel');
        if (policy.decide(actor, 'sessions.reset', resource).allowed) commands.push('/reset');
        if (policy.decide(actor, 'tools.calculator_evaluate', { kind: 'tool' }).allowed) commands.push('/calc <表达式>');
        if (policy.decide(actor, 'tools.clock_now', { kind: 'tool' }).allowed) commands.push('/time [时区]');
        return reply(`可用命令：${commands.join('、')}。普通问题直接发送消息。`);
      }
      if (command === 'calc' || command === 'time') {
        const action = command === 'calc' ? 'tools.calculator_evaluate' : 'tools.clock_now';
        if (!policy.decide(actor, action, { kind: 'tool' }).allowed) return reply('没有执行此命令的权限。');
        if (command === 'calc' && (argument === undefined || argument.length > 160)) {
          return reply('用法：/calc 1+2*3');
        }
        if (command === 'time' && argument !== undefined && argument.length > 64) {
          return reply('时区名称过长。');
        }
        try {
          const result = await tools.execute(
            command === 'calc' ? 'calculator_evaluate' : 'clock_now',
            command === 'calc' ? { expression: argument } : argument === undefined ? {} : { timeZone: argument },
            { actor, sessionKey: actor.sessionKey, runId: `command:${message.event.eventId}`,
              deadline: Date.now() + 2_000, signal: message.signal },
          );
          const data = JSON.parse(result) as Record<string, unknown>;
          return reply(command === 'calc' ? `结果：${String(data.value)}` : String(data.local));
        } catch (error) {
          if (error instanceof ToolFailure && error.kind === 'forbidden') {
            return reply('没有执行此命令的权限。');
          }
          return reply(command === 'calc' ? '表达式无效。' : '时区无效。');
        }
      }
      if (command !== 'status' && command !== 'cancel' && command !== 'reset') {
        return reply('未知命令；发送 /help 查看可用命令。');
      }
      if (argument !== undefined) return reply(`/${command} 不接受参数。`);
      const action = command === 'status' ? 'runs.read'
        : command === 'cancel' ? 'runs.cancel' : 'sessions.reset';
      if (!policy.decide(actor, action, { kind: 'session', sessionKey: actor.sessionKey }).allowed) {
        return reply('没有执行此命令的权限。');
      }
      if (!runs.enabled) return reply('Agent 尚未启用。');
      try {
        if (command === 'status') return reply(formatStatus(runs.status(actor)));
        if (command === 'cancel') return reply(runs.cancel(actor) ? '已取消当前任务。' : '当前没有可取消的任务。');
        runs.reset(actor);
        return reply('已清空当前会话并取消进行中的任务。');
      } catch (error) {
        ctx.logger.error(`/${command} 执行失败：${error instanceof Error ? error.message : String(error)}`);
        return reply('命令执行失败，请稍后再试。');
      }
    }, { priority: -200, id: 'command-router.direct', resources: ctx.resources });
  },
});

function formatStatus(run: StoredRun | null): string {
  if (run === null) return '当前会话还没有任务。';
  const state = {
    queued: '排队中', running: '运行中', completed: '已完成',
    failed: '失败', cancelled: '已取消', interrupted: '服务中断',
  }[run.status];
  if (run.result !== null && run.delivery !== 'sent') {
    return `最近任务：${state}；回复状态：${run.delivery}。\n${Array.from(run.result).slice(0, 1_500).join('')}`;
  }
  return `最近任务：${state}；回复状态：${run.delivery}。`;
}

export default commandRouterModule;
