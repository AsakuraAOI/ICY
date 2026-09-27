#!/usr/bin/env node
/** HiAgent OpenAI surface: preserve tool calls, trim history, retry only explicit 429. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { HiAgentAdapterModels } from '../dist/modules/llm/hiagent-adapter.js';
import { ModelFailure } from '../dist/modules/llm/contracts.js';

let mode = 'tool';
let hits = 0;
let lastBody;
const server = createServer(async (request, response) => {
  hits++;
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  lastBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  response.setHeader('content-type', 'application/json');
  if (mode === 'rate' && hits === 1) {
    response.writeHead(429);
    response.end(JSON.stringify({ error: { code: 'rate_limit' } }));
    return;
  }
  if (mode === 'stall') {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const message = mode === 'tool'
    ? { role: 'assistant', content: null, tool_calls: [{ id: 'toolu-1', type: 'function', function: { name: 'plugin_create', arguments: '{"name":"tiny"}' } }] }
    : { role: 'assistant', content: '字'.repeat(130) };
  response.end(JSON.stringify({ choices: [{ message, finish_reason: mode === 'tool' ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert(address && typeof address !== 'string');
const baseConfig = { alias: 'hiagent-chat', provider: 'hiagent', model: 'mock',
  baseUrl: `http://127.0.0.1:${address.port}/v1`, contextTokens: 32000,
  maxOutputTokens: 512, supportsTools: true, maxPayloadBytes: 8000, maxTextChars: 100,
  timeoutMs: 1000, outputTokenParameter: 'max_tokens' };
const request = { modelAlias: 'hiagent-chat', outputLimit: 512, deadline: Date.now() + 15_000,
  signal: new AbortController().signal,
  messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'old '.repeat(2200) },
    { role: 'assistant', content: 'old answer' }, { role: 'user', content: 'new task' }],
  toolSchemas: [{ name: 'plugin_create', description: 'create', parameters: { type: 'object', properties: { name: { type: 'string' } } } }],
};
try {
  const adapter = new HiAgentAdapterModels([baseConfig]);
  const turn = await adapter.generate(request);
  assert.equal(turn.finishReason, 'tool_calls');
  assert.deepEqual(turn.toolCalls[0], { callId: 'toolu-1', name: 'plugin_create', arguments: { name: 'tiny' } });
  assert.deepEqual(lastBody.messages.map((message) => message.role), ['system', 'user']);
  assert.equal(lastBody.messages[1].content, 'new task');
  assert.equal(lastBody.max_tokens, 512);

  mode = 'rate'; hits = 0;
  const recovered = await adapter.generate({ ...request, messages: [{ role: 'user', content: 'hi' }], toolSchemas: [] });
  assert.equal(hits, 2);
  assert.match(recovered.text, /已截断/);
  assert.ok(Array.from(recovered.text).length <= 100);

  mode = 'stall'; hits = 0;
  const short = new HiAgentAdapterModels([{ ...baseConfig, timeoutMs: 50 }]);
  await assert.rejects(short.generate({ ...request, messages: [{ role: 'user', content: 'hi' }], toolSchemas: [] }),
    (error) => error instanceof ModelFailure && error.kind === 'timeout');
  assert.equal(hits, 1, '超时后不得重放有歧义的请求');
  process.stdout.write('HIAGENT_SMOKE_OK\n');
} finally {
  server.close();
}
