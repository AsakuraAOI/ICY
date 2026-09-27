import { defineService } from '../../app/runtime/contracts.js';
import type { InboundEvent } from '../../sdk/index.js';
import type { ReplyRule } from '../extensions/config.js';

/** 入口识别和执行共用同一套规则，避免范围或匹配方式不一致。 */
export function selectReplyRule(rules: readonly ReplyRule[], event: InboundEvent): ReplyRule | undefined {
  const scope = event.kind;
  if (scope !== 'group' && scope !== 'c2c') return undefined;
  if (event.senderIsBot === true) return undefined;
  const content = event.content?.trim() ?? '';
  if (!content || content.startsWith('/')) return undefined;
  return rules.find((rule) => rule.scopes.includes(scope) &&
    (scope !== 'group' || rule.groupOpenids.length === 0 ||
      (event.groupOpenid !== undefined && rule.groupOpenids.includes(event.groupOpenid))) &&
    (rule.match === 'exact' ? content === rule.keyword : content.includes(rule.keyword)));
}

export interface AutoReplyRecognition {
  /** 只匹配启用的规则；权限、冷却和回复由关键词模块负责。 */
  matches(event: InboundEvent): boolean;
}
export const AutoReplies = defineService<AutoReplyRecognition>('auto-reply.recognition');
