import { Widgets } from 'blessed';
import { Mode, ModeConfig, TUIContext } from '../core/types';

/**
 * Base class for TUI modes
 */
export abstract class BaseMode implements Mode {
  protected config: ModeConfig;
  protected screen!: Widgets.Screen;
  protected container!: Widgets.BoxElement;
  protected statusBar!: Widgets.BoxElement;
  protected inputHandler!: (input: string) => Promise<void>;
  protected active: boolean = false;

  /**
   * Create a new mode
   * @param config The mode configuration
   */
  constructor(config: ModeConfig) {
    this.config = config;
  }

  /**
   * Get mode configuration
   */
  getConfig(): ModeConfig {
    return this.config;
  }

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
    inputHandler: (input: string) => Promise<void>
  ): void {
    this.screen = screen;
    this.container = container;
    this.statusBar = statusBar;
    this.inputHandler = inputHandler;
    this.onInit();
  }

  /**
   * Activate the mode
   */
  activate(): void {
    this.active = true;
    this.onActivate();
  }

  /**
   * Deactivate the mode
   */
  deactivate(): void {
    this.active = false;
    this.onDeactivate();
  }

  /**
   * Handle mode initialization
   */
  protected abstract onInit(): void;

  /**
   * Handle mode activation
   */
  protected abstract onActivate(): void;

  /**
   * Handle mode deactivation
   */
  protected abstract onDeactivate(): void;

  /**
   * Handle input in this mode
   * @param input The input to handle
   */
  abstract handleInput(input: string): Promise<void>;

  /**
   * Get help text for this mode
   */
  abstract getHelpText(): string;
}