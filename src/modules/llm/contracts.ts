/**
 * App 内 LLM 契约。这里定义应用侧模型与工具调用类型，不进入 ICY 内核或 SDK。
 */

import { defineService } from '../../app/runtime/contracts.js';

export type ModelFailureKind =
  | 'auth'
  | 'rate_limited'
  | 'timeout'
  | 'unavailable'
  | 'invalid_request'
  | 'context_overflow'
  | 'cancelled'
  | 'invalid_output';

export class ModelFailure extends Error {
  readonly kind: ModelFailureKind;
  readonly requestId?: string;

  constructor(kind: ModelFailureKind, message: string, requestId?: string) {
    super(message);
    this.name = 'ModelFailure';
    this.kind = kind;
    if (requestId !== undefined) this.requestId = requestId;
  }
}

export type ModelMessage =
  | { readonly role: 'system' | 'user'; readonly content: string }
  | {
      readonly role: 'assistant';
      readonly content: string | null;
      readonly toolCalls?: readonly ModelAssistantToolCall[];
    }
  | { readonly role: 'tool'; readonly toolCallId: string; readonly content: string };

export interface ModelAssistantToolCall {
  readonly callId: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface ModelToolSchema {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface ModelUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export interface ModelDescription {
  readonly alias: string;
  readonly contextTokens: number;
  readonly maxOutputTokens: number;
  readonly supportsTools: boolean;
}

export interface ModelRequest {
  readonly modelAlias: string;
  readonly messages: readonly ModelMessage[];
  readonly toolSchemas?: readonly ModelToolSchema[];
  readonly outputLimit: number;
  readonly deadline: number;
  readonly signal: AbortSignal;
}

export interface ModelTurn {
  readonly text: string;
  readonly toolCalls: readonly ModelAssistantToolCall[];
  readonly finishReason: 'stop' | 'tool_calls' | 'length' | 'other';
  readonly usage: ModelUsage;
  readonly requestId?: string;
}

export interface Models {
  describe(alias: string): ModelDescription;
  generate(request: ModelRequest): Promise<ModelTurn>;
}

export const Models = defineService<Models>('agent.models');
