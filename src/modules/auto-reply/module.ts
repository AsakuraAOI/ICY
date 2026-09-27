import { Messages } from '../../app/runtime/contracts.js';
import { defineModule } from '../../app/runtime/module.js';
import { actorFromEvent } from '../agent/identity.js';
import { Policy } from '../agent/policy.js';
import { DEFAULT_EXTENSIONS, readExtensionConfig } from '../extensions/config.js';
import { AutoReplies, selectReplyRule } from './recognition.js';

export default defineModule<unknown>({
  name: 'auto-reply', version: '0.1.0', requires: ['core', 'policy'],
  setup(ctx) {
    const config = readExtensionConfig({ ...DEFAULT_EXTENSIONS, autoReply: ctx.config }).autoReply;
    if (!config.enabled) return;
    ctx.provide(AutoReplies, { matches: (event) => selectReplyRule(config.rules, event) !== undefined });
    const lastReply = new Map<string, number>();
    const policy = ctx.services.require(Policy);
    ctx.services.require(Messages).use(async (message, next) => {
      const actor = actorFromEvent(message.event, message.botId);
      if (!actor ||
        !policy.decide(actor, 'agent.use', { kind: 'session', sessionKey: actor.sessionKey }).allowed) return next();
      const rule = selectReplyRule(config.rules, message.event);
      if (!rule) return next();
      const key = JSON.stringify([actor.botId, actor.scope, actor.groupOpenid ?? actor.actorId, rule.id]);
      const now = Date.now();
      if (now - (lastReply.get(key) ?? 0) < rule.cooldownSeconds * 1000) return null;
      if (lastReply.size >= 10000 && !lastReply.has(key)) lastReply.delete(lastReply.keys().next().value!);
      lastReply.set(key, now);
      return { scope: actor.scope, body: { kind: 'text', text: rule.reply } };
    }, { priority: -150, id: 'auto-reply.rules', resources: ctx.resources });
    ctx.onDispose(() => lastReply.clear());
  },
});
