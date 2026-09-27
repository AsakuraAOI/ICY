import { defineService } from '../../app/runtime/contracts.js';

export const BUILTIN_COMMANDS = ['help', 'persona', 'calc', 'time', 'status', 'cancel', 'reset'] as const;

export interface ParsedCommand {
  readonly name: string;
  readonly argument: string | undefined;
}

export function parseDirectCommand(content: string): ParsedCommand | null {
  const match = /^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]+))?$/i.exec(content.trim());
  return match ? { name: match[1]!.toLowerCase(), argument: match[2] } : null;
}

export interface CommandRecognition {
  /** 只识别已注册命令，不执行命令、不授权，也不调用模型。 */
  matches(content: string): boolean;
}

export const DirectCommands = defineService<CommandRecognition>('commands.recognition');
