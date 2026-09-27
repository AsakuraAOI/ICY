import assert from 'node:assert/strict';
import { Application, createCoreModule, defineModule } from '../dist/app/index.js';
import { Messages } from '../dist/app/runtime/contracts.js';
import { Models } from '../dist/modules/llm/contracts.js';
import { Agents } from '../dist/modules/agent/engine.js';
import { Runs } from '../dist/modules/agent-runtime/runs.js';
import runsModule from '../dist/modules/agent-runtime/runs.js';
import policyModule from '../dist/modules/agent/policy.js';
import humanizeModule from '../dist/modules/humanize/module.js';
import { Humanize } from '../dist/modules/humanize/contracts.js';
import { DEFAULT_HUMANIZE, readHumanizeConfig } from '../dist/modules/humanize/config.js';
import { humanizeText } from '../dist/modules/humanize/format.js';

const format = (text, options = {}, source = 'agent') => humanizeText(text, { ...DEFAULT_HUMANIZE, ...options }, source);
for (const [input, expected] of [
  ['收到。', '收到'], ['真的？！', '真的'], ['Hello!?', 'Hello'],
  ['你好。今天怎么样？', '你好。今天怎么样'], ['第一句。\r\n第二句！  \r\n', '第一句\r\n第二句  \r\n'],
  ['版本 1.2.3，结果 3.14。', '版本 1.2.3，结果 3.14'],
  ['- 记得喝水。\n1. 明天再说！', '- 记得喝水\n1. 明天再说'],
  ['先运行代码。\n```js\nconsole.log("Hi!");\n```\n完成！', '先运行代码\n```js\nconsole.log("Hi!");\n```\n完成'],
  ['~~~txt\n不要改这里！\n~~~\n好的。', '~~~txt\n不要改这里！\n~~~\n好的'],
]) assert.equal(format(input), expected, input);
for (const text of [
  '…', '嗯……', '嗯...', '!?', '。\n！', '1.', '    console.log("Hi!")',
  '> 原话不能改。', '运行 `x()`。', '| 字段 | 值！ |',
  'https://example.com/path?!', '链接 https://example.com/end.', 'hello@example.com.', 'config.json.',
  '{\n  "reply": "你好。"\n}', '["你好！"]', '<p>你好！</p>',
  '```js\n不要改未关闭的代码。', '$$\nx!\n$$', '\\[\nx!\n\\]',
  '“原话。”', 'Dr.',
]) assert.equal(format(text), text, `保护格式：${text}`);
assert.equal(format('一。\n二！\n', { perLine: false }), '一。\n二\n');
assert.equal(format('你好。', { enabled: false }), '你好。');
assert.equal(format('你好。', { stripTerminalPunctuation: false }), '你好。');
assert.equal(format('你好。', {}, 'command'), '你好。');
assert.equal(format('你好。', { includeCommands: true }, 'command'), '你好');
assert.throws(() => readHumanizeConfig({ enabled: 'yes' }), /必须是布尔值/);

const app = new Application();
const delivered = [];
const actor = { botId: 'test-bot', scope: 'c2c', actorId: 'test-user', sessionKey: 'test-session' };
const host = { async reply(handle, body) { delivered.push(body.text); return { ok: true, messageId: 'reply', msgSeq: 1 }; } };
const reply = { handleId: 'test-handle', acceptBefore: Date.now() + 60_000, expiresAt: Date.now() + 120_000, remaining: 5 };
const direct = { scope: 'c2c', body: { kind: 'text', text: '收到。' } };
try {
  app.add(createCoreModule());
  app.add(humanizeModule, {});
  app.add(policyModule, { allowC2c: true, enabledTools: [] });
  app.add(defineModule({ name: 'models', version: '1', setup(ctx) { ctx.provide(Models, { describe: () => ({ maxOutputTokens: 100 }) }); } }));
  app.add(defineModule({ name: 'agent-engine', version: '1', setup(ctx) { ctx.provide(Agents, { async run() { return { text: '收到。' }; } }); } }));
  app.add(runsModule, { enabled: true, modelAlias: 'test', outputLimit: 64 });
  app.add(defineModule({ name: 'test-reply', version: '1', requires: ['core'], setup(ctx) {
    ctx.services.require(Messages).use(async () => direct, { resources: ctx.resources });
  } }));
  await app.start();
  const dispatch = content => app.dispatch({ event: { kind: 'c2c', eventType: 'C2C_MESSAGE_CREATE', content, raw: {} }, host, reply });
  assert.equal((await dispatch('你好')).body.text, '收到', '普通消息链应处理输出');
  assert.equal((await dispatch('/test')).body.text, '收到。', '直接命令默认保留格式');
  assert.equal(direct.body.text, '收到。', '不得修改下游模块原始回复对象');
  const runs = app.services.require(Runs);
  assert.equal(runs.submit({ actor, eventKey: 'test-event', text: '你好', host, reply }).accepted, true);
  const deadline = Date.now() + 2_000;
  while (!delivered.length && Date.now() < deadline) await new Promise(done => setTimeout(done, 10));
  assert.deepEqual(delivered, ['收到'], '后台 Agent 发送前也应处理输出');
  assert.equal(runs.status(actor).result, '收到。', '任务与历史保留原始模型输出');
  assert.equal(app.services.require(Humanize).format('收到。', 'agent'), '收到');
} finally { await app.stop(); }
console.log('HUMANIZE OK：标点处理、格式保护、开关、消息链和 Agent 发送集成');
