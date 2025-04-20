import { CommandHandler } from '../core/types';
import { ModeManager } from '../core/ModeManager';

/**
 * Mode command for switching between modes
 */
export class ModeCommand implements CommandHandler {
  private modeManager: ModeManager;
  private addMessage: (message: string) => void;

  /**
   * Create a new mode command
   * @param modeManager The mode manager
   * @param addMessage Function to add a message to the output
   */
  constructor(modeManager: ModeManager, addMessage: (message: string) => void) {
    this.modeManager = modeManager;
    this.addMessage = addMessage;
  }

  /**
   * Get command name
   */
  getName(): string {
    return 'mode';
  }

  /**
   * Get command description
   */
  getDescription(): string {
    return 'Switch between modes';
  }

  /**
   * Handle command
   * @param args Command arguments
   */
  async handle(args: string[]): Promise<void> {
    if (args.length === 0) {
      // List available modes
      this.addMessage('{bold}Available Modes:{/bold}');
      this.modeManager.getAllModes().forEach(mode => {
        const config = mode.getConfig();
        const isActive = this.modeManager.getActiveMode() === mode;
        const prefix = isActive ? '* ' : '  ';
        this.addMessage(
          `${prefix}{${config.color}-fg}${config.name}{/${config.color}-fg}: ${config.description}`,
        );
        this.addMessage(`    Shortcut: {cyan-fg}${config.shortcut}{/cyan-fg}`);
      });
      this.addMessage('\nUsage: /mode <name>');
      return;
    }

    const modeName = args[0];
    const success = this.modeManager.switchToMode(modeName);

    if (!success) {
      this.addMessage(`{red-fg}Error: Unknown mode "${modeName}"{/red-fg}`);
      this.addMessage('Available modes:');
      this.modeManager.getAllModes().forEach(mode => {
        const config = mode.getConfig();
        this.addMessage(`  {${config.color}-fg}${config.id}{/${config.color}-fg}`);
      });
    }
  }
}
