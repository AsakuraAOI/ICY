import { defineService } from '../../app/runtime/contracts.js';
import {
  type ModelMessage,
  type ModelUsage,
  type Models,
} from '../llm/contracts.js';
import { ToolFailure, type ToolExecutor } from './tools.js';
import type { ActorContext } from './identity.js';

export type AgentFailureKind =
  | 'cancelled'
  | 'deadline'
  | 'model_limit'
  | 'tool_limit'
  | 'tool_rejected'
  | 'invalid_final';

export class AgentFailure extends Error {
  readonly kind: AgentFailureKind;

  constructor(kind: AgentFailureKind, message: string) {
    super(message);
    this.name = 'AgentFailure';
    this.kind = kind;
  }
}

export interface AgentRequest {
  readonly actor: ActorContext;
  readonly sessionKey: string;
  readonly runId: string;
  readonly modelAlias: string;
  readonly messages: readonly ModelMessage[];
  readonly outputLimit: number;
  readonly deadline: number;
  readonly signal: AbortSignal;
  readonly maxModelCalls?: number;
  readonly maxToolCalls?: number;
}

export interface AgentResult {
  readonly text: string;
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly usage: ModelUsage;
  readonly toolNames: readonly string[];
}

export interface AgentEngine {
  run(request: AgentRequest): Promise<AgentResult>;
}

export const Agents = defineService<AgentEngine>('agent.engine');

/** 一次有界模型 → 工具 → 模型循环；持久任务和回复交付由外层 Runs service 负责。 */
export class BoundedAgentEngine implements AgentEngine {
  readonly #models: Models;
  readonly #tools: ToolExecutor;

  constructor(models: Models, tools: ToolExecutor) {
    this.#models = models;
    this.#tools = tools;
  }

  async run(request: AgentRequest): Promise<AgentResult> {
    const maxModelCalls = request.maxModelCalls ?? 6;
    const maxToolCalls = request.maxToolCalls ?? 8;
    if (!Number.isSafeInteger(maxModelCalls) || maxModelCalls <= 0 || maxModelCalls > 20) {
      throw new AgentFailure('model_limit', '模型调用上限无效');
    }
    if (!Number.isSafeInteger(maxToolCalls) || maxToolCalls < 0 || maxToolCalls > 32) {
      throw new AgentFailure('tool_limit', '工具调用上限无效');
    }
    if (request.messages.length === 0) {
      throw new AgentFailure('invalid_final', 'Agent 输入消息不能为空');
    }

    const description = this.#models.describe(request.modelAlias);
    const toolSchemas = description.supportsTools ? [...this.#tools.schemasFor(request.actor)] : [];
    const messages: ModelMessage[] = [...request.messages];
    const toolNames: string[] = [];
    const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const usageSeen = { inputTokens: false, outputTokens: false, totalTokens: false };
    let toolCalls = 0;

    for (let modelCalls = 1; modelCalls <= maxModelCalls; modelCalls += 1) {
      checkActive(request);
      const turn = await this.#models.generate({
        modelAlias: request.modelAlias,
        messages,
        toolSchemas,
        outputLimit: request.outputLimit,
        deadline: Math.min(request.deadline, Date.now() + 30_000),
        signal: request.signal,
      });
      checkActive(request);
      addUsage(usage, usageSeen, turn.usage);

      if (turn.finishReason === 'length') {
        throw new AgentFailure('invalid_final', '模型输出被截断，不能执行或发送不完整结果');
      }
      if (turn.finishReason === 'tool_calls' && turn.toolCalls.length === 0) {
        throw new AgentFailure('invalid_final', '模型声明要调用工具，但没有完整工具调用');
      }
      if (turn.toolCalls.length === 0) {
        if (turn.text.trim() === '') {
          throw new AgentFailure('invalid_final', '模型没有给出最终文本');
        }
        return {
          text: turn.text,
          modelCalls,
          toolCalls,
          usage: knownUsage(usage, usageSeen),
          toolNames,
        };
      }

      if (!description.supportsTools || toolSchemas.length === 0) {
        throw new AgentFailure('tool_rejected', '模型提出了未授权的工具调用');
      }
      if (toolCalls + turn.toolCalls.length > maxToolCalls) {
        throw new AgentFailure('tool_limit', '工具调用次数超过上限');
      }
      if (modelCalls === maxModelCalls) {
        throw new AgentFailure('model_limit', '模型调用次数已用尽，无法继续工具循环');
      }

      const callIds = new Set<string>();
      for (const call of turn.toolCalls) {
        if (callIds.has(call.callId)) {
          throw new AgentFailure('tool_rejected', '模型返回了重复的工具 callId');
        }
        callIds.add(call.callId);
      }
      messages.push({ role: 'assistant', content: turn.text || null, toolCalls: turn.toolCalls });

      for (const call of turn.toolCalls) {
        checkActive(request);
        let output: string;
        try {
          output = await this.#tools.execute(call.name, call.arguments, {
            actor: request.actor,
            sessionKey: request.sessionKey,
            runId: request.runId,
            deadline: request.deadline,
            signal: request.signal,
          });
        } catch (error) {
          if (error instanceof ToolFailure && error.kind === 'cancelled') {
            throw new AgentFailure('cancelled', 'Agent 任务已取消');
          }
          if (error instanceof ToolFailure && error.kind === 'timeout') {
            throw new AgentFailure('deadline', '工具调用超时');
          }
          throw new AgentFailure('tool_rejected', `工具 ${call.name} 的调用被拒绝`);
        }
        toolCalls += 1;
        toolNames.push(call.name);
        messages.push({ role: 'tool', toolCallId: call.callId, content: output });
      }
    }
    throw new AgentFailure('model_limit', '模型调用次数超过上限');
  }
}

function checkActive(request: AgentRequest): void {
  if (request.signal.aborted) throw new AgentFailure('cancelled', 'Agent 任务已取消');
  if (Date.now() >= request.deadline) throw new AgentFailure('deadline', 'Agent 任务已超时');
}

function addUsage(
  total: { inputTokens: number; outputTokens: number; totalTokens: number },
  seen: { inputTokens: boolean; outputTokens: boolean; totalTokens: boolean },
  turn: ModelUsage,
): void {
  if (turn.inputTokens !== undefined) {
    total.inputTokens += turn.inputTokens;
    seen.inputTokens = true;
  }
  if (turn.outputTokens !== undefined) {
    total.outputTokens += turn.outputTokens;
    seen.outputTokens = true;
  }
  if (turn.totalTokens !== undefined) {
    total.totalTokens += turn.totalTokens;
    seen.totalTokens = true;
  }
}

function knownUsage(
  total: { inputTokens: number; outputTokens: number; totalTokens: number },
  seen: { inputTokens: boolean; outputTokens: boolean; totalTokens: boolean },
): ModelUsage {
  return {
    ...(seen.inputTokens ? { inputTokens: total.inputTokens } : {}),
    ...(seen.outputTokens ? { outputTokens: total.outputTokens } : {}),
    ...(seen.totalTokens ? { totalTokens: total.totalTokens } : {}),
  };
}
