#!/usr/bin/env node
/** A1 模型适配器契约自检：HTTP 格式、错误分类与取消。 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { ModelFailure } from '../dist/modules/llm/contracts.js';
import { OpenAICompatibleModels } from '../dist/modules/llm/openai-compatible.js';

let mode = 'text';
let lastPath = '';
let lastBody = null;
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  lastPath = request.url ?? '';
  lastBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));

  response.setHeader('content-type', 'application/json');
  response.setHeader('x-request-id', 'mock-request-1');
  if (mode === 'rate') {
    response.writeHead(429);
    response.end(JSON.stringify({ error: { code: 'rate_limit' } }));
    return;
  }

  const message =
    mode === 'tool'
      ? {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'clock_now', arguments: '{}' },
            },
          ],
        }
      : { role: 'assistant', content: '模型答复' };
  response.end(
    JSON.stringify({
      id: 'completion-1',
      choices: [
        { message, finish_reason: mode === 'tool' ? 'tool_calls' : 'stop' },
      ],
      usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
    }),
  );
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert(address !== null && typeof address !== 'string');

const modelConfig = {
  alias: 'chat-default',
  model: 'mock-model',
  baseUrl: `http://127.0.0.1:${address.port}/v1`,
  contextTokens: 4096,
  maxOutputTokens: 128,
  supportsTools: true,
};
const models = new OpenAICompatibleModels([modelConfig]);
const request = {
  modelAlias: 'chat-default',
  messages: [{ role: 'user', content: '你好' }],
  outputLimit: 64,
  deadline: Date.now() + 5_000,
  signal: new AbortController().signal,
};

try {
  const textTurn = await models.generate(request);
  assert.equal(textTurn.text, '模型答复');
  assert.equal(textTurn.usage.totalTokens, 9);
  assert.equal(lastPath, '/v1/chat/completions');
  assert.equal(lastBody.model, 'mock-model');
  assert.equal(lastBody.max_completion_tokens, 64);
  assert.equal(lastBody.messages[0].content, '你好');

  mode = 'tool';
  const toolTurn = await models.generate({
    ...request,
    toolSchemas: [{ name: 'clock_now', description: '当前时间', parameters: { type: 'object' } }],
  });
  assert.equal(toolTurn.finishReason, 'tool_calls');
  assert.deepEqual(toolTurn.toolCalls[0], {
    callId: 'call-1', name: 'clock_now', arguments: {},
  });
  assert.equal(lastBody.tools[0].function.name, 'clock_now');

  mode = 'rate';
  await assert.rejects(models.generate(request), (error) =>
    error instanceof ModelFailure && error.kind === 'rate_limited');

  const withoutKey = new OpenAICompatibleModels(
    [{ ...modelConfig, apiKeyEnv: 'ICY_AGENT_SMOKE_API_KEY' }],
    {},
  );
  await assert.rejects(withoutKey.generate(request), (error) =>
    error instanceof ModelFailure && error.kind === 'auth');

  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    models.generate({ ...request, signal: cancelled.signal }),
    (error) => error instanceof ModelFailure && error.kind === 'cancelled',
  );

  process.stdout.write('AGENT SMOKE OK\n');
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
