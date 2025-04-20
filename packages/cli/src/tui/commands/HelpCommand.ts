import { CommandHandler } from '../core/types';
import { ModeManager } from '../core/ModeManager';
import { CommandManager } from '../core/CommandManager';

/**
 * Help command
 */
export class HelpCommand implements CommandHandler {
  private modeManager: ModeManager;
  private commandManager: CommandManager;
  private addMessage: (message: string) => void;

  /**
   * Create a new help command
   * @param modeManager The mode manager
   * @param commandManager The command manager
   * @param addMessage Function to add a message to the output
   */
  constructor(
    modeManager: ModeManager,
    commandManager: CommandManager,
    addMessage: (message: string) => void,
  ) {
    this.modeManager = modeManager;
    this.commandManager = commandManager;
    this.addMessage = addMessage;
  }

  /**
   * Get command name
   */
  getName(): string {
    return 'help';
  }

  /**
   * Get command description
   */
  getDescription(): string {
    return 'Show help information';
  }

  /**
   * Handle command
   * @param args Command arguments
   */
  async handle(args: string[]): Promise<void> {
    // If a specific mode is specified, show help for that mode
    if (args.length > 0) {
      const mode = this.modeManager.getMode(args[0]);
      if (mode) {
        this.addMessage(mode.getHelpText());
        return;
      }
    }

    // Show general help
    this.addMessage('{bold}Dome CLI Help{/bold}\n');

    // Show mode help
    this.addMessage(this.modeManager.getHelpText());

    // Show command help
    this.addMessage(this.commandManager.getHelpText());

    // Show general keybindings
    this.addMessage('{bold}Global Keybindings:{/bold}');
    this.addMessage('  {cyan-fg}Ctrl+C{/cyan-fg} - Exit the application');
    this.addMessage('  {cyan-fg}q{/cyan-fg} - Exit the application');
    this.addMessage('  {cyan-fg}escape{/cyan-fg} - Exit the application');
  }
}
