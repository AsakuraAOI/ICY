#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Application, defineModule } from '../dist/app/index.js';
import policyModule from '../dist/modules/agent/policy.js';
import toolsModule from '../dist/modules/agent/tools-module.js';
import { Tools, ToolFailure } from '../dist/modules/agent/tools.js';
import engineModule from '../dist/modules/agent/engine-module.js';
import { Agents } from '../dist/modules/agent/engine.js';
import { Models } from '../dist/modules/llm/contracts.js';
import writerModule from '../dist/modules/plugin-writer/module.js';

const root = await mkdtemp(join(tmpdir(), 'icy-plugin-writer-'));
const admin = { botId: 'bot', scope: 'c2c', actorId: 'admin', sessionKey: 'admin-session' };
const ordinary = { ...admin, actorId: 'ordinary', sessionKey: 'ordinary-session' };
const source = 'export default async function run(input) { return { text: String(input.text).trim() }; }';
const createArgs = {
  name: 'trim_text', description: '修剪文本两端空格', source,
  testsJson: JSON.stringify([{ input: { text: ' hi ' }, expected: { text: 'hi' } }]),
  inputJson: '{"text":" hello "}',
};
let modelCalls = 0;
const fakeModels = defineModule({
  name: 'models', version: '1',
  setup(ctx) {
    ctx.provide(Models, {
      describe(alias) { return { alias, contextTokens: 4096, maxOutputTokens: 256, supportsTools: true }; },
      async generate(request) {
        const names = request.toolSchemas.map((tool) => tool.name);
        assert.deepEqual(names, ['plugin_list', 'plugin_create', 'plugin_run']);
        const previous = request.messages.filter((message) => message.role === 'tool');
        if (modelCalls === 0) {
          modelCalls++;
          return { text: '', toolCalls: [{ callId: 'list', name: 'plugin_list', arguments: {} }], finishReason: 'tool_calls', usage: {} };
        }
        if (modelCalls === 1) {
          assert.deepEqual(JSON.parse(previous.at(-1).content), { plugins: [] });
          modelCalls++;
          return { text: '', toolCalls: [{ callId: 'create', name: 'plugin_create', arguments: createArgs }], finishReason: 'tool_calls', usage: {} };
        }
        if (modelCalls === 2) {
          assert.deepEqual(JSON.parse(previous.at(-1).content),
            { ok: true, name: 'trim_text', tests: 1, result: { text: 'hello' } });
          modelCalls++;
          return { text: '处理结果：hello', toolCalls: [], finishReason: 'stop', usage: {} };
        }
        throw new Error('模型调用次数超出本次闭环需要');
      },
    });
  },
});

function makeApp() {
  const app = new Application();
  app.add(policyModule, { allowC2c: true, pluginAdmins: ['admin'],
    enabledTools: ['plugin_list', 'plugin_create', 'plugin_run'] });
  app.add(toolsModule);
  app.add(writerModule, { enabled: true, dataDir: root });
  app.add(fakeModels);
  app.add(engineModule);
  return app;
}

try {
  const app = makeApp();
  await app.start();
  const tools = app.services.require(Tools);
  assert.deepEqual(tools.schemasFor(ordinary), []);
  await assert.rejects(tools.execute('plugin_create', createArgs, {
    actor: ordinary, sessionKey: ordinary.sessionKey, runId: 'unauthorized',
    deadline: Date.now() + 30_000, signal: new AbortController().signal,
  }), (error) => error instanceof ToolFailure && error.kind === 'forbidden');

  const result = await app.services.require(Agents).run({
    actor: admin, sessionKey: admin.sessionKey, runId: 'agent-loop', modelAlias: 'mock',
    messages: [{ role: 'user', content: '写一个去除文本两侧空格的插件并运行' }],
    outputLimit: 256, deadline: Date.now() + 40_000,
    signal: new AbortController().signal, maxModelCalls: 3, maxToolCalls: 2,
  });
  assert.equal(result.text, '处理结果：hello');
  assert.deepEqual(result.toolNames, ['plugin_list', 'plugin_create']);

  const context = { actor: admin, sessionKey: admin.sessionKey, runId: 'checks',
    deadline: Date.now() + 20_000, signal: new AbortController().signal };
  const invalid = JSON.parse(await tools.execute('plugin_create', {
    ...createArgs, name: 'broken', source: 'export default function run( {' }, context));
  assert.equal(invalid.ok, false);
  const hung = JSON.parse(await tools.execute('plugin_create', {
    ...createArgs, name: 'hang', source: 'export default function run() { while (true) {} }',
    testsJson: '[{"input":{},"expected":{}}]',
  }, context));
  assert.match(hung.error, /超时/);
  const outside = join(root, 'outside.txt');
  await writeFile(outside, 'private');
  const restricted = JSON.parse(await tools.execute('plugin_create', {
    ...createArgs, name: 'restricted',
    source: `import { readFileSync } from 'node:fs'; export default function run() { try { readFileSync(${JSON.stringify(outside)}); return { blocked: false }; } catch (error) { return { blocked: error.code === 'ERR_ACCESS_DENIED' }; } }`,
    testsJson: '[{"input":{},"expected":{"blocked":true}}]',
  }, context));
  assert.equal(restricted.ok, true);
  const existing = JSON.parse(await tools.execute('plugin_create', createArgs, context));
  assert.equal(existing.reused, true);
  assert.deepEqual(existing.result, { text: 'hello' });
  const listed = JSON.parse(await tools.execute('plugin_list', {}, context));
  assert.deepEqual(listed.plugins.map((plugin) => plugin.name), ['restricted', 'trim_text']);
  await app.stop();

  const restarted = makeApp();
  await restarted.start();
  const persisted = JSON.parse(await restarted.services.require(Tools).execute('plugin_run',
    { name: 'trim_text', inputJson: '{"text":" again "}' }, context));
  assert.deepEqual(persisted, { ok: true, result: { text: 'again' } });
  await restarted.stop();
  process.stdout.write('PLUGIN_WRITER_SMOKE_OK\n');
} finally {
  await rm(root, { recursive: true, force: true });
}
