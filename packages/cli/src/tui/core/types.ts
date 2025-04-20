import { Widgets } from 'blessed';

/**
 * Interface for TUI mode configuration
 */
export interface ModeConfig {
  id: string;
  name: string;
  description: string;
  shortcut: string;
  color: string;
}

/**
 * Interface for TUI mode
 */
export interface Mode {
  /**
   * Get mode configuration
   */
  getConfig(): ModeConfig;

  /**
   * Initialize the mode
   * @param screen The blessed screen
   * @param container The container element
   * @param statusBar The status bar element
   * @param inputHandler The input handler function
   */
  init(
    screen: Widgets.Screen,
    container: Widgets.BoxElement,
    statusBar: Widgets.BoxElement,
    inputHandler: (input: string) => Promise<void>,
  ): void;

  /**
   * Activate the mode
   */
  activate(): void;

  /**
   * Deactivate the mode
   */
  deactivate(): void;

  /**
   * Handle input in this mode
   * @param input The input to handle
   */
  handleInput(input: string): Promise<void>;

  /**
   * Get help text for this mode
   */
  getHelpText(): string;
}

/**
 * Interface for command handler
 */
export interface CommandHandler {
  /**
   * Get command name
   */
  getName(): string;

  /**
   * Get command description
   */
  getDescription(): string;

  /**
   * Handle command
   * @param args Command arguments
   */
  handle(args: string[]): Promise<void>;
}

/**
 * Interface for TUI context
 */
export interface TUIContext {
  screen: Widgets.Screen;
  container: Widgets.BoxElement;
  sidebar: Widgets.BoxElement;
  statusBar: Widgets.BoxElement;
  inputBox: Widgets.TextboxElement;
  addMessage: (message: string) => void;
  setStatus: (status: string) => void;
  updateSidebar: () => void;
}
