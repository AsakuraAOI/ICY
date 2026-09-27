import type { InboundEvent } from '../../sdk/index.js';
import type { CommandRecognition } from './recognition.js';
import type { AutoReplyRecognition } from '../auto-reply/recognition.js';

export interface GroupTriggerConfig {
  readonly mentionId: string | null;
  readonly commandsWithoutMention: boolean;
}

/** 接入层只决定消息是否进入应用，执行和权限仍由命令路由负责。 */
export function selectInboundMessage(
  event: InboundEvent, config: GroupTriggerConfig, commands: CommandRecognition | undefined,
  autoReplies?: AutoReplyRecognition,
): InboundEvent | null {
  if (event.kind !== 'group') return event;
  if (event.senderIsBot === true) return null;
  const marker = config.mentionId === null ? null : `<@${config.mentionId}>`;
  const mentioned = marker !== null && event.content?.includes(marker);
  if (event.eventType === 'GROUP_AT_MESSAGE_CREATE' || mentioned) {
    return mentioned ? { ...event, content: event.content!.replaceAll(marker!, '').trim() } : event;
  }
  if (event.eventType !== 'GROUP_MESSAGE_CREATE') return event;
  return (config.commandsWithoutMention && commands?.matches(event.content ?? '')) ||
    autoReplies?.matches(event) ? event : null;
}
