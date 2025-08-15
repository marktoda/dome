import { ChatCommand, ChatCommandRegistry, ChatCommandContext } from './types.js';

export class ChatCommandRegistryImpl implements ChatCommandRegistry {
  private commands = new Map<string, ChatCommand>();
  private aliases = new Map<string, string>(); // alias -> command name

  register(command: ChatCommand): void {
    if (this.commands.has(command.name)) {
      console.warn(`Chat command '${command.name}' already exists. Overwriting.`);
    }

    this.commands.set(command.name, command);

    // Register aliases
    if (command.aliases) {
      for (const alias of command.aliases) {
        if (this.aliases.has(alias)) {
          console.warn(`Alias '${alias}' already exists. Overwriting.`);
        }
        this.aliases.set(alias, command.name);
      }
    }
  }

  unregister(name: string): void {
    const command = this.commands.get(name);
    if (command) {
      // Remove aliases
      if (command.aliases) {
        for (const alias of command.aliases) {
          this.aliases.delete(alias);
        }
      }
      this.commands.delete(name);
    }
  }

  async execute(input: string, context: ChatCommandContext): Promise<boolean> {
    if (!this.isCommand(input)) {
      return false;
    }

    const parts = input.substring(1).split(/\s+/); // Remove '/' and split
    const commandName = parts[0].toLowerCase();
    const args = parts.slice(1);

    // Resolve alias if needed
    const resolvedName = this.aliases.get(commandName) || commandName;
    const command = this.commands.get(resolvedName);

    if (!command) {
      context.addMessage({
        type: 'error',
        content: `Unknown command: /${commandName}. Type /help for available commands.`,
      });
      return true;
    }

    try {
      await command.handler(args, context);
    } catch (error) {
      context.addMessage({
        type: 'error',
        content: `Error executing command /${commandName}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }

    return true;
  }

  getCommand(name: string): ChatCommand | undefined {
    // Check aliases first
    const resolvedName = this.aliases.get(name) || name;
    return this.commands.get(resolvedName);
  }

  getCommands(): ChatCommand[] {
    return Array.from(this.commands.values());
  }

  getCommandsByGroup(group: string): ChatCommand[] {
    return this.getCommands().filter(command => command.group === group);
  }

  isCommand(input: string): boolean {
    return input.startsWith('/') && input.length > 1;
  }

  // Helper method to generate help text
  generateHelp(): string {
    const groups = new Map<string, ChatCommand[]>();

    // Group commands
    for (const command of this.commands.values()) {
      if (command.hidden) continue;

      const group = command.group || 'Other';
      if (!groups.has(group)) {
        groups.set(group, []);
      }
      groups.get(group)!.push(command);
    }

    // Generate help text
    const lines: string[] = ['Available Commands:'];

    for (const [group, commands] of groups) {
      lines.push('');
      lines.push(`${group}:`);

      for (const command of commands.sort((a, b) => a.name.localeCompare(b.name))) {
        let commandLine = `  /${command.name}`;

        if (command.aliases && command.aliases.length > 0) {
          commandLine += ` (${command.aliases.map(a => `/${a}`).join(', ')})`;
        }

        if (command.usage) {
          commandLine += ` ${command.usage}`;
        }

        commandLine += ` - ${command.description}`;
        lines.push(commandLine);
      }
    }

    return lines.join('\n');
  }
}
