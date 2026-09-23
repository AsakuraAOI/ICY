import { defineService } from '../../app/runtime/contracts.js';
import { defineModule } from '../../app/runtime/module.js';
import type { ActorContext } from './identity.js';

export type PolicyAction =
  | 'agent.use'
  | 'runs.read' | 'runs.cancel' | 'sessions.reset'
  | 'tools.clock_now' | 'tools.calculator_evaluate' | 'knowledge.read';

export interface PolicyResource {
  readonly kind: 'session' | 'tool' | 'knowledge';
  readonly sessionKey?: string;
  readonly groupOpenid?: string;
}

export interface PolicyDecision {
  readonly allowed: boolean;
  readonly reason: 'allowed' | 'blocked_user' | 'blocked_group' | 'disabled_tool' | 'wrong_owner' | 'wrong_scope' | 'unknown_action';
}

export interface PolicyService {
  decide(actor: ActorContext, action: PolicyAction, resource: PolicyResource): PolicyDecision;
}

export const Policy = defineService<PolicyService>('agent.policy');

interface PolicyConfig {
  readonly allowedGroups?: readonly string[];
  readonly blockedUsers?: readonly string[];
  readonly allowC2c?: boolean;
  readonly enabledTools?: readonly string[];
}

export class ConfiguredPolicy implements PolicyService {
  readonly #groups: ReadonlySet<string>;
  readonly #blocked: ReadonlySet<string>;
  readonly #allowC2c: boolean;
  readonly #tools: ReadonlySet<string>;

  constructor(config: PolicyConfig = {}) {
    this.#groups = new Set(readStrings(config.allowedGroups ?? [], 'allowedGroups'));
    this.#blocked = new Set(readStrings(config.blockedUsers ?? [], 'blockedUsers'));
    if (config.allowC2c !== undefined && typeof config.allowC2c !== 'boolean') {
      throw new Error('policy.allowC2c 必须是布尔值');
    }
    this.#allowC2c = config.allowC2c ?? false;
    this.#tools = new Set(readStrings(
      config.enabledTools ?? ['clock_now', 'calculator_evaluate', 'knowledge_search'],
      'enabledTools',
    ));
  }

  decide(actor: ActorContext, action: PolicyAction, resource: PolicyResource): PolicyDecision {
    const deny = (reason: PolicyDecision['reason']): PolicyDecision => ({ allowed: false, reason });
    if (this.#blocked.has(actor.actorId)) return deny('blocked_user');
    if (actor.scope === 'group' && (actor.groupOpenid === undefined ||
      !this.#groups.has(actor.groupOpenid))) return deny('blocked_group');
    if (actor.scope === 'c2c' && !this.#allowC2c) return deny('wrong_scope');

    if (action === 'agent.use') return { allowed: true, reason: 'allowed' };
    if (action === 'runs.read' || action === 'runs.cancel' || action === 'sessions.reset') {
      return resource.kind === 'session' && resource.sessionKey === actor.sessionKey
        ? { allowed: true, reason: 'allowed' } : deny('wrong_owner');
    }
    const toolName = action === 'tools.clock_now' ? 'clock_now'
      : action === 'tools.calculator_evaluate' ? 'calculator_evaluate'
      : action === 'knowledge.read' ? 'knowledge_search' : null;
    if (toolName === null) return deny('unknown_action');
    if (!this.#tools.has(toolName)) return deny('disabled_tool');
    if (action === 'knowledge.read') {
      if (resource.kind !== 'knowledge' ||
        (resource.groupOpenid !== undefined && resource.groupOpenid !== actor.groupOpenid)) {
        return deny('wrong_scope');
      }
    } else if (resource.kind !== 'tool') return deny('wrong_scope');
    return { allowed: true, reason: 'allowed' };
  }
}

function readStrings(value: readonly string[], name: string): string[] {
  if (!Array.isArray(value) || value.length > 1_000 ||
    value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`policy.${name} 必须是非空字符串数组（最多 1000 项）`);
  }
  return [...value];
}

export const policyModule = defineModule<PolicyConfig>({
  name: 'policy', version: '0.1.0',
  setup(ctx) { ctx.provide(Policy, new ConfiguredPolicy(ctx.config)); },
});

export default policyModule;
