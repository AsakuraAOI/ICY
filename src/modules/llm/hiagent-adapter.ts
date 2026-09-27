import { ModelFailure, type ModelRequest, type ModelTurn, type Models } from './contracts.js';
import { OpenAICompatibleModels, type OpenAICompatibleModelConfig } from './openai-compatible.js';

export interface HiAgentModelConfig extends OpenAICompatibleModelConfig {
  readonly provider?: 'openai' | 'hiagent';
  readonly maxPayloadBytes?: number;
  readonly maxTextChars?: number;
}

/** ICY Models adapter for the deployed HiAgent OpenAI surface. */
export class HiAgentAdapterModels implements Models {
  readonly #transport: OpenAICompatibleModels;
  readonly #hiagent: ReadonlyMap<string, HiAgentModelConfig>;
  readonly #note: (message: string) => void;

  constructor(configs: readonly HiAgentModelConfig[], env: NodeJS.ProcessEnv = process.env,
    note: (message: string) => void = () => {}) {
    this.#transport = new OpenAICompatibleModels(configs, env);
    this.#hiagent = new Map(configs.filter((config) => config.provider === 'hiagent')
      .map((config) => [config.alias, config]));
    this.#note = note;
    for (const config of this.#hiagent.values()) {
      const byteLimit = config.maxPayloadBytes ?? 180_000;
      const charLimit = config.maxTextChars ?? 1_400;
      if (!Number.isSafeInteger(byteLimit) || byteLimit < 8_000 || byteLimit > 800_000 ||
        !Number.isSafeInteger(charLimit) || charLimit < 100 || charLimit > 2_000) {
        throw new ModelFailure('invalid_request', `HiAgent 模型 ${config.alias} 的输入或回复上限无效`);
      }
    }
  }

  describe(alias: string) { return this.#transport.describe(alias); }

  async generate(request: ModelRequest): Promise<ModelTurn> {
    const config = this.#hiagent.get(request.modelAlias);
    if (config === undefined) return this.#transport.generate(request);
    const { messages, removed } = fitMessages(request, config.maxPayloadBytes ?? 180_000);
    if (removed > 0) this.#note(`HiAgent ${config.alias} 裁剪 ${removed} 条旧消息以适应请求字节预算`);
    const prepared = { ...request, messages };
    let turn: ModelTurn;
    try { turn = await this.#transport.generate(prepared); }
    catch (error) {
      // An explicit 429 is safe to retry once; a timeout/network error is ambiguous.
      if (!(error instanceof ModelFailure) || error.kind !== 'rate_limited' ||
        request.signal.aborted || request.deadline - Date.now() < 5_000) throw error;
      this.#note(`HiAgent ${config.alias} 限流，短暂等待后重试一次`);
      await waitForRetry(request.signal);
      turn = await this.#transport.generate(prepared);
    }
    if (turn.toolCalls.length > 0) return turn;
    const maxChars = config.maxTextChars ?? 1_400;
    const chars = Array.from(turn.text);
    if (chars.length <= maxChars) return turn;
    this.#note(`HiAgent ${config.alias} 的纯文本回复超过 ${maxChars} 字，已标记截断`);
    return { ...turn, text: `${chars.slice(0, maxChars - 7).join('')}…（已截断）` };
  }
}

function waitForRetry(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new ModelFailure('cancelled', '模型请求已取消'));
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new ModelFailure('cancelled', '模型请求已取消'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, 750);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function fitMessages(request: ModelRequest, limit: number): {
  messages: ModelRequest['messages']; removed: number;
} {
  const messages = [...request.messages];
  let removed = 0;
  const bytes = (): number => Buffer.byteLength(JSON.stringify({
    model: request.modelAlias, messages, tools: request.toolSchemas ?? [],
    max_tokens: request.outputLimit,
  }), 'utf8');
  while (bytes() > limit) {
    const start = messages.findIndex((message) => message.role !== 'system');
    const lastUser = messages.findLastIndex((message) => message.role === 'user');
    const nextUser = messages.findIndex((message, index) => index > start && message.role === 'user');
    // Keep the newest user turn and all following tool calls/results intact.
    if (start < 0 || nextUser < 0 || nextUser > lastUser) {
      throw new ModelFailure('context_overflow', '当前消息和工具定义超过 HiAgent 输入预算，请缩短问题或工具输出');
    }
    messages.splice(start, nextUser - start);
    removed += nextUser - start;
  }
  return { messages, removed };
}
