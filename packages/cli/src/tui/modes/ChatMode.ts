import { Widgets } from 'blessed';
import { BaseMode } from './BaseMode';
import { chat } from '../../utils/api';

/**
 * Chat mode for interacting with the Dome AI
 */
export class ChatMode extends BaseMode {
  /**
   * Create a new chat mode
   */
  constructor() {
    super({
      id: 'chat',
      name: 'Chat',
      description: 'Chat with Dome AI',
      shortcut: 'C-t', // Changed from C-c to C-t (for Talk)
      color: 'green',
    });
  }

  /**
   * Handle mode initialization
   */
  protected onInit(): void {
    // Nothing to initialize
  }

  /**
   * Handle mode activation
   */
  protected onActivate(): void {
    this.container.setLabel(' Chat with Dome ');
    this.container.setContent('');
    this.container.pushLine('{center}{bold}Chat Mode{/bold}{/center}');
    this.container.pushLine('{center}Type a message to chat with Dome AI{/center}');
    this.container.pushLine('');
    this.screen.render();
  }

  /**
   * Handle mode deactivation
   */
  protected onDeactivate(): void {
    // Nothing to clean up
  }

  /**
   * Handle input in this mode
   * @param input The input to handle
   */
  async handleInput(input: string): Promise<void> {
    // Display user message
    this.container.pushLine(`{bold}{green-fg}You:{/green-fg}{/bold} ${input}`);
    this.screen.render();

    try {
      // Update status
      this.statusBar.setContent(' {bold}Status:{/bold} Dome is thinking...');
      this.screen.render();

      // Send message to API
      const response = await chat(input);

      // Display response - handle the new API response format
      let message = '';
      
      if (response && response.answer) {
        message = response.answer;
      } else if (response && typeof response === 'object') {
        // Fallback to any available message property
        message = response.message || response.content || JSON.stringify(response);
      } else {
        message = String(response);
      }

      this.container.pushLine(`{bold}{blue-fg}Dome:{/blue-fg}{/bold} ${message}`);
      
      // Display sources if available
      if (response && response.sources && Array.isArray(response.sources) && response.sources.length > 0) {
        this.container.pushLine('');
        this.container.pushLine('{bold}Sources:{/bold}');
        
        response.sources.forEach((source: any, index: number) => {
          if (source.title) {
            this.container.pushLine(`${index + 1}. {underline}${source.title}{/underline}`);
          }
          if (source.snippet) {
            this.container.pushLine(`   ${source.snippet.substring(0, 100)}${source.snippet.length > 100 ? '...' : ''}`);
          }
        });
      }
      this.container.setScrollPerc(100);

      // Reset status
      this.statusBar.setContent(
        ` {bold}Mode:{/bold} {${this.config.color}-fg}${this.config.name}{/${this.config.color}-fg} | ${this.config.description}`,
      );
      this.screen.render();
    } catch (err) {
      this.container.pushLine(
        `{red-fg}Error: ${err instanceof Error ? err.message : String(err)}{/red-fg}`,
      );
      this.statusBar.setContent(
        ` {bold}Mode:{/bold} {${this.config.color}-fg}${this.config.name}{/${this.config.color}-fg} | ${this.config.description}`,
      );
      this.screen.render();
    }
  }

  /**
   * Get help text for this mode
   */
  getHelpText(): string {
    return `
{bold}Chat Mode Help{/bold}

In Chat Mode, you can have a conversation with Dome AI.

{bold}Usage:{/bold}
- Type your message and press Enter to send
- Dome will respond to your message

{bold}Commands:{/bold}
- {cyan-fg}/help{/cyan-fg} - Show this help
- {cyan-fg}/clear{/cyan-fg} - Clear the chat history

{bold}Shortcuts:{/bold}
- {cyan-fg}${this.config.shortcut}{/cyan-fg} - Switch to Chat Mode
`;
  }
}
