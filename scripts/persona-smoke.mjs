#!/usr/bin/env node
/** 人设选择、权限边界，以及系统提示词到 Agent 的集成验证。 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Application, createCoreModule, defineModule } from '../dist/app/index.js';
import { Models } from '../dist/modules/llm/contracts.js';
import policyModule from '../dist/modules/agent/policy.js';
import toolsModule from '../dist/modules/agent/tools-module.js';
import engineModule from '../dist/modules/agent/engine-module.js';
import runsModule from '../dist/modules/agent-runtime/runs.js';
import commandRouterModule from '../dist/modules/agent-chat/commands.js';
import agentChatModule from '../dist/modules/agent-chat/module.js';
import personaModule, { ConfiguredPersonas } from '../dist/modules/persona/module.js';

const profiles = [
  { id: 'default', name: '默认', description: '通用助手', systemPrompt: '默认人设提示词' },
  { id: 'group', name: '群助手', systemPrompt: '群人设提示词' },
  { id: 'private', name: '私聊助手', systemPrompt: '私聊人设提示词' },
];
const personaConfig = {
  defaultId: 'default', profiles,
  groupAssignments: { 'group-a': 'group' },
  c2cAssignments: { 'user-9': 'private' },
};

const configured = new ConfiguredPersonas(personaConfig);
assert.equal(configured.resolve({ scope: 'group', groupOpenid: 'group-a' }).id, 'group');
assert.equal(configured.resolve({ scope: 'group', groupOpenid: 'group-b' }).id, 'default');
assert.equal(configured.resolve({ scope: 'c2c', actorId: 'user-9' }).id, 'private');
assert.equal(configured.resolve({ scope: 'c2c', actorId: 'user-8' }).id, 'default');
assert.throws(() => new ConfiguredPersonas({ ...personaConfig,
  groupAssignments: { 'group-a': 'missing' } }), /无效 OpenID 或人设 id/);
assert.throws(() => new ConfiguredPersonas({ ...personaConfig,
  profiles: [...profiles, profiles[0]] }), /重复/);
assert.throws(() => new ConfiguredPersonas({ ...personaConfig,
  profiles: [{ id: 'default', name: '默认', systemPrompt: 'x'.repeat(8_001) }] }), /最多 8000/);

const temp = mkdtempSync(join(tmpdir(), 'icy-persona-'));
const requests = [];
const deliveries = [];
const fakeModels = defineModule({
  name: 'models', version: '1.0.0',
  setup(ctx) {
    ctx.provide(Models, {
      describe(alias) {
        return { alias, contextTokens: 4096, maxOutputTokens: 256, supportsTools: false };
      },
      async generate(request) {
        requests.push(request);
        return { text: '收到', toolCalls: [], finishReason: 'stop', usage: {} };
      },
    });
  },
});
const host = {
  log() {},
  async reply(_handle, body) {
    deliveries.push(body.text);
    return { ok: true, messageId: `reply-${deliveries.length}`, msgSeq: 1 };
  },
};
let sequence = 0;
function event(content, scope, identity) {
  sequence += 1;
  const common = {
    eventId: `event-${sequence}`, messageId: `message-${sequence}`, seq: sequence,
    content, raw: {},
  };
  return scope === 'group'
    ? { ...common, kind: 'group', eventType: 'GROUP_AT_MESSAGE_CREATE',
        groupOpenid: identity, senderId: 'member-1', senderIdSource: 'member_openid' }
    : { ...common, kind: 'c2c', eventType: 'C2C_MESSAGE_CREATE',
        userOpenid: identity, senderId: identity, senderIdSource: 'user_openid' };
}
function dispatch(app, content, scope, identity) {
  const incoming = event(content, scope, identity);
  return app.dispatch({ event: incoming, botId: 'bot-1', host,
    reply: { handleId: `handle-${sequence}`, expiresAt: Date.now() + 120_000,
      acceptBefore: Date.now() + 60_000, remaining: 5 } });
}
async function waitFor(count) {
  const deadline = Date.now() + 2_000;
  while (deliveries.length < count) {
    if (Date.now() > deadline) throw new Error('等待 Agent 回复超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const app = new Application();
try {
  app.add(createCoreModule());
  app.add(policyModule, { allowedGroups: ['group-a', 'group-b'], allowC2c: true,
    enabledTools: [] });
  app.add(personaModule, personaConfig);
  app.add(fakeModels);
  app.add(toolsModule);
  app.add(engineModule);
  app.add(runsModule, { enabled: true, dbPath: join(temp, 'agent.sqlite'),
    modelAlias: 'chat-default', systemPrompt: '基础规则', outputLimit: 64 });
  app.add(commandRouterModule);
  app.add(agentChatModule, { enabled: true });
  await app.start();

  assert.match((await dispatch(app, '/persona', 'group', 'group-a')).body.text, /群助手/);
  assert.match((await dispatch(app, '/persona', 'group', 'group-b')).body.text, /默认/);
  assert.match((await dispatch(app, '/persona', 'c2c', 'user-9')).body.text, /私聊助手/);
  assert.match((await dispatch(app, '/persona', 'group', 'group-c')).body.text, /没有查看/);
  assert.equal(requests.length, 0, '/persona 不应调用模型');

  assert.equal(await dispatch(app, '你好', 'group', 'group-a'), null);
  await waitFor(1);
  assert.deepEqual(requests[0].messages[0], {
    role: 'system', content: '基础规则\n\n群人设提示词',
  });
  assert.equal(await dispatch(app, '你好', 'group', 'group-b'), null);
  await waitFor(2);
  assert.deepEqual(requests[1].messages[0], {
    role: 'system', content: '基础规则\n\n默认人设提示词',
  });
  assert.equal(await dispatch(app, '你好', 'c2c', 'user-9'), null);
  await waitFor(3);
  assert.deepEqual(requests[2].messages[0], {
    role: 'system', content: '基础规则\n\n私聊人设提示词',
  });
  assert.equal(requests.length, 3);
  await app.stop();
  console.log('PERSONA OK');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
