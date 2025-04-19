import blessed from 'blessed';
import { BaseMode, ModeConfig } from './BaseMode';

/**
 * Template for creating custom modes
 * 
 * To create a new mode:
 * 1. Copy this template
 * 2. Rename the class and file
 * 3. Implement the required methods
 * 4. Register the mode in enhancedTui.ts
 */
export class CustomModeTemplate extends BaseMode {
  // Add your mode-specific properties here
  private contentBox: blessed.Widgets.BoxElement | null = null;

  /**
   * Create a new custom mode
   * @param screen The blessed screen
   */
  constructor(screen: blessed.Widgets.Screen) {
    // Configure your mode
    const config: ModeConfig = {
      name: 'CustomMode',           // The name of your mode
      description: 'Custom mode template', // A short description
      icon: '🔧',                   // An emoji icon for your mode
      color: 'magenta',             // The color for your mode (cyan, magenta, yellow, red, green, blue)
      keybindings: {
        'Ctrl+r': 'Refresh content',
        'Ctrl+c': 'Clear content',
        // Add more keybindings as needed
      },
      commands: [
        'refresh',
        'clear',
        // Add more commands as needed
      ],
    };
    
    super(config, screen);
  }

  /**
   * Handle mode activation
   * Called when the mode is activated
   */
  protected onActivate(): void {
    // Initialize your mode when activated
    // For example, load data, start timers, etc.
    console.log('Custom mode activated');
  }

  /**
   * Handle mode deactivation
   * Called when the mode is deactivated
   */
  protected onDeactivate(): void {
    // Clean up when the mode is deactivated
    // For example, stop timers, save state, etc.
    console.log('Custom mode deactivated');
  }

  /**
   * Handle input in this mode
   * Called when the user enters text in the input box
   * @param input The input to handle
   */
  async handleInput(input: string): Promise<void> {
    // Handle user input
    // This is called when the user enters text and presses Enter
    if (this.contentBox) {
      this.contentBox.pushLine(`You entered: ${input}`);
      this.screen.render();
    }
  }

  /**
   * Handle a command in this mode
   * Called when the user enters a slash command
   * @param command The command to handle
   * @param args The command arguments
   * @returns True if the command was handled, false otherwise
   */
  async handleCommand(command: string, args: string[]): Promise<boolean> {
    // Handle mode-specific commands
    // Return true if the command was handled, false otherwise
    switch (command) {
      case 'refresh':
        if (this.contentBox) {
          this.contentBox.pushLine('Refreshing content...');
          this.screen.render();
        }
        return true;

      case 'clear':
        if (this.contentBox) {
          this.contentBox.setContent('');
          this.screen.render();
        }
        return true;

      default:
        return false;
    }
  }

  /**
   * Render mode-specific UI elements
   * Called when the mode is activated and needs to render its UI
   * @param container The container to render in
   */
  render(container: blessed.Widgets.BoxElement): void {
    // Create your UI elements
    this.contentBox = blessed.box({
      parent: container,
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      scrollable: true,
      alwaysScroll: true,
      tags: true,
      border: {
        type: 'line',
      },
      style: {
        border: {
          fg: 'magenta',
        },
      },
      content: 'Welcome to the custom mode template!\n\nThis is a starting point for creating your own modes.',
    });

    // Set up event handlers
    this.contentBox.key('C-r', () => {
      if (this.contentBox) {
        this.contentBox.pushLine('Refreshing content...');
        this.screen.render();
      }
    });

    this.contentBox.key('C-c', () => {
      if (this.contentBox) {
        this.contentBox.setContent('');
        this.screen.render();
      }
    });

    // Render the screen
    this.screen.render();
  }

  /**
   * Get help text for this mode
   * @returns The help text
   */
  getHelpText(): string {
    return `
{bold}Custom Mode Help{/bold}

This is a template for creating custom modes.

{bold}Commands:{/bold}
  {cyan-fg}/refresh{/cyan-fg} - Refresh content
  {cyan-fg}/clear{/cyan-fg} - Clear content

{bold}Keybindings:{/bold}
  {cyan-fg}Ctrl+r{/cyan-fg} - Refresh content
  {cyan-fg}Ctrl+c{/cyan-fg} - Clear content
`;
  }
}