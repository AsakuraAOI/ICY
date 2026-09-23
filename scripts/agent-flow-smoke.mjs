#!/usr/bin/env node
/** Agent 应用链路：直接命令、权限、工具循环、取消、重置与 SQLite 恢复。 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { Application, createCoreModule, defineModule } from '../dist/app/index.js';
import commandRouterModule from '../dist/modules/agent-chat/commands.js';
import agentChatModule from '../dist/modules/agent-chat/module.js';
import runsModule from '../dist/modules/agent-runtime/runs.js';
import engineModule from '../dist/modules/agent/engine-module.js';
import { actorFromEvent } from '../dist/modules/agent/identity.js';
import policyModule from '../dist/modules/agent/policy.js';
import basicToolsModule from '../dist/modules/agent/tools-basic.js';
import toolsModule from '../dist/modules/agent/tools-module.js';
import { ToolFailure, ToolRegistry } from '../dist/modules/agent/tools.js';
import { Models } from '../dist/modules/llm/contracts.js';

const temp = mkdtempSync(join(tmpdir(), 'icy-agent-flow-'));
const dbPath = join(temp, 'agent.sqlite');
const calls = [];
const deliveries = [];
let mode = 'tool';
let aborted = false;
let waiting = false;
let rejectReply = false;

const fakeModels = defineModule({
  name: 'models', version: '1.0.0',
  setup(ctx) {
    ctx.provide(Models, {
      describe(alias) {
        return { alias, contextTokens: 4096, maxOutputTokens: 256, supportsTools: true };
      },
      async generate(input) {
        calls.push(input);
        if (mode === 'wait') {
          waiting = true;
          return new Promise((_resolve, reject) => {
            if (input.signal.aborted) { aborted = true; reject(new Error('cancelled')); return; }
            input.signal.addEventListener('abort', () => {
              aborted = true;
              reject(new Error('cancelled'));
            }, { once: true });
          });
        }
        if (mode === 'text') {
          return { text: '新会话答复', toolCalls: [], finishReason: 'stop', usage: {} };
        }
        if (input.messages.some((item) => item.role === 'tool')) {
          return { text: '计算结果为 7', toolCalls: [], finishReason: 'stop', usage: {} };
        }
        assert.deepEqual(input.toolSchemas.map((item) => item.name), ['calculator_evaluate']);
        return mode === 'forged'
          ? {
              text: '', finishReason: 'tool_calls', usage: {},
              toolCalls: [{ callId: 'forged-1', name: 'clock_now', arguments: {} }],
            }
          : {
              text: '', finishReason: 'tool_calls', usage: {},
              toolCalls: [{ callId: 'calc-1', name: 'calculator_evaluate',
                arguments: { expression: '1+2*3' } }],
            };
      },
    });
  },
});

function createApp(runsOverrides = {}) {
  const app = new Application();
  app.add(createCoreModule());
  app.add(policyModule, { allowedGroups: ['g1'], enabledTools: ['calculator_evaluate'] });
  app.add(fakeModels);
  app.add(toolsModule);
  app.add(basicToolsModule);
  app.add(engineModule);
  app.add(runsModule, { enabled: true, dbPath, modelAlias: 'chat-default', outputLimit: 64,
    ...runsOverrides });
  app.add(commandRouterModule);
  app.add(agentChatModule, { enabled: true });
  return app;
}

function makeEvent(content, id, groupOpenid = 'g1', senderIdSource = 'member_openid', senderId = 'user-1') {
  return {
    kind: 'group', eventType: 'GROUP_AT_MESSAGE_CREATE', eventId: `event-${id}`, seq: 1,
    messageId: `message-${id}`, groupOpenid, senderId, senderIdSource,
    content, raw: {},
  };
}

const host = {
  log() {},
  async reply(_handle, body) {
    deliveries.push(body.text);
    if (rejectReply) return { ok: false, reason: 'mock_rejected', detail: 'test' };
    return { ok: true, messageId: `reply-${deliveries.length}`, msgSeq: 1 };
  },
};

async function dispatch(app, content, id, group = 'g1', source = 'member_openid', sender = 'user-1') {
  return app.dispatch({
    event: makeEvent(content, id, group, source, sender), botId: 'bot-1', host,
    reply: {
      handleId: `handle-${id}`, expiresAt: Date.now() + 120_000,
      acceptBefore: Date.now() + 60_000, remaining: 5,
    },
  });
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 2_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

try {
  const app = createApp();
  await app.start();

  assert.match((await dispatch(app, '/help', 'help')).body.text, /\/cancel/);
  assert.equal((await dispatch(app, '/calc 1+2*3', 'direct-calc')).body.text, '结果：7');
  assert.match((await dispatch(app, '/time UTC', 'direct-time')).body.text, /没有执行此命令的权限/);
  assert.match((await dispatch(app, '/status', 'status-empty')).body.text, /还没有任务/);
  assert.equal(calls.length, 0, '直接命令不应调用模型');
  assert.match((await dispatch(app, '/unknown', 'unknown')).body.text, /未知命令/);
  assert.equal(calls.length, 0, '未知斜杠命令不应进入 Agent');

  assert.equal(await dispatch(app, '1+2*3 是多少', 'calc'), null);
  await waitFor(() => deliveries.length === 1, '工具循环回复');
  assert.equal(deliveries[0], '计算结果为 7');
  assert.equal(calls.length, 2);
  assert.match((await dispatch(app, '/status', 'status-complete')).body.text, /已完成/);
  assert.equal(await dispatch(app, '1+2*3 是多少', 'calc'), null);
  assert.equal(calls.length, 2, '重复事件不得重新运行模型');

  mode = 'forged';
  assert.equal(await dispatch(app, '读一下时间', 'forged'), null);
  await waitFor(() => deliveries.length === 2, '非法工具拒绝回复');
  assert.match((await dispatch(app, '/status', 'status-failed')).body.text, /失败/);
  assert.match(deliveries[1], /发生错误/);

  const denied = await dispatch(app, '/status', 'denied-command', 'g2');
  assert.match(denied.body.text, /没有执行/);
  const deniedChat = await dispatch(app, '你好', 'denied-chat', 'g2');
  assert.match(deniedChat.body.text, /没有使用 Agent 的权限/);
  assert.equal(calls.length, 3, '越权消息不调用模型');
  const untrusted = await dispatch(app, '/status', 'fallback-id', 'g1', 'author_id');
  assert.match(untrusted.body.text, /无法确认发送者身份/);

  mode = 'wait';
  assert.equal(await dispatch(app, '等待中的请求', 'wait'), null);
  await waitFor(() => waiting, '模型开始等待');
  const cancelled = await dispatch(app, '/cancel', 'cancel');
  assert.match(cancelled.body.text, /已取消/);
  await waitFor(() => aborted, '模型收到取消信号');
  assert.match((await dispatch(app, '/status', 'status-cancelled')).body.text, /已取消/);

  assert.match((await dispatch(app, '/reset', 'reset')).body.text, /已清空/);
  assert.match((await dispatch(app, '/status', 'status-reset')).body.text, /还没有任务/);
  mode = 'text';
  assert.equal(await dispatch(app, '新问题', 'fresh'), null);
  await waitFor(() => deliveries.length === 3, '新会话回复');
  assert.equal(deliveries[2], '新会话答复');
  const lastRequest = calls.at(-1);
  assert.deepEqual(lastRequest.messages.filter((item) => item.role === 'user').map((item) => item.content), ['新问题']);

  rejectReply = true;
  assert.equal(await dispatch(app, '第二位用户的问题', 'delivery-rejected', 'g1', 'member_openid', 'user-2'), null);
  await waitFor(() => deliveries.length === 4, '被拒绝的回复');
  await waitFor(async () => (await dispatch(app, '/status', 'failed-delivery-poll', 'g1', 'member_openid', 'user-2'))
    .body.text.includes('回复状态：failed'), '回复失败状态');
  const failedDelivery = await dispatch(app, '/status', 'failed-delivery-status', 'g1', 'member_openid', 'user-2');
  assert.match(failedDelivery.body.text, /回复状态：failed/);
  assert.match(failedDelivery.body.text, /新会话答复/);
  rejectReply = false;

  const actor = actorFromEvent(makeEvent('x', 'actor'), 'bot-1');
  assert(actor !== null);
  let allowed = true;
  const changingPolicy = {
    decide: () => ({ allowed, reason: allowed ? 'allowed' : 'disabled_tool' }),
  };
  const registry = new ToolRegistry(changingPolicy);
  registry.register({
    name: 'read_sample', version: '1', description: '读样本',
    inputSchema: { type: 'object', properties: {} }, effect: 'read',
    requiredAction: 'tools.clock_now', resource: () => ({ kind: 'tool' }),
    timeoutMs: 1000, maxOutputBytes: 1000, execute: () => ({ secret: 'no' }),
  });
  assert.equal(registry.schemasFor(actor).length, 1);
  allowed = false;
  await assert.rejects(registry.execute('read_sample', {}, {
    actor, sessionKey: actor.sessionKey, runId: 'revoked',
    deadline: Date.now() + 1000, signal: new AbortController().signal,
  }), (error) => error instanceof ToolFailure && error.kind === 'forbidden');

  await app.stop();
  const restarted = createApp();
  await restarted.start();
  assert.match((await dispatch(restarted, '/status', 'after-restart')).body.text, /已完成/);
  waiting = false;
  mode = 'wait';
  assert.equal(await dispatch(restarted, '重启前的任务', 'before-shutdown'), null);
  await waitFor(() => waiting, '重启前模型开始等待');
  await restarted.stop();
  const interruptedApp = createApp();
  await interruptedApp.start();
  assert.match((await dispatch(interruptedApp, '/status', 'after-interrupt')).body.text, /服务中断/);
  await interruptedApp.stop();
  mode = 'text';
  const quotaApp = createApp({ maxRunsPerSession24h: 1 });
  await quotaApp.start();
  assert.equal(await dispatch(quotaApp, '限额测试一', 'quota-first', 'g1', 'member_openid', 'user-3'), null);
  await waitFor(() => deliveries.length === 5, '首次额度内回复');
  const callsBeforeQuota = calls.length;
  const quotaReply = await dispatch(quotaApp, '限额测试二', 'quota-second', 'g1', 'member_openid', 'user-3');
  assert.match(quotaReply.body.text, /额度已用完/);
  assert.equal(calls.length, callsBeforeQuota);
  await quotaApp.stop();
  process.stdout.write('AGENT FLOW SMOKE OK\n');
} finally {
  const safeRoot = resolve(tmpdir()) + sep;
  if (resolve(temp).startsWith(safeRoot)) rmSync(temp, { recursive: true, force: true });
}
