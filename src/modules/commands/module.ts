import { defineService } from '../../app/runtime/contracts.js';
import { defineModule } from '../../app/runtime/module.js';
import type { ActorContext } from '../agent/identity.js';
import { BUILTIN_COMMANDS } from './recognition.js';

export class CommandInputError extends Error {}

export interface PluginCommand {
  readonly name: string;
  readonly owner: string;
  readonly usage: string;
  execute(argument: string | undefined, actor: ActorContext, eventKey: string): string | Promise<string>;
}
export class CommandRegistry {
  readonly #commands = new Map<string, PluginCommand>();
  register(command: PluginCommand): void {
    if (!/^[a-z][a-z0-9_-]*$/.test(command.name) ||
      (BUILTIN_COMMANDS as readonly string[]).includes(command.name) ||
      this.#commands.has(command.name)) throw new Error(`插件命令名无效或重复：${command.name}`);
    this.#commands.set(command.name, command);
  }
  get(name: string): PluginCommand | undefined { return this.#commands.get(name); }
  list(): readonly PluginCommand[] { return [...this.#commands.values()]; }
}
export const PluginCommands = defineService<CommandRegistry>('commands.plugins');
export default defineModule({
  name: 'commands', version: '0.1.0',
  setup(ctx) { ctx.provide(PluginCommands, new CommandRegistry()); },
});
