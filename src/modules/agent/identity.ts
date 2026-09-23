import type { InboundEvent } from '../../sdk/index.js';

export interface ActorContext {
  readonly botId: string;
  readonly scope: 'group' | 'c2c';
  readonly actorId: string;
  readonly groupOpenid?: string;
  readonly sessionKey: string;
  readonly role?: string;
}

/** 授权身份只能来自平台归一化后的明确 OpenID 字段。 */
export function actorFromEvent(event: InboundEvent, botId: string | undefined): ActorContext | null {
  if (typeof botId !== 'string' || botId.trim() === '' || event.senderIsBot === true) return null;
  if (event.kind === 'group') {
    if (
      event.senderIdSource !== 'member_openid' ||
      typeof event.senderId !== 'string' || event.senderId === '' ||
      typeof event.groupOpenid !== 'string' || event.groupOpenid === ''
    ) return null;
    return {
      botId, scope: 'group', actorId: event.senderId,
      groupOpenid: event.groupOpenid,
      sessionKey: JSON.stringify([botId, 'group', event.groupOpenid, event.senderId]),
      ...(event.senderRole === undefined ? {} : { role: event.senderRole }),
    };
  }
  if (event.kind === 'c2c') {
    if (
      event.senderIdSource !== 'user_openid' ||
      typeof event.userOpenid !== 'string' || event.userOpenid === '' ||
      event.senderId !== event.userOpenid
    ) return null;
    return {
      botId, scope: 'c2c', actorId: event.userOpenid,
      sessionKey: JSON.stringify([botId, 'c2c', event.userOpenid]),
    };
  }
  return null;
}

export function inboundEventKey(event: InboundEvent, actor: ActorContext): string | null {
  const id = event.messageId ?? event.eventId;
  if (id === '') return null;
  return JSON.stringify([actor.botId, event.eventType, actor.sessionKey, id]);
}
