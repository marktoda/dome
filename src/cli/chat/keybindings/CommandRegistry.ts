import { Command, CommandRegistry } from './types.js';

export class CommandRegistryImpl implements CommandRegistry {
  private commands = new Map<string, Command>();

  register(command: Command): void {
    if (this.commands.has(command.id)) {
      console.warn(`Command with id '${command.id}' already exists. Overwriting.`);
    }
    this.commands.set(command.id, command);
  }

  unregister(id: string): void {
    this.commands.delete(id);
  }

  async execute(commandId: string, args?: Record<string, any>): Promise<void> {
    const command = this.commands.get(commandId);
    if (!command) {
      throw new Error(`Command '${commandId}' not found`);
    }

    try {
      await command.handler(args);
    } catch (error) {
      console.error(`Error executing command '${commandId}':`, error);
      throw error;
    }
  }

  getCommand(id: string): Command | undefined {
    return this.commands.get(id);
  }

  getCommands(): Command[] {
    return Array.from(this.commands.values());
  }

  getCommandsByGroup(group: string): Command[] {
    return this.getCommands().filter(command => command.group === group);
  }
} 