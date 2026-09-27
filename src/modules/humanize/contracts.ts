import { defineService } from '../../app/runtime/contracts.js';

export type OutputSource = 'agent' | 'message' | 'command';

export interface HumanizedOutput {
  format(text: string, source: OutputSource): string;
}

/** 同步消息链与后台 Agent 共享输出服务；此服务不参与模型或工具输入。 */
export const Humanize = defineService<HumanizedOutput>('output.humanize');
