import { Widgets } from 'blessed';
import { Mode, ModeConfig } from './types';

/**
 * Manager for TUI modes
 */
export class ModeManager {
  private modes: Map<string, Mode> = new Map();
  private activeMode: Mode | null = null;
  private screen: Widgets.Screen;
  private container: Widgets.BoxElement;
  private statusBar: Widgets.BoxElement;
  private inputHandler: (input: string) => Promise<void>;
  private onModeChange: (mode: Mode) => void;

  /**
   * Create a new mode manager
   * @param screen The blessed screen
   * @param container The container for mode-specific UI
   * @param statusBar The status bar element
   * @param inputHandler The input handler function
   * @param onModeChange Callback for mode changes
   */
  constructor(
    screen: Widgets.Screen,
    container: Widgets.BoxElement,
    statusBar: Widgets.BoxElement,
    inputHandler: (input: string) => Promise<void>,
    onModeChange: (mode: Mode) => void
  ) {
    this.screen = screen;
    this.container = container;
    this.statusBar = statusBar;
    this.inputHandler = inputHandler;
    this.onModeChange = onModeChange;
  }

  /**
   * Register a mode
   * @param mode The mode to register
   */
  registerMode(mode: Mode): void {
    const config = mode.getConfig();
    this.modes.set(config.id, mode);
    
    // Initialize the mode
    mode.init(this.screen, this.container, this.statusBar, this.inputHandler);
  }

  /**
   * Register multiple modes
   * @param modes The modes to register
   */
  registerModes(modes: Mode[]): void {
    modes.forEach(mode => this.registerMode(mode));
  }

  /**
   * Get a mode by ID
   * @param id The mode ID
   * @returns The mode, or null if not found
   */
  getMode(id: string): Mode | null {
    return this.modes.get(id) || null;
  }

  /**
   * Get all registered modes
   * @returns All registered modes
   */
  getAllModes(): Mode[] {
    return Array.from(this.modes.values());
  }

  /**
   * Get the active mode
   * @returns The active mode, or null if none
   */
  getActiveMode(): Mode | null {
    return this.activeMode;
  }

  /**
   * Switch to a mode
   * @param id The mode ID
   * @returns True if the mode was switched, false otherwise
   */
  switchToMode(id: string): boolean {
    const mode = this.getMode(id);
    if (!mode) {
      return false;
    }

    // Deactivate the current mode
    if (this.activeMode) {
      this.activeMode.deactivate();
    }

    // Activate the new mode
    this.activeMode = mode;
    this.activeMode.activate();
    
    // Trigger the mode change callback
    this.onModeChange(this.activeMode);
    
    // Render the screen
    this.screen.render();
    
    return true;
  }

  /**
   * Handle input in the active mode
   * @param input The input to handle
   */
  async handleInput(input: string): Promise<void> {
    if (!this.activeMode) {
      return;
    }

    await this.activeMode.handleInput(input);
  }

  /**
   * Get help text for all modes
   * @returns The help text
   */
  getHelpText(): string {
    let helpText = '{bold}Available Modes:{/bold}\n\n';
    
    this.getAllModes().forEach(mode => {
      const config = mode.getConfig();
      helpText += `{${config.color}-fg}${config.name}{/${config.color}-fg}: ${config.description}\n`;
      helpText += `  Shortcut: {cyan-fg}${config.shortcut}{/cyan-fg}\n\n`;
    });
    
    return helpText;
  }

  /**
   * Set up keyboard shortcuts for mode switching
   */
  setupShortcuts(): void {
    this.getAllModes().forEach(mode => {
      const config = mode.getConfig();
      const shortcut = config.shortcut;
      
      if (shortcut) {
        this.screen.key(shortcut, () => {
          this.switchToMode(config.id);
        });
      }
    });
  }
}