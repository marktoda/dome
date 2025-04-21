import { Widgets } from 'blessed';
import { BaseMode } from './BaseMode';
import { chat } from '../../utils/api';

/**
 * Chat mode for interacting with the Dome AI
 */
export class ChatMode extends BaseMode {
  /**
   * Helper function to wrap text to fit the container width
   * @param text The text to wrap
   * @param containerWidth The width of the container
   * @returns void - pushes lines directly to the container
   */
  /**
   * Enhanced text wrapping function that handles various edge cases
   * @param text The text to wrap
   * @param containerWidth The width of the container
   * @returns void - pushes lines directly to the container
   */
  private wrapText(text: string, containerWidth: number): void {
    // Safety check for container width
    if (containerWidth <= 0) {
      containerWidth = 80; // Fallback to a reasonable default
    }
    
    // Reserve some space for safety margin
    const safeWidth = Math.max(containerWidth - 2, 10);
    
    // Handle empty or undefined text
    if (!text) {
      this.container.pushLine('');
      return;
    }
    
    // Split the text into lines and handle each line
    const lines = text.split('\n');
    for (const line of lines) {
      // Skip empty lines but preserve them in output
      if (line.trim() === '') {
        this.container.pushLine('');
        continue;
      }
      
      // If the line is shorter than the safe width, add it directly
      if (line.length <= safeWidth) {
        this.container.pushLine(line);
        continue;
      }
      
      // For longer lines, use word-based wrapping when possible
      let currentLine = '';
      const words = line.split(' ');
      
      for (let i = 0; i < words.length; i++) {
        let word = words[i];
        
        // Handle very long words (like URLs) by breaking them up
        if (word.length > safeWidth) {
          // If we have content in the current line, push it first
          if (currentLine) {
            this.container.pushLine(currentLine);
            currentLine = '';
          }
          
          // Break up the long word
          while (word.length > safeWidth) {
            const chunk = word.substring(0, safeWidth - 1) + '-';
            this.container.pushLine(chunk);
            word = word.substring(safeWidth - 1);
          }
          
          // Add the remainder to the current line
          currentLine = word;
        } else {
          // Check if adding this word would exceed the line width
          const testLine = currentLine ? currentLine + ' ' + word : word;
          
          if (testLine.length <= safeWidth) {
            currentLine = testLine;
          } else {
            // Line would be too long, push current line and start a new one
            this.container.pushLine(currentLine);
            currentLine = word;
          }
        }
      }
      
      // Push any remaining content
      if (currentLine) {
        this.container.pushLine(currentLine);
      }
    }
  }
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
    // Display user message with proper wrapping
    this.container.pushLine(`{bold}{green-fg}You:{/green-fg}{/bold}`);

    // Get the container width (minus padding and borders)
    const containerWidth = (this.container as any).width - 4;

    // Use the helper function to wrap the text
    this.wrapText(input, containerWidth);

    this.screen.render();

    try {
      // Update status
      this.statusBar.setContent(' {bold}Status:{/bold} Dome is thinking...');
      this.screen.render();

      // Send message to API
      try {
        const apiResponse = await chat(input);

        // Display response - handle the new API response format
        let message = '';

        console.log('Chat response received:', typeof apiResponse, apiResponse);

        if (apiResponse === undefined) {
          message = "Sorry, I couldn't generate a response at this time.";
        } else if (typeof apiResponse === 'string') {
          // If the response is already a string, use it directly
          message = apiResponse;
        } else if (apiResponse && apiResponse.success === false && apiResponse.error) {
          // Handle error responses that include an error message
          message =
            apiResponse.response || `Error: ${apiResponse.error.message || 'Unknown error'}`;
          // Add error styling
          this.container.pushLine(`{bold}{red-fg}Error:{/red-fg}{/bold}`);
          this.wrapText(message, containerWidth);

          // Reset status and render
          this.statusBar.setContent(
            ` {bold}Mode:{/bold} {${this.config.color}-fg}${this.config.name}{/${this.config.color}-fg} | ${this.config.description}`,
          );
          this.screen.render();
          return;
        } else if (apiResponse && apiResponse.answer) {
          message = apiResponse.answer;
        } else if (apiResponse && typeof apiResponse === 'object') {
          // Fallback to any available message property
          message =
            apiResponse.message ||
            apiResponse.content ||
            apiResponse.response ||
            JSON.stringify(apiResponse);
        } else {
          message = String(apiResponse);
        }

        // Add the Dome label
        this.container.pushLine(`{bold}{blue-fg}Dome:{/blue-fg}{/bold}`);

        // Use the helper function to wrap the text
        this.wrapText(message, containerWidth);

        // Display sources if available
        try {
          if (
            apiResponse &&
            apiResponse.sources &&
            Array.isArray(apiResponse.sources) &&
            apiResponse.sources.length > 0
          ) {
            this.container.pushLine('');
            this.container.pushLine('{bold}Sources:{/bold}');

            apiResponse.sources.forEach((source: any, index: number) => {
              if (source.title) {
                this.container.pushLine(`${index + 1}. {underline}${source.title}{/underline}`);
              }
              if (source.snippet) {
                this.container.pushLine(
                  `   ${source.snippet.substring(0, 100)}${
                    source.snippet.length > 100 ? '...' : ''
                  }`,
                );
              }
            });
          }
        } catch (sourceError) {
          // Ignore errors when processing sources
          this.container.pushLine('{italic}(Error displaying sources){/italic}');
        }
      } catch (chatError) {
        // Handle any exceptions during the chat API call
        this.container.pushLine(`{bold}{red-fg}Error:{/red-fg}{/bold}`);
        const errorMessage = chatError instanceof Error ? chatError.message : String(chatError);
        this.wrapText(
          `I encountered an error while processing your request: ${errorMessage}`,
          containerWidth,
        );
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
