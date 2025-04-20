import { CommandHandler } from '../core/types';

/**
 * Exit command for exiting the application
 */
export class ExitCommand implements CommandHandler {
  /**
   * Get command name
   */
  getName(): string {
    return 'exit';
  }

  /**
   * Get command description
   */
  getDescription(): string {
    return 'Exit the application';
  }

  /**
   * Handle command
   * @param args Command arguments
   */
  async handle(args: string[]): Promise<void> {
    // Clean up and exit
    process.exit(0);
  }
}
