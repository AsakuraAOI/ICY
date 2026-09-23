import { defineService } from '../../app/runtime/contracts.js';
import type { ModelToolSchema } from '../llm/contracts.js';
import type { ActorContext } from './identity.js';
import type { PolicyAction, PolicyResource, PolicyService } from './policy.js';

export type ToolFailureKind =
  | 'unknown_tool'
  | 'invalid_arguments'
  | 'forbidden'
  | 'cancelled'
  | 'timeout'
  | 'output_too_large'
  | 'execution_failed';

export class ToolFailure extends Error {
  readonly kind: ToolFailureKind;

  constructor(kind: ToolFailureKind, message: string) {
    super(message);
    this.name = 'ToolFailure';
    this.kind = kind;
  }
}

export interface ToolContext {
  readonly actor: ActorContext;
  readonly sessionKey: string;
  readonly runId: string;
  readonly deadline: number;
  readonly signal: AbortSignal;
}

export interface ToolDefinition {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly effect: 'read';
  readonly requiredAction: PolicyAction;
  resource(args: Readonly<Record<string, unknown>>, actor: ActorContext): PolicyResource;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  execute(args: Readonly<Record<string, unknown>>, ctx: ToolContext): unknown | Promise<unknown>;
}

export interface ToolExecutor {
  register(tool: ToolDefinition): void;
  freeze(): void;
  schemasFor(actor: ActorContext): readonly ModelToolSchema[];
  execute(name: string, args: unknown, ctx: ToolContext): Promise<string>;
}

export const Tools = defineService<ToolExecutor>('agent.tools');

export class ToolRegistry implements ToolExecutor {
  readonly #tools = new Map<string, ToolDefinition>();
  readonly #policy: PolicyService;
  #frozen = false;

  constructor(policy: PolicyService) { this.#policy = policy; }

  register(tool: ToolDefinition): void {
    if (this.#frozen) throw new ToolFailure('execution_failed', '工具注册表已冻结');
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(tool.name)) {
      throw new ToolFailure('invalid_arguments', `工具名不符合模型函数命名规则：${tool.name}`);
    }
    if (this.#tools.has(tool.name)) {
      throw new ToolFailure('invalid_arguments', `工具名重复：${tool.name}`);
    }
    if (tool.effect !== 'read') {
      throw new ToolFailure('invalid_arguments', `首版仅允许只读工具：${tool.name}`);
    }
    if (!Number.isSafeInteger(tool.timeoutMs) || tool.timeoutMs <= 0) {
      throw new ToolFailure('invalid_arguments', `工具 ${tool.name} 的 timeoutMs 无效`);
    }
    if (!Number.isSafeInteger(tool.maxOutputBytes) || tool.maxOutputBytes <= 0) {
      throw new ToolFailure('invalid_arguments', `工具 ${tool.name} 的 maxOutputBytes 无效`);
    }
    this.#tools.set(tool.name, tool);
  }

  freeze(): void {
    this.#frozen = true;
  }

  schemasFor(actor: ActorContext): readonly ModelToolSchema[] {
    return [...this.#tools.values()].filter((tool) => {
      try {
        return this.#policy.decide(actor, tool.requiredAction, tool.resource({}, actor)).allowed;
      } catch {
        return false;
      }
    }).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    }));
  }

  async execute(name: string, args: unknown, ctx: ToolContext): Promise<string> {
    const tool = this.#tools.get(name);
    if (tool === undefined) throw new ToolFailure('unknown_tool', `未注册工具：${name}`);
    if (ctx.signal.aborted) throw new ToolFailure('cancelled', '工具调用已取消');
    validateArguments(tool, args);
    const resource = tool.resource(args as Record<string, unknown>, ctx.actor);
    if (!this.#policy.decide(ctx.actor, tool.requiredAction, resource).allowed) {
      throw new ToolFailure('forbidden', `工具 ${name} 未获授权`);
    }

    const remainingMs = Math.min(tool.timeoutMs, ctx.deadline - Date.now());
    if (remainingMs <= 0) throw new ToolFailure('timeout', `工具 ${name} 已过截止时间`);

    const controller = new AbortController();
    const onAbort = (): void => controller.abort(ctx.signal.reason);
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    if (ctx.signal.aborted) onAbort();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, remainingMs);
    try {
      const result = await Promise.race([
        Promise.resolve(tool.execute(args as Record<string, unknown>, {
          ...ctx,
          signal: controller.signal,
        })),
        new Promise<never>((_, reject) => {
          if (controller.signal.aborted) {
            reject(new ToolFailure(timedOut ? 'timeout' : 'cancelled', `工具 ${name} 已中止`));
            return;
          }
          controller.signal.addEventListener('abort', () => {
            reject(new ToolFailure(timedOut ? 'timeout' : 'cancelled', `工具 ${name} 已中止`));
          }, { once: true });
        }),
      ]);
      if (ctx.signal.aborted) throw new ToolFailure('cancelled', `工具 ${name} 已取消`);
      if (timedOut) throw new ToolFailure('timeout', `工具 ${name} 已超时`);
      const serialized = JSON.stringify(result);
      if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > tool.maxOutputBytes) {
        throw new ToolFailure('output_too_large', `工具 ${name} 的结果超过输出上限`);
      }
      return serialized;
    } catch (error) {
      if (error instanceof ToolFailure) throw error;
      throw new ToolFailure('execution_failed', `工具 ${name} 执行失败`);
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
    }
  }
}

function validateArguments(tool: ToolDefinition, value: unknown): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ToolFailure('invalid_arguments', `工具 ${tool.name} 的参数必须是对象`);
  }
  const args = value as Record<string, unknown>;
  const schema = tool.inputSchema;
  const properties = schema.properties;
  const allowed =
    properties !== null && typeof properties === 'object' && !Array.isArray(properties)
      ? properties as Record<string, unknown>
      : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (typeof key === 'string' && !Object.prototype.hasOwnProperty.call(args, key)) {
      throw new ToolFailure('invalid_arguments', `工具 ${tool.name} 缺少参数 ${key}`);
    }
  }
  for (const [key, item] of Object.entries(args)) {
    const spec = allowed[key];
    if (spec === undefined || spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
      throw new ToolFailure('invalid_arguments', `工具 ${tool.name} 不接受参数 ${key}`);
    }
    const rule = spec as Record<string, unknown>;
    if (
      (rule.type === 'string' && typeof item !== 'string') ||
      (rule.type === 'number' && (typeof item !== 'number' || !Number.isFinite(item))) ||
      (rule.type === 'integer' && (typeof item !== 'number' || !Number.isSafeInteger(item))) ||
      (rule.type !== 'string' && rule.type !== 'number' && rule.type !== 'integer')
    ) {
      throw new ToolFailure('invalid_arguments', `工具 ${tool.name} 的参数 ${key} 类型错误`);
    }
    if (typeof item === 'string' && typeof rule.maxLength === 'number' && item.length > rule.maxLength) {
      throw new ToolFailure('invalid_arguments', `工具 ${tool.name} 的参数 ${key} 过长`);
    }
  }
}
