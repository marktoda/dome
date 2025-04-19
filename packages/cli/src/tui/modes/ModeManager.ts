import blessed from 'blessed';
import { BaseMode, ModeConfig } from './BaseMode';

/**
 * Manager for TUI modes
 */
export class ModeManager {
  private modes: Map<string, BaseMode> = new Map();
  private activeMode: BaseMode | null = null;
  private screen: blessed.Widgets.Screen;
  private container: blessed.Widgets.BoxElement;
  private statusBar: blessed.Widgets.BoxElement;
  private onModeChange: (mode: BaseMode) => void;

  /**
   * Create a new mode manager
   * @param screen The blessed screen
   * @param container The container for mode-specific UI
   * @param statusBar The status bar element
   * @param onModeChange Callback for mode changes
   */
  constructor(
    screen: blessed.Widgets.Screen,
    container: blessed.Widgets.BoxElement,
    statusBar: blessed.Widgets.BoxElement,
    onModeChange: (mode: BaseMode) => void
  ) {
    this.screen = screen;
    this.container = container;
    this.statusBar = statusBar;
    this.onModeChange = onModeChange;
  }

  /**
   * Register a mode
   * @param mode The mode to register
   */
  registerMode(mode: BaseMode): void {
    this.modes.set(mode.getName().toLowerCase(), mode);
  }

  /**
   * Register multiple modes
   * @param modes The modes to register
   */
  registerModes(modes: BaseMode[]): void {
    modes.forEach(mode => this.registerMode(mode));
  }

  /**
   * Get a mode by name
   * @param name The mode name
   * @returns The mode, or null if not found
   */
  getMode(name: string): BaseMode | null {
    return this.modes.get(name.toLowerCase()) || null;
  }

  /**
   * Get all registered modes
   * @returns All registered modes
   */
  getAllModes(): BaseMode[] {
    return Array.from(this.modes.values());
  }

  /**
   * Get the active mode
   * @returns The active mode, or null if none
   */
  getActiveMode(): BaseMode | null {
    return this.activeMode;
  }

  /**
   * Switch to a mode
   * @param name The mode name
   * @returns True if the mode was switched, false otherwise
   */
  switchToMode(name: string): boolean {
    const mode = this.getMode(name.toLowerCase());
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
    
    // Clear the container and render the new mode
    this.container.setContent('');
    this.activeMode.render(this.container);
    
    // Update the status bar
    this.updateStatusBar();
    
    // Trigger the mode change callback
    this.onModeChange(this.activeMode);
    
    // Render the screen
    this.screen.render();
    
    return true;
  }

  /**
   * Update the status bar with the active mode
   */
  private updateStatusBar(): void {
    if (!this.activeMode) {
      this.statusBar.setContent(' {bold}Mode:{/bold} None');
      return;
    }

    const modeName = this.activeMode.getName();
    const modeColor = this.activeMode.getColor();
    
    this.statusBar.setContent(
      ` {bold}Mode:{/bold} {${modeColor}-fg}${modeName}{/${modeColor}-fg} | ${this.activeMode.getDescription()}`
    );
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
   * Handle a command
   * @param command The command to handle
   * @param args The command arguments
   * @returns True if the command was handled, false otherwise
   */
  async handleCommand(command: string, args: string[]): Promise<boolean> {
    // Check if this is a mode switch command
    if (command === 'mode' && args.length > 0) {
      return this.switchToMode(args[0]);
    }
    
    // Handle mode-specific commands
    if (this.activeMode) {
      return await this.activeMode.handleCommand(command, args);
    }
    
    return false;
  }

  /**
   * Get help text for all modes
   * @returns The help text
   */
  getHelpText(): string {
    let helpText = '{bold}Available Modes:{/bold}\n\n';
    
    this.getAllModes().forEach(mode => {
      const color = mode.getColor();
      helpText += `{${color}-fg}${mode.getIcon()} ${mode.getName()}{/${color}-fg}: ${mode.getDescription()}\n`;
      
      // Add mode-specific keybindings
      const keybindings = mode.getKeybindings();
      if (Object.keys(keybindings).length > 0) {
        helpText += '  Keybindings:\n';
        Object.entries(keybindings).forEach(([key, description]) => {
          helpText += `    {cyan-fg}${key}{/cyan-fg}: ${description}\n`;
        });
      }
      
      // Add mode-specific commands
      const commands = mode.getCommands();
      if (commands.length > 0) {
        helpText += '  Commands:\n';
        commands.forEach(command => {
          helpText += `    {cyan-fg}/${command}{/cyan-fg}\n`;
        });
      }
      
      helpText += '\n';
    });
    
    return helpText;
  }
}