import blessed from 'blessed';
import { BaseMode, ModeConfig } from './BaseMode';
import { chat } from '../../utils/api';

/**
 * Chat mode for conversational interaction
 */
export class ChatMode extends BaseMode {
  private history: { role: 'user' | 'assistant', content: string }[] = [];
  private messageBox: blessed.Widgets.BoxElement | null = null;
  private isProcessing: boolean = false;

  /**
   * Create a new chat mode
   * @param screen The blessed screen
   */
  constructor(screen: blessed.Widgets.Screen) {
    const config: ModeConfig = {
      name: 'Chat',
      description: 'Conversational chat with the assistant',
      icon: '💬',
      color: 'green',
      keybindings: {
        'Ctrl+c': 'Clear chat history',
        'Ctrl+r': 'Regenerate last response',
      },
      commands: ['clear', 'history', 'save'],
    };
    
    super(config, screen);
  }

  /**
   * Handle mode activation
   */
  protected onActivate(): void {
    // Nothing special needed on activation
  }

  /**
   * Handle mode deactivation
   */
  protected onDeactivate(): void {
    // Nothing special needed on deactivation
  }

  /**
   * Handle input in this mode
   * @param input The input to handle
   */
  async handleInput(input: string): Promise<void> {
    if (this.isProcessing) {
      this.addMessage('system', 'Still processing previous message, please wait...');
      return;
    }

    // Add user message to history
    this.addMessage('user', input);

    try {
      // Set processing flag
      this.isProcessing = true;
      this.updateMessageBox();

      // Send message to API
      const response = await chat(input);

      // Add assistant message to history
      this.addMessage('assistant', response.message);
    } catch (err) {
      this.addMessage('system', `Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      // Clear processing flag
      this.isProcessing = false;
      this.updateMessageBox();
    }
  }

  /**
   * Handle a command in this mode
   * @param command The command to handle
   * @param args The command arguments
   */
  async handleCommand(command: string, args: string[]): Promise<boolean> {
    switch (command) {
      case 'clear':
        this.history = [];
        this.updateMessageBox();
        return true;

      case 'history':
        // Show a summary of the chat history
        this.addMessage('system', `Chat history: ${this.history.length} messages`);
        return true;

      case 'save':
        // TODO: Implement saving chat history to a file
        this.addMessage('system', 'Saving chat history is not yet implemented');
        return true;

      default:
        return false;
    }
  }

  /**
   * Render mode-specific UI elements
   * @param container The container to render in
   */
  render(container: blessed.Widgets.BoxElement): void {
    // Create a message box for the chat history
    this.messageBox = blessed.box({
      parent: container,
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      scrollable: true,
      alwaysScroll: true,
      tags: true,
      padding: {
        left: 1,
        right: 1,
      },
    });

    // Update the message box with the current history
    this.updateMessageBox();
  }

  /**
   * Update the message box with the current history
   */
  private updateMessageBox(): void {
    if (!this.messageBox) {
      return;
    }

    // Clear the message box
    this.messageBox.setContent('');

    // Add each message to the message box
    this.history.forEach(message => {
      let formattedMessage = '';

      switch (message.role) {
        case 'user':
          formattedMessage = `{bold}{green-fg}You:{/green-fg}{/bold} ${message.content}`;
          break;
        case 'assistant':
          formattedMessage = `{bold}{blue-fg}Assistant:{/blue-fg}{/bold} ${message.content}`;
          break;
        default:
          formattedMessage = `{bold}{yellow-fg}System:{/yellow-fg}{/bold} ${message.content}`;
          break;
      }

      if (this.messageBox) {
        this.messageBox.pushLine(formattedMessage);
      }
    });

    // Add a processing indicator if needed
    if (this.isProcessing && this.messageBox) {
      this.messageBox.pushLine('{gray-fg}Processing...{/gray-fg}');
    }

    // Scroll to the bottom
    if (this.messageBox) {
      this.messageBox.setScrollPerc(100);
    }

    // Render the screen
    this.screen.render();
  }

  /**
   * Add a message to the history
   * @param role The message role
   * @param content The message content
   */
  private addMessage(role: 'user' | 'assistant' | 'system', content: string): void {
    if (role === 'system') {
      // System messages are not stored in history
      if (this.messageBox) {
        this.messageBox.pushLine(`{bold}{yellow-fg}System:{/yellow-fg}{/bold} ${content}`);
        this.messageBox.setScrollPerc(100);
        this.screen.render();
      }
      return;
    }

    // Add the message to history
    this.history.push({ role: role as 'user' | 'assistant', content });

    // Update the message box
    this.updateMessageBox();
  }

  /**
   * Get help text for this mode
   * @returns The help text
   */
  getHelpText(): string {
    return `
{bold}Chat Mode Help{/bold}

Chat mode allows you to have a conversation with the assistant.

{bold}Commands:{/bold}
  {cyan-fg}/clear{/cyan-fg} - Clear the chat history
  {cyan-fg}/history{/cyan-fg} - Show a summary of the chat history
  {cyan-fg}/save{/cyan-fg} - Save the chat history to a file (not yet implemented)

{bold}Keybindings:{/bold}
  {cyan-fg}Ctrl+c{/cyan-fg} - Clear chat history
  {cyan-fg}Ctrl+r{/cyan-fg} - Regenerate last response
`;
  }
}