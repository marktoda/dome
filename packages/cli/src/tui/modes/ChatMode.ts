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

    // More conservative space reservation for safety margin
    const safeWidth = Math.max(containerWidth - 4, 10);

    // Add maximum text length protection
    const maxTextLength = 5000; // Reasonable limit
    if (text && text.length > maxTextLength) {
      text = text.substring(0, maxTextLength) + '... [content truncated due to length]';
    }

    // Handle empty or undefined text
    if (!text) {
      this.container.pushLine('');
      return;
    }

    // Split the text into lines and handle each line
    const lines = text.split('\n');

    // Limit number of lines to prevent overflow
    const maxLines = 300;
    if (lines.length > maxLines) {
      const truncatedLines = lines.slice(0, maxLines);
      truncatedLines.push('... [additional lines truncated]');
      this.container.pushLine('{yellow-fg}Message truncated due to excessive length{/yellow-fg}');
      lines.length = 0; // Clear the array
      lines.push(...truncatedLines); // Replace with truncated version
    }

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

          // Break up the long word with improved handling
          while (word.length > safeWidth) {
            const chunk = word.substring(0, safeWidth - 1) + '-';
            this.container.pushLine(chunk);
            word = word.substring(safeWidth - 1);

            // Safety check to prevent infinite loops with very long words
            if (this.getContainerLines().length > 500) {
              this.container.pushLine('... [content truncated - word too long]');
              word = '';
              break;
            }
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

    // Enforce overall container size limits
    this.enforceContentLimits();
  }

  /**
   * Safely get lines from the container
   * @returns Array of lines in the container
   */
  private getContainerLines(): string[] {
    try {
      // Try to use getLines() method if available
      if (typeof this.container.getLines === 'function') {
        return this.container.getLines();
      }

      // Fallback: get content and split by newlines
      const content = this.container.getContent();
      if (content && typeof content === 'string') {
        return content.split('\n');
      }

      // Last resort: get content via property access
      const containerAny = this.container as any;
      if (containerAny.content && typeof containerAny.content === 'string') {
        return containerAny.content.split('\n');
      }

      return [];
    } catch (err) {
      // Return empty array on error
      return [];
    }
  }

  /**
   * Enforce content limits to prevent overflow
   */
  private enforceContentLimits(): void {
    try {
      const maxTotalLines = 1000;
      const lines = this.getContainerLines();

      if (lines && lines.length > maxTotalLines) {
        // Keep header (first 3 lines) and most recent content
        const headerLines = 3;
        const linesToKeep = maxTotalLines - headerLines - 1;

        const newContent = [
          ...lines.slice(0, headerLines),
          '{yellow-fg}[Older messages removed to prevent overflow]{/yellow-fg}',
          ...lines.slice(lines.length - linesToKeep)
        ].join('\n');

        this.container.setContent(newContent);
      }
    } catch (err) {
      // Silently handle any errors in the content limiting logic
      // to prevent cascading failures
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
    // Configure container for optimal text handling
    this.configureContainer();

    this.container.setLabel(' Chat with Dome ');
    this.container.setContent('');
    this.container.pushLine('{center}{bold}Chat Mode{/bold}{/center}');
    this.container.pushLine('{center}Type a message to chat with Dome AI{/center}');
    this.container.pushLine('');
    this.screen.render();
  }

  /**
   * Configure the container for optimal text handling
   */
  private configureContainer(): void {
    // Ensure the container is properly configured for text display
    if (this.container) {
      // Use type casting to avoid TypeScript errors
      const container = this.container as any;

      // Enable scrolling
      container.scrollable = true;
      container.alwaysScroll = true;

      // Configure scrollbar
      container.scrollbar = {
        ch: '█',
        track: {
          bg: 'black',
        },
        style: {
          inverse: true,
        },
      };

      // Enable mouse and keyboard navigation
      container.keys = true;
      container.vi = true;
      container.mouse = true;

      // Set padding for better text display
      container.padding = {
        left: 1,
        right: 1,
        top: 0,
        bottom: 0,
      };

      // Ensure word wrapping is enabled but let our custom wrapping handle most cases
      container.wrap = false;

      // Set a reasonable height limit for each line to prevent overflow
      container.lineLimit = 300;

      // Check if container content is already too large and trim if needed
      this.enforceContentLimits();
    }
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
    // Ensure container is properly configured
    this.configureContainer();

    // Add a separator line for better readability
    this.container.pushLine('');

    // Display user message with proper wrapping
    this.container.pushLine(`{bold}{green-fg}You:{/green-fg}{/bold}`);

    // Get the container width (minus padding and borders)
    const containerWidth = (this.container as any).width - 4;

    // Use the helper function to wrap the text
    this.wrapText(input, containerWidth);

    // Ensure we scroll to the bottom after adding content
    this.container.setScrollPerc(100);
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

        if (apiResponse === undefined) {
          message = "Sorry, I couldn't generate a response at this time.";
        } else if (typeof apiResponse === 'string') {
          // If the response is already a string, use it directly
          // Apply length limit to prevent overflow
          message = apiResponse.length > 10000 ?
            apiResponse.substring(0, 10000) + '... [response truncated due to length]' :
            apiResponse;
        } else if (apiResponse && apiResponse.success === false && apiResponse.error) {
          // Handle error responses that include an error message
          const errorMsg = apiResponse.error.message || 'Unknown error';
          // Truncate error messages to prevent overflow
          const truncatedError = errorMsg.length > 500 ?
            errorMsg.substring(0, 500) + '... [error truncated]' :
            errorMsg;

          message = apiResponse.response || `Error: ${truncatedError}`;

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
          // Apply length limit to prevent overflow
          message = apiResponse.answer.length > 10000 ?
            apiResponse.answer.substring(0, 10000) + '... [response truncated due to length]' :
            apiResponse.answer;
        } else if (apiResponse && typeof apiResponse === 'object') {
          try {
            // Format and truncate JSON responses
            const jsonString = JSON.stringify(apiResponse, null, 2);
            message = jsonString.length > 2000 ?
              jsonString.substring(0, 2000) + '... [JSON response truncated]' :
              jsonString;
          } catch (e) {
            // Fallback to any available message property with truncation
            message = (
              apiResponse.message ||
              apiResponse.content ||
              apiResponse.response ||
              String(apiResponse)
            );

            if (message.length > 5000) {
              message = message.substring(0, 5000) + '... [response truncated due to length]';
            }
          }
        } else {
          const stringResponse = String(apiResponse);
          message = stringResponse.length > 5000 ?
            stringResponse.substring(0, 5000) + '... [response truncated due to length]' :
            stringResponse;
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
            this.displaySources(apiResponse.sources, containerWidth);
          }
        } catch (sourceError) {
          // Ignore errors when processing sources
          this.container.pushLine('{italic}(Error displaying sources){/italic}');
        }
      } catch (chatError) {
        // Handle any exceptions during the chat API call
        this.container.pushLine(`{bold}{red-fg}Error:{/red-fg}{/bold}`);
        const errorMessage = chatError instanceof Error ? chatError.message : String(chatError);
        const truncatedError = errorMessage.length > 500 ?
          errorMessage.substring(0, 500) + '... [error message truncated]' :
          errorMessage;

        this.wrapText(
          `I encountered an error while processing your request: ${truncatedError}`,
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
      const errorMessage = err instanceof Error ? err.message : String(err);
      const truncatedError = errorMessage.length > 500 ?
        errorMessage.substring(0, 500) + '... [error message truncated]' :
        errorMessage;

      this.container.pushLine(
        `{red-fg}Error: ${truncatedError}{/red-fg}`,
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

  /**
   * Display sources in a controlled manner to prevent overflow
   * @param sources Array of source objects
   * @param containerWidth Width of the container for wrapping
   */
  private displaySources(sources: any[], containerWidth: number): void {
    try {
      // Limit the number of sources to display
      const maxSources = 5;
      const sourcesToDisplay = sources.length > maxSources ?
        sources.slice(0, maxSources) :
        sources;

      this.container.pushLine('');
      this.container.pushLine('{bold}Sources:{/bold}');

      if (sources.length > maxSources) {
        this.container.pushLine(`{italic}(Showing ${maxSources} of ${sources.length} sources){/italic}`);
      }

      sourcesToDisplay.forEach((source: any, index: number) => {
        // Handle title with truncation if needed
        if (source.title) {
          const title = source.title.length > 80 ?
            source.title.substring(0, 80) + '...' :
            source.title;
          this.container.pushLine(`${index + 1}. {underline}${title}{/underline}`);
        }

        // Handle snippet with truncation
        if (source.snippet) {
          const snippet = source.snippet.substring(0, 100) +
            (source.snippet.length > 100 ? '...' : '');

          // Use the wrapping function to handle long snippets properly
          this.container.pushLine('   '); // Indent
          this.wrapText(snippet, containerWidth - 3); // Account for indent
        }
      });
    } catch (err) {
      // Silently handle errors in source display
      this.container.pushLine('{italic}(Error formatting sources){/italic}');
    }
  }
}
