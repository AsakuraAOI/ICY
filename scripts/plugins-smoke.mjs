import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Application, createCoreModule, defineModule } from '../dist/app/index.js';
import { Messages } from '../dist/app/runtime/contracts.js';
import { ConfiguredPolicy } from '../dist/modules/agent/policy.js';
import policy from '../dist/modules/agent/policy.js';
import tools from '../dist/modules/agent/tools-module.js';
import { Tools } from '../dist/modules/agent/tools.js';
import commands from '../dist/modules/commands/module.js';
import utility, { rollDice, choose } from '../dist/modules/utility/module.js';
import memory, { MemoryStore } from '../dist/modules/memory/module.js';
import autoReply from '../dist/modules/auto-reply/module.js';
import router from '../dist/modules/agent-chat/commands.js';
import runs from '../dist/modules/agent-runtime/runs.js';
import models from '../dist/modules/llm/module.js';
import engine from '../dist/modules/agent/engine-module.js';
import { readExtensionConfig } from '../dist/modules/extensions/config.js';

assert.match(rollDice('0d6', 20), /数量必须/);
assert.match(rollDice('1d6', 20), /^1d6：[1-6]；合计 [1-6]$/);
assert.match(choose('A | B'), /^我选：[AB]$/);
assert.match(choose('A || B'), /用法/);
assert.throws(() => readExtensionConfig({ autoReply: { rules: [{ id: 'x', keyword: 'x', match: 'regex', reply: 'x', scopes: ['group'], groupOpenids: [], cooldownSeconds: 0 }] } }), /匹配方式/);

const temp = mkdtempSync(join(tmpdir(), 'icy-plugins-'));
const path = join(temp, 'memory.sqlite');
const app = new Application();
let stopped = false;
let fallbacks = 0;
let sequence = 0;
function dispatch(content, user = 'user-a', group = 'group-a', messageId) {
  sequence++;
  return app.dispatch({ botId: 'bot-a', host: {}, reply: { handleId: 'h', expiresAt: Date.now() + 120000, acceptBefore: Date.now() + 60000, remaining: 5 },
    event: { kind: 'group', eventType: 'GROUP_AT_MESSAGE_CREATE', eventId: `event-${sequence}`, messageId: messageId ?? `msg-${sequence}`, seq: sequence, raw: {}, content, groupOpenid: group, senderId: user, senderIdSource: 'member_openid' } });
}
try {
  app.add(createCoreModule());
  app.add(policy, { allowedGroups: ['group-a', 'group-b'], allowC2c: true, blockedUsers: ['blocked'], enabledTools: ['memory_search'] });
  app.add(tools);
  app.add(models, {});
  app.add(engine);
  app.add(commands);
  app.add(utility, { enabled: true, maxDice: 10 });
  app.add(memory, { enabled: true, maxEntries: 2, maxChars: 100, dbPath: path });
  app.add(autoReply, { enabled: true, rules: [{ id: 'hello', keyword: '你好', match: 'exact', reply: '你好呀', scopes: ['group'], groupOpenids: ['group-a'], cooldownSeconds: 60 }] });
  app.add(runs, { enabled: false });
  app.add(router);
  app.add(defineModule({ name: 'fallback', version: '1', requires: ['core'], setup(ctx) {
    ctx.services.require(Messages).use(async () => { fallbacks++; return null; }, { priority: 0, resources: ctx.resources });
  } }));
  await app.start();
  assert.match((await dispatch('/help')).body.text, /remember/);
  assert.match((await dispatch('/whoami')).body.text, /群 OpenID：group-a/);
  assert.match((await dispatch('/roll 1d6')).body.text, /^1d6/);
  assert.match((await dispatch('/remember 我喜欢咖啡', 'user-a', 'group-a', 'remember-1')).body.text, /#1/);
  assert.match((await dispatch('/remember 我喜欢咖啡', 'user-a', 'group-a', 'remember-1')).body.text, /#1/, '重投递不得重复写入');
  assert.match((await dispatch('/memories', 'user-b')).body.text, /没有保存/);
  assert.match((await dispatch('/memories', 'user-a', 'group-b')).body.text, /没有保存/);
  assert.match((await dispatch('/forget 1', 'user-b')).body.text, /没有找到/);
  assert.match((await dispatch('/memories')).body.text, /咖啡/);
  assert.match((await dispatch('/remember x', 'blocked')).body.text, /没有执行/);
  assert.match((await dispatch('/roll', 'user-a', 'unauthorized')).body.text, /没有执行/);
  const actor = { botId: 'bot-a', scope: 'group', actorId: 'user-a', groupOpenid: 'group-a', sessionKey: JSON.stringify(['bot-a', 'group', 'group-a', 'user-a']) };
  const executor = app.services.require(Tools);
  const ctx = { actor, sessionKey: actor.sessionKey, runId: 'test', deadline: Date.now() + 2000, signal: new AbortController().signal };
  assert.match(await executor.execute('memory_search', { query: '咖啡' }, ctx), /咖啡/);
  assert.equal(JSON.parse(await executor.execute('memory_search', {}, { ...ctx, actor: { ...actor, sessionKey: 'other-session' } })).memories.length, 0);
  const policyService = new ConfiguredPolicy({ allowedGroups: ['group-a'], enabledTools: ['memory_search'] });
  assert.equal(policyService.decide(actor, 'memory.read', { kind: 'session', sessionKey: 'other-session' }).allowed, false);
  assert.equal((await dispatch('你好')).body.text, '你好呀');
  assert.equal(await dispatch('你好'), null, '冷却命中不得落入 Agent');
  assert.equal(fallbacks, 0, '插件命令和规则命中应消费消息');
  await dispatch('你好', 'user-a', 'group-b');
  assert.equal(fallbacks, 1, '规则不能越过指定群');
  await app.stop();
  stopped = true;
  const reopened = new MemoryStore(path);
  assert.equal(reopened.count(actor.sessionKey), 1, '重启保留记忆');
  assert.equal(reopened.forget('other-session', 'all'), 0);
  assert.equal(reopened.forget(actor.sessionKey, 'all'), 1);
  reopened.close();
  console.log('PLUGINS OK：命令路由、权限隔离、记忆去重与持久化、工具检索、规则冷却');
} finally {
  if (!stopped) await app.stop();
  rmSync(temp, { recursive: true, force: true });
}
