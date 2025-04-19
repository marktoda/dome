import blessed from 'blessed';
import { Widgets } from 'blessed';

/**
 * Interface for mode configuration
 */
export interface ModeConfig {
  name: string;
  description: string;
  icon?: string;
  color?: string;
  keybindings?: Record<string, string>;
  commands?: string[];
}

/**
 * Base class for all TUI modes
 */
export abstract class BaseMode {
  protected name: string;
  protected description: string;
  protected icon: string;
  protected color: string;
  protected screen: blessed.Widgets.Screen;
  protected keybindings: Record<string, string>;
  protected commands: string[];
  protected active: boolean = false;

  /**
   * Create a new mode
   * @param config The mode configuration
   * @param screen The blessed screen
   */
  constructor(config: ModeConfig, screen: blessed.Widgets.Screen) {
    this.name = config.name;
    this.description = config.description;
    this.icon = config.icon || '•';
    this.color = config.color || 'cyan';
    this.screen = screen;
    this.keybindings = config.keybindings || {};
    this.commands = config.commands || [];
  }

  /**
   * Get the mode name
   * @returns The mode name
   */
  getName(): string {
    return this.name;
  }

  /**
   * Get the mode description
   * @returns The mode description
   */
  getDescription(): string {
    return this.description;
  }

  /**
   * Get the mode icon
   * @returns The mode icon
   */
  getIcon(): string {
    return this.icon;
  }

  /**
   * Get the mode color
   * @returns The mode color
   */
  getColor(): string {
    return this.color;
  }

  /**
   * Get the mode keybindings
   * @returns The mode keybindings
   */
  getKeybindings(): Record<string, string> {
    return this.keybindings;
  }

  /**
   * Get the mode commands
   * @returns The mode commands
   */
  getCommands(): string[] {
    return this.commands;
  }

  /**
   * Check if the mode is active
   * @returns True if the mode is active, false otherwise
   */
  isActive(): boolean {
    return this.active;
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
   * Handle a command in this mode
   * @param command The command to handle
   * @param args The command arguments
   */
  abstract handleCommand(command: string, args: string[]): Promise<boolean>;

  /**
   * Render mode-specific UI elements
   * @param container The container to render in
   */
  abstract render(container: blessed.Widgets.BoxElement): void;

  /**
   * Get help text for this mode
   * @returns The help text
   */
  abstract getHelpText(): string;
}