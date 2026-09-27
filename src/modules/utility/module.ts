import { randomInt } from 'node:crypto';
import { defineModule } from '../../app/runtime/module.js';
import { PluginCommands } from '../commands/module.js';
import { DEFAULT_EXTENSIONS, readExtensionConfig } from '../extensions/config.js';

export function rollDice(argument: string | undefined, maxDice: number): string {
  const match = /^(\d{1,3})d(\d{1,6})$/i.exec(argument ?? '1d6');
  if (!match) return '用法：/roll 2d6（默认 1d6）';
  const count = Number(match[1]); const sides = Number(match[2]);
  if (count < 1 || count > maxDice || sides < 2 || sides > 100000) return `骰子数量必须为 1–${maxDice}，面数为 2–100000。`;
  const results = Array.from({ length: count }, () => randomInt(1, sides + 1));
  return `${count}d${sides}：${results.join('、')}；合计 ${results.reduce((a, b) => a + b, 0)}`;
}
export function choose(argument: string | undefined): string {
  const options = (argument ?? '').split('|').map((v) => v.trim());
  if (options.length < 2 || options.length > 20 || options.some((v) => !v || v.length > 100)) return '用法：/choose 选项一 | 选项二（2–20 个选项，每个最多 100 字）';
  return `我选：${options[randomInt(options.length)]}`;
}
export default defineModule<unknown>({
  name: 'utility', version: '0.1.0', requires: ['commands'],
  setup(ctx) {
    const config = readExtensionConfig({ ...DEFAULT_EXTENSIONS, utilities: ctx.config }).utilities;
    if (!config.enabled) return;
    const commands = ctx.services.require(PluginCommands);
    commands.register({ name: 'roll', owner: 'utility', usage: '/roll [2d6]', execute: (arg) => rollDice(arg, config.maxDice) });
    commands.register({ name: 'choose', owner: 'utility', usage: '/choose 选项一 | 选项二', execute: choose });
    commands.register({ name: 'whoami', owner: 'utility', usage: '/whoami', execute: (arg, actor) => arg ? '用法：/whoami' :
      `场景：${actor.scope === 'group' ? '群聊' : '私聊'}\n用户 OpenID：${actor.actorId}${actor.groupOpenid ? `\n群 OpenID：${actor.groupOpenid}` : ''}\n平台角色：${actor.role ?? '未提供'}\n身份来自 QQ 平台事件。` });
    commands.register({ name: 'plugins', owner: 'utility', usage: '/plugins', execute: (arg) => arg ? '用法：/plugins' : `已启用命令插件：${[...new Set(commands.list().map((c) => c.owner))].join('、')}` });
  },
});
