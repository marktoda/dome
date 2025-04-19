import { CommandHandler } from './types';

/**
 * Manager for TUI commands
 */
export class CommandManager {
  private commands: Map<string, CommandHandler> = new Map();

  /**
   * Register a command
   * @param handler The command handler
   */
  registerCommand(handler: CommandHandler): void {
    this.commands.set(handler.getName().toLowerCase(), handler);
  }

  /**
   * Register multiple commands
   * @param handlers The command handlers
   */
  registerCommands(handlers: CommandHandler[]): void {
    handlers.forEach(handler => this.registerCommand(handler));
  }

  /**
   * Get a command by name
   * @param name The command name
   * @returns The command handler, or null if not found
   */
  getCommand(name: string): CommandHandler | null {
    return this.commands.get(name.toLowerCase()) || null;
  }

  /**
   * Get all registered commands
   * @returns All registered commands
   */
  getAllCommands(): CommandHandler[] {
    return Array.from(this.commands.values());
  }

  /**
   * Handle a command
   * @param input The command input (including the leading slash)
   * @returns True if the command was handled, false otherwise
   */
  async handleCommand(input: string): Promise<boolean> {
    if (!input.startsWith('/')) {
      return false;
    }

    // Parse the command and arguments
    const parts = input.slice(1).split(' ');
    const commandName = parts[0].toLowerCase();
    const args = parts.slice(1);

    // Get the command handler
    const handler = this.getCommand(commandName);
    if (!handler) {
      return false;
    }

    // Handle the command
    await handler.handle(args);
    return true;
  }

  /**
   * Get help text for all commands
   * @returns The help text
   */
  getHelpText(): string {
    let helpText = '{bold}Available Commands:{/bold}\n\n';
    
    this.getAllCommands().forEach(handler => {
      helpText += `{cyan-fg}/${handler.getName()}{/cyan-fg}: ${handler.getDescription()}\n`;
    });
    
    return helpText;
  }
}