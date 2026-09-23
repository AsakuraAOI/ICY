import {
  ModelFailure,
  type ModelAssistantToolCall,
  type ModelDescription,
  type ModelMessage,
  type ModelRequest,
  type ModelToolSchema,
  type ModelTurn,
  type ModelUsage,
  type Models,
} from './contracts.js';

export interface OpenAICompatibleModelConfig {
  readonly alias: string;
  readonly model: string;
  readonly baseUrl: string;
  /** 只保存环境变量名；密钥本身从不进入模块配置。 */
  readonly apiKeyEnv?: string;
  readonly contextTokens: number;
  readonly maxOutputTokens: number;
  readonly supportsTools?: boolean;
  readonly timeoutMs?: number;
  readonly outputTokenParameter?: 'max_completion_tokens' | 'max_tokens';
}

const API_KEY_ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 使用 OpenAI Chat Completions 格式的 HTTP 适配器；不依赖供应商 SDK。 */
export class OpenAICompatibleModels implements Models {
  readonly #models: ReadonlyMap<string, OpenAICompatibleModelConfig>;
  readonly #env: NodeJS.ProcessEnv;

  constructor(configs: readonly OpenAICompatibleModelConfig[], env: NodeJS.ProcessEnv = process.env) {
    const models = new Map<string, OpenAICompatibleModelConfig>();
    for (const config of configs) {
      validateModelConfig(config);
      if (models.has(config.alias)) {
        throw new ModelFailure('invalid_request', `重复的模型别名：${config.alias}`);
      }
      models.set(config.alias, Object.freeze({ ...config }));
    }
    this.#models = models;
    this.#env = env;
  }

  describe(alias: string): ModelDescription {
    const config = this.#models.get(alias);
    if (config === undefined) {
      throw new ModelFailure('invalid_request', `未配置模型别名：${alias}`);
    }
    return {
      alias: config.alias,
      contextTokens: config.contextTokens,
      maxOutputTokens: config.maxOutputTokens,
      supportsTools: config.supportsTools ?? false,
    };
  }

  async generate(request: ModelRequest): Promise<ModelTurn> {
    const config = this.#models.get(request.modelAlias);
    if (config === undefined) {
      throw new ModelFailure('invalid_request', `未配置模型别名：${request.modelAlias}`);
    }
    if (!Number.isSafeInteger(request.outputLimit) || request.outputLimit <= 0) {
      throw new ModelFailure('invalid_request', 'outputLimit 必须是正整数');
    }
    if (request.outputLimit > config.maxOutputTokens) {
      throw new ModelFailure(
        'invalid_request',
        `outputLimit 超过模型配置上限 ${config.maxOutputTokens}`,
      );
    }
    if (request.messages.length === 0) {
      throw new ModelFailure('invalid_request', 'messages 不能为空');
    }

    const toolSchemas = request.toolSchemas ?? [];
    if (toolSchemas.length > 0 && !(config.supportsTools ?? false)) {
      throw new ModelFailure('invalid_request', `模型 ${config.alias} 不支持工具调用`);
    }

    const apiKey = readApiKey(config, this.#env);
    const endpoint = completionEndpoint(config.baseUrl);
    const remainingMs = Math.min(
      config.timeoutMs ?? 30_000,
      request.deadline - Date.now(),
    );
    if (remainingMs <= 0) throw new ModelFailure('timeout', '模型请求截止时间已到');
    if (request.signal.aborted) throw new ModelFailure('cancelled', '模型请求已取消');

    const controller = new AbortController();
    const onCallerAbort = (): void => controller.abort(request.signal.reason);
    request.signal.addEventListener('abort', onCallerAbort, { once: true });
    if (request.signal.aborted) onCallerAbort();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('model request deadline exceeded'));
    }, remainingMs);

    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (apiKey !== undefined) headers.authorization = `Bearer ${apiKey}`;

      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: config.model,
          messages: request.messages.map(toProviderMessage),
          [config.outputTokenParameter ?? 'max_completion_tokens']: request.outputLimit,
          ...(toolSchemas.length === 0 ? {} : { tools: toolSchemas.map(toProviderTool) }),
        }),
        signal: controller.signal,
      });

      const requestId = response.headers.get('x-request-id') ?? undefined;
      if (!response.ok) {
        const kind = failureForStatus(response.status);
        throw new ModelFailure(
          kind,
          `模型接口返回 HTTP ${response.status}`,
          requestId,
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new ModelFailure('invalid_output', '模型接口返回了无效 JSON', requestId);
      }
      return parseTurn(payload, requestId);
    } catch (error) {
      if (error instanceof ModelFailure) throw error;
      if (request.signal.aborted) throw new ModelFailure('cancelled', '模型请求已取消');
      if (timedOut || controller.signal.aborted) {
        throw new ModelFailure('timeout', '模型请求超时');
      }
      throw new ModelFailure('unavailable', '模型服务暂时不可用');
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', onCallerAbort);
    }
  }
}

function validateModelConfig(config: OpenAICompatibleModelConfig): void {
  if (config.alias.trim() === '' || config.model.trim() === '') {
    throw new ModelFailure('invalid_request', '模型 alias 与 model 必须是非空字符串');
  }
  if (!Number.isSafeInteger(config.contextTokens) || config.contextTokens <= 0) {
    throw new ModelFailure('invalid_request', `模型 ${config.alias} 的 contextTokens 必须是正整数`);
  }
  if (!Number.isSafeInteger(config.maxOutputTokens) || config.maxOutputTokens <= 0) {
    throw new ModelFailure('invalid_request', `模型 ${config.alias} 的 maxOutputTokens 必须是正整数`);
  }
  if (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0)) {
    throw new ModelFailure('invalid_request', `模型 ${config.alias} 的 timeoutMs 必须是正整数`);
  }
  if (
    config.outputTokenParameter !== undefined &&
    config.outputTokenParameter !== 'max_completion_tokens' &&
    config.outputTokenParameter !== 'max_tokens'
  ) {
    throw new ModelFailure('invalid_request', `模型 ${config.alias} 的 outputTokenParameter 不受支持`);
  }
  if (config.apiKeyEnv !== undefined && !API_KEY_ENV_PATTERN.test(config.apiKeyEnv)) {
    throw new ModelFailure('invalid_request', `模型 ${config.alias} 的 apiKeyEnv 不是有效环境变量名`);
  }
  const endpoint = completionEndpoint(config.baseUrl);
  if (
    config.apiKeyEnv !== undefined &&
    endpoint.protocol === 'http:' &&
    !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
  ) {
    throw new ModelFailure('invalid_request', `模型 ${config.alias} 配置了凭证时必须使用 HTTPS`);
  }
}

function readApiKey(
  config: OpenAICompatibleModelConfig,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (config.apiKeyEnv === undefined) return undefined;
  const key = env[config.apiKeyEnv]?.trim();
  if (key === undefined || key === '') {
    throw new ModelFailure('auth', `缺少模型凭证环境变量 ${config.apiKeyEnv}`);
  }
  return key;
}

function completionEndpoint(baseUrl: string): URL {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new ModelFailure('invalid_request', '模型 baseUrl 必须是有效 URL');
  }
  if ((base.protocol !== 'https:' && base.protocol !== 'http:') || base.search !== '' || base.hash !== '') {
    throw new ModelFailure('invalid_request', '模型 baseUrl 只允许 HTTP(S) URL，且不能含 query 或 fragment');
  }
  if (base.username !== '' || base.password !== '') {
    throw new ModelFailure('invalid_request', '模型凭证不能写在 baseUrl 中，请使用 apiKeyEnv');
  }
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  return new URL('chat/completions', base);
}

function toProviderMessage(message: ModelMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  }
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: message.content,
      ...(message.toolCalls === undefined
        ? {}
        : {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.callId,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            })),
          }),
    };
  }
  return { role: message.role, content: message.content };
}

function toProviderTool(tool: ModelToolSchema): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function parseTurn(payload: unknown, requestId?: string): ModelTurn {
  const root = asRecord(payload);
  const choices = root === null ? null : root.choices;
  const first = Array.isArray(choices) ? asRecord(choices[0]) : null;
  const message = first === null ? null : asRecord(first.message);
  if (first === null || message === null) {
    throw new ModelFailure('invalid_output', '模型响应缺少 choices[0].message', requestId);
  }

  const text = typeof message.content === 'string' ? message.content : '';
  const toolCalls = parseToolCalls(message.tool_calls, requestId);
  const finishReason = first.finish_reason;
  const usage = parseUsage(root?.usage);
  const id = typeof root?.id === 'string' ? root.id : requestId;

  let normalizedReason: ModelTurn['finishReason'] = 'other';
  if (finishReason === 'stop') normalizedReason = 'stop';
  else if (finishReason === 'tool_calls') normalizedReason = 'tool_calls';
  else if (finishReason === 'length') normalizedReason = 'length';

  if (text.trim() === '' && toolCalls.length === 0) {
    throw new ModelFailure('invalid_output', '模型返回了空文本且没有工具调用', id);
  }

  return {
    text,
    toolCalls,
    finishReason: normalizedReason,
    usage,
    ...(id === undefined ? {} : { requestId: id }),
  };
}

function parseToolCalls(value: unknown, requestId?: string): ModelAssistantToolCall[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ModelFailure('invalid_output', '模型 tool_calls 必须是数组', requestId);
  }

  return value.map((item, index) => {
    const call = asRecord(item);
    const fn = call === null ? null : asRecord(call.function);
    if (
      call === null ||
      typeof call.id !== 'string' ||
      call.id === '' ||
      fn === null ||
      typeof fn.name !== 'string' ||
      typeof fn.arguments !== 'string'
    ) {
      throw new ModelFailure('invalid_output', `模型工具调用 ${index + 1} 不完整`, requestId);
    }

    let args: unknown;
    try {
      args = JSON.parse(fn.arguments);
    } catch {
      throw new ModelFailure('invalid_output', `模型工具调用 ${index + 1} 的参数不是有效 JSON`, requestId);
    }
    const record = asRecord(args);
    if (record === null) {
      throw new ModelFailure('invalid_output', `模型工具调用 ${index + 1} 的参数必须是 JSON 对象`, requestId);
    }
    return { callId: call.id, name: fn.name, arguments: record };
  });
}

function parseUsage(value: unknown): ModelUsage {
  const usage = asRecord(value);
  if (usage === null) return {};
  const inputTokens = positiveTokenCount(usage.prompt_tokens);
  const outputTokens = positiveTokenCount(usage.completion_tokens);
  const totalTokens = positiveTokenCount(usage.total_tokens);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

function positiveTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function failureForStatus(status: number): ModelFailure['kind'] {
  if (status === 401 || status === 403) return 'auth';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 413) return 'context_overflow';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'unavailable';
  return 'invalid_request';
}
