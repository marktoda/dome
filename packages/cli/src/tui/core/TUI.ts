import blessed from 'blessed';
import { isAuthenticated } from '../../utils/config';
import { error } from '../../utils/ui';
import { ModeManager } from './ModeManager';
import { CommandManager } from './CommandManager';
import { Mode, CommandHandler, TUIContext } from './types';

/**
 * Main TUI class
 */
export class TUI {
  private screen: blessed.Widgets.Screen;
  private container!: blessed.Widgets.BoxElement;
  private sidebar!: blessed.Widgets.BoxElement;
  private statusBar!: blessed.Widgets.BoxElement;
  private inputBox!: blessed.Widgets.TextboxElement;
  private modeManager!: ModeManager;
  private commandManager!: CommandManager;
  private context!: TUIContext;

  /**
   * Create a new TUI instance
   */
  constructor() {
    // Check if user is authenticated
    if (!isAuthenticated()) {
      console.log(error('You need to login first. Run `dome login` to authenticate.'));
      process.exit(1);
    }

    // Create a screen object with proper configuration
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Dome CLI',
      fullUnicode: true,
      sendFocus: true,
      useBCE: true,
      cursor: {
        artificial: true,
        shape: 'line',
        blink: true,
        color: 'cyan',
      },
      keys: true,
      grabKeys: true, // Grab all key events
      ignoreLocked: ['C-c'], // Don't ignore Ctrl+C even when locked
      dockBorders: true,
      autoPadding: true,
      fastCSR: true, // Use fast CSR for better performance
      terminal: 'xterm-256color', // Explicitly set terminal type
    });

    // Add a direct handler for stdin to catch Ctrl+J at the lowest level
    process.stdin.on('data', data => {
      // Check for Ctrl+J (ASCII 10) and Ctrl+K (ASCII 11)
      if (data.length === 1) {
        if (data[0] === 10) {
          // Ctrl+J
          this.container.scroll(5);
          this.screen.render();
        } else if (data[0] === 11) {
          // Ctrl+K
          this.container.scroll(-5);
          this.screen.render();
        }
      }
    });

    // Create the layout
    this.createLayout();

    // Create the command manager
    this.commandManager = new CommandManager();

    // Create the context
    this.context = {
      screen: this.screen,
      container: this.container,
      sidebar: this.sidebar,
      statusBar: this.statusBar,
      inputBox: this.inputBox,
      addMessage: this.addMessage.bind(this),
      setStatus: this.setStatus.bind(this),
      updateSidebar: this.updateSidebar.bind(this),
    };

    // Create the mode manager
    this.modeManager = new ModeManager(
      this.screen,
      this.container,
      this.statusBar,
      this.handleInput.bind(this),
      this.handleModeChange.bind(this),
    );

    // Add direct key handlers for mode switching
    this.screen.on('keypress', (ch, key) => {
      if (!key || !key.ctrl) return;

      // Handle specific mode shortcuts
      if (key.name === 'e') {
        this.modeManager.switchToMode('explore');
        return false;
      } else if (key.name === 'n') {
        this.modeManager.switchToMode('note');
        return false;
      } else if (key.name === 't') {
        this.modeManager.switchToMode('chat');
        return false;
      }
    });

    // Initial sidebar update
    this.updateSidebar();

    // Set up event handlers
    this.setupEventHandlers();
  }

  /**
   * Create the TUI layout
   */
  private createLayout(): void {
    // Create a header
    const header = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: '100%',
      height: 1,
      content: '{center}{bold}Dome CLI{/bold}{/center}',
      tags: true,
      style: {
        fg: 'cyan',
        bold: true,
      },
    });

    // Create the sidebar
    this.sidebar = blessed.box({
      parent: this.screen,
      top: 1,
      left: 0,
      width: '30%',
      height: '100%-2',
      tags: true,
      border: {
        type: 'line',
      },
      style: {
        border: {
          fg: 'blue',
        },
      },
      padding: {
        left: 1,
        right: 1,
      },
      label: ' Info ',
    });

    // Create the main container
    this.container = blessed.box({
      parent: this.screen,
      top: 1,
      left: '30%',
      width: '70%',
      height: '100%-3', // Changed from '100%-2' to '100%-3' to make room for the prompt
      scrollable: true,
      alwaysScroll: true,
      scrollbar: {
        ch: '█',
        track: {
          bg: 'black',
        },
        style: {
          inverse: true,
        },
      },
      keys: true,
      vi: true, // Enable vi-like scrolling
      mouse: true,
      tags: true,
      border: {
        type: 'line',
      },
      style: {
        border: {
          fg: 'blue',
        },
      },
      padding: {
        left: 1,
        right: 1,
      },
      label: ' Output ',
      keyable: true, // Ensure element can receive key events
      grabKeys: true, // Grab all key events
      clickable: true, // Allow clicking
    });

    // Create the status bar
    this.statusBar = blessed.box({
      parent: this.screen,
      bottom: 1,
      left: 0,
      width: '100%',
      height: 1,
      content:
        ' {bold}Mode:{/bold} None | Type a message or command | Tab to focus | Ctrl+j/k, Alt+j/k, F1/F2 to scroll | Ctrl+C to exit',
      tags: true,
      style: {
        fg: 'cyan',
      },
    });

    // Create a box for the input prompt
    const inputPrompt = blessed.box({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: '100%',
      height: 3,
      tags: true,
      border: {
        type: 'line',
      },
      style: {
        border: {
          fg: 'blue',
        },
      },
      label: ' Prompt ',
    });

    // Create the input box
    this.inputBox = blessed.textbox({
      parent: inputPrompt,
      top: 0,
      left: 1,
      width: '100%-2',
      height: 1,
      inputOnFocus: true,
      style: {
        fg: 'white',
        focus: {
          fg: 'cyan',
        },
      },
      keys: true,
      mouse: true,
      input: true,
      vi: true,
      ignoreKeys: false, // Don't ignore any keys
      grabKeys: true, // Grab all key events
      keyable: true, // Ensure element can receive key events
      // Explicitly define which keys should be captured by the input
      // and not passed to the parent screen
      forceUnicode: true,
      censor: false,
    });

    // Add a special handler for the input box to capture Ctrl+J/K and mode shortcuts
    this.inputBox.on('keypress', (ch, key) => {
      if (!key) return;

      // Handle Ctrl+J for scrolling down
      if ((key.ctrl && (key.name === 'j' || key.name === 'n')) || ch === '\n' || ch === '\x0A') {
        this.container.scroll(5);
        this.screen.render();
        return false;
      }

      // Handle Ctrl+K for scrolling up
      if ((key.ctrl && (key.name === 'k' || key.name === 'p')) || ch === '\x0B') {
        this.container.scroll(-5);
        this.screen.render();
        return false;
      }

      // Handle mode shortcuts
      if (key.ctrl) {
        if (key.name === 'e') {
          this.modeManager.switchToMode('explore');
          return false;
        } else if (key.name === 'n') {
          this.modeManager.switchToMode('note');
          return false;
        } else if (key.name === 't') {
          this.modeManager.switchToMode('chat');
          return false;
        }
      }
    });
  }

  /**
   * Set up event handlers
   */
  private setupEventHandlers(): void {
    // Clean exit handler
    const exitHandler = () => {
      this.screen.destroy();
      process.exit(0);
    };

    // Set up signal handlers
    process.on('SIGINT', exitHandler);
    process.on('SIGTERM', exitHandler);

    // Set up key bindings
    this.screen.key(['C-c', 'q'], exitHandler);
    this.inputBox.key(['C-c', 'escape'], exitHandler);

    // Add scrollback functionality - register on both screen and input box
    const scrollDownHandler = () => {
      // Scroll down
      this.container.scroll(5);
      this.screen.render();
      return false; // Prevent default handling
    };

    const scrollUpHandler = () => {
      // Scroll up
      this.container.scroll(-5);
      this.screen.render();
      return false; // Prevent default handling
    };

    // Handle raw input events for Ctrl+J specifically
    this.screen.on('keypress', (ch, key) => {
      // Check for Ctrl+J (which can be represented in multiple ways)
      if (
        (key && key.ctrl && (key.name === 'j' || key.name === 'n')) ||
        ch === '\n' ||
        ch === '\x0A'
      ) {
        scrollDownHandler();
        return false;
      }

      // Check for Ctrl+K
      if ((key && key.ctrl && (key.name === 'k' || key.name === 'p')) || ch === '\x0B') {
        scrollUpHandler();
        return false;
      }
    });

    // Also try the standard key binding approach as a fallback
    this.screen.key(['C-j', 'C-J', '\x0A', 'C-n'], scrollDownHandler); // \x0A is the ASCII code for Ctrl+J
    this.screen.key(['C-k', 'C-K', '\x0B', 'C-p'], scrollUpHandler); // \x0B is the ASCII code for Ctrl+K

    // Also register on input box to ensure they work when input is focused
    this.inputBox.key(['C-j', 'C-J', '\x0A', 'C-n'], scrollDownHandler);
    this.inputBox.key(['C-k', 'C-K', '\x0B', 'C-p'], scrollUpHandler);

    // Add direct key handlers for the container
    this.container.key(['C-j', 'C-J', '\x0A', 'C-n'], scrollDownHandler);
    this.container.key(['C-k', 'C-K', '\x0B', 'C-p'], scrollUpHandler);

    // Also add vi-like scrolling with j/k when container is focused
    this.container.key('j', () => {
      this.container.scroll(1);
      this.screen.render();
    });

    this.container.key('k', () => {
      this.container.scroll(-1);
      this.screen.render();
    });

    // Add alternative key bindings for scrolling (using Alt+J/K as alternatives)
    this.screen.key(['M-j', 'S-down'], scrollDownHandler);
    this.screen.key(['M-k', 'S-up'], scrollUpHandler);
    this.inputBox.key(['M-j', 'S-down'], scrollDownHandler);
    this.inputBox.key(['M-k', 'S-up'], scrollUpHandler);

    // Add function key alternatives
    this.screen.key('f1', scrollUpHandler);
    this.screen.key('f2', scrollDownHandler);
    this.inputBox.key('f1', scrollUpHandler);
    this.inputBox.key('f2', scrollDownHandler);

    // Add focus toggle between input and container
    this.screen.key('tab', () => {
      if (this.screen.focused === this.inputBox) {
        this.container.focus();
      } else {
        this.inputBox.focus();
      }
      this.screen.render();
    });

    // Override the default Enter key behavior to prevent conflicts with Ctrl+J
    // This is necessary because Ctrl+J can be interpreted as Enter in some terminals
    this.inputBox.removeAllListeners('keypress');
    this.inputBox.on('keypress', (ch, key) => {
      if (key && key.name === 'return' && !key.ctrl) {
        // Only submit on plain Enter, not on Ctrl+J
        this.inputBox.submit();
      }
    });

    // Handle input submission
    this.inputBox.on('submit', async (data: string) => {
      const input = data.trim();

      if (!input) {
        this.inputBox.clearValue();
        this.inputBox.focus();
        return;
      }

      // Clear the input box immediately
      this.inputBox.clearValue();
      this.screen.render();

      try {
        // Handle slash commands
        if (input.startsWith('/')) {
          const handled = await this.commandManager.handleCommand(input);
          if (!handled) {
            this.addMessage(`{red-fg}Unknown command: ${input.split(' ')[0]}{/red-fg}`);
          }
        } else {
          // Handle regular input in the active mode
          await this.modeManager.handleInput(input);
        }
      } catch (err) {
        this.addMessage(
          `{red-fg}Unexpected error: ${err instanceof Error ? err.message : String(err)}{/red-fg}`,
        );
      }

      // Always make sure the input box regains focus after processing
      this.inputBox.focus();
      this.screen.render();
    });
  }

  /**
   * Add a message to the output
   * @param message The message to add
   */
  private addMessage(message: string): void {
    this.container.pushLine(message);
    this.container.setScrollPerc(100);
    this.screen.render();
  }

  /**
   * Set the status bar content
   * @param status The status to set
   */
  private setStatus(status: string): void {
    this.statusBar.setContent(status);
    this.screen.render();
  }

  // This section is intentionally left empty to remove the duplicate method

  /**
   * Handle input in the active mode
   * @param input The input to handle
   */
  private async handleInput(input: string): Promise<void> {
    const activeMode = this.modeManager.getActiveMode();
    if (!activeMode) {
      this.addMessage(
        '{yellow-fg}No active mode. Use /mode <name> to switch to a mode.{/yellow-fg}',
      );
      return;
    }

    await activeMode.handleInput(input);
  }

  /**
   * Register modes
   * @param modes The modes to register
   */
  registerModes(modes: Mode[]): void {
    this.modeManager.registerModes(modes);
    this.modeManager.setupShortcuts();
  }

  /**
   * Register commands
   * @param commands The commands to register
   */
  registerCommands(commands: CommandHandler[]): void {
    this.commandManager.registerCommands(commands);
  }

  /**
   * Start the TUI
   * @param defaultModeId The ID of the default mode to activate
   */
  start(defaultModeId: string): void {
    // Add a welcome message
    this.addMessage('{center}{bold}Welcome to Dome CLI{/bold}{/center}');
    this.addMessage('{center}Type a message to chat with Dome or use slash commands{/center}');
    this.addMessage('{center}Type {bold}/help{/bold} for available commands{/center}');
    this.addMessage('');

    // Switch to the default mode
    const success = this.modeManager.switchToMode(defaultModeId);
    if (!success) {
      this.addMessage(`{red-fg}Error: Default mode "${defaultModeId}" not found{/red-fg}`);
    }

    // Focus the input box
    this.inputBox.focus();

    // Render the screen
    this.screen.render();
  }

  /**
   * Update the sidebar content
   */
  private updateSidebar(): void {
    const activeMode = this.modeManager.getActiveMode();
    let content = '{center}{bold}Dome CLI{/bold}{/center}\n\n';

    // Add modes section
    content += '{bold}Modes:{/bold}\n';
    this.modeManager.getAllModes().forEach(mode => {
      const config = mode.getConfig();
      const isActive = activeMode === mode;
      const prefix = isActive ? '▶ ' : '  ';
      content += `${prefix}{${config.color}-fg}${config.name}{/${config.color}-fg}\n`;
    });

    // Add keybindings section
    content += '\n{bold}Keybindings:{/bold}\n';
    this.modeManager.getAllModes().forEach(mode => {
      const config = mode.getConfig();
      content += `  {cyan-fg}${config.shortcut}{/cyan-fg} - ${config.name} Mode\n`;
    });

    // Add commands section
    content += '\n{bold}Commands:{/bold}\n';
    this.commandManager.getAllCommands().forEach(command => {
      content += `  {cyan-fg}/${command.getName()}{/cyan-fg}\n`;
    });

    // Add navigation section
    content += '\n{bold}Navigation:{/bold}\n';
    content +=
      '  {cyan-fg}Ctrl+j{/cyan-fg} or {cyan-fg}Alt+j{/cyan-fg} or {cyan-fg}F2{/cyan-fg} - Scroll down\n';
    content +=
      '  {cyan-fg}Ctrl+k{/cyan-fg} or {cyan-fg}Alt+k{/cyan-fg} or {cyan-fg}F1{/cyan-fg} - Scroll up\n';
    content += '  {cyan-fg}Tab{/cyan-fg} - Toggle focus\n';
    content += '  {cyan-fg}j/k{/cyan-fg} - Scroll when focused\n';

    // Add help section
    content += '\n{bold}Help:{/bold}\n';
    content += '  Type {cyan-fg}/help{/cyan-fg} for more info\n';
    content += '  Press {cyan-fg}Ctrl+C{/cyan-fg} to exit\n';

    // Set the sidebar content
    this.sidebar.setContent(content);
    this.screen.render();
  }

  /**
   * Handle mode change
   * @param mode The new active mode
   */
  private handleModeChange(mode: Mode): void {
    const config = mode.getConfig();
    this.setStatus(
      ` {bold}Mode:{/bold} {${config.color}-fg}${config.name}{/${config.color}-fg} | ${config.description} | Tab to focus | Ctrl+j/k, Alt+j/k, F1/F2 to scroll`,
    );
    this.updateSidebar();
  }

  /**
   * Get the TUI context
   * @returns The TUI context
   */
  getContext(): TUIContext {
    return this.context;
  }

  /**
   * Get the mode manager
   * @returns The mode manager
   */
  getModeManager(): ModeManager {
    return this.modeManager;
  }

  /**
   * Get the command manager
   * @returns The command manager
   */
  getCommandManager(): CommandManager {
    return this.commandManager;
  }
}
