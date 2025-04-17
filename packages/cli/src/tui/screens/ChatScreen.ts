import blessed from 'blessed';
import { BaseLayoutElements } from '../layouts/BaseLayout';
import { Screen } from '../ScreenManager';
import { chat } from '../../utils/api';

/**
 * Create the chat screen
 * @param layout The base layout elements
 * @returns The chat screen
 */
export function createChatScreen(layout: BaseLayoutElements): Screen {
  // Create the main container
  const element = blessed.box({
    parent: layout.mainContent,
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    tags: true,
  });

  // Create the chat messages container
  const messagesBox = blessed.box({
    parent: element,
    top: 0,
    left: 0,
    width: '100%',
    height: '90%-3',
    scrollable: true,
    alwaysScroll: true,
    tags: true,
    style: {
      fg: 'white',
    },
    content: '{center}{bold}Chat with Dome{/bold}{/center}\n{center}Type your message below and press Enter to send{/center}\n\n',
    padding: {
      left: 1,
      right: 1,
    },
  });

  // Create the input box
  const inputBox = blessed.textbox({
    parent: element,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 3,
    inputOnFocus: true,
    border: {
      type: 'line',
    },
    style: {
      fg: 'white',
      border: {
        fg: 'cyan',
      },
    },
  });

  // Create a loading indicator
  const loadingIndicator = blessed.loading({
    parent: element,
    top: 'center',
    left: 'center',
    width: 20,
    height: 3,
    border: {
      type: 'line',
    },
    style: {
      border: {
        fg: 'cyan',
      },
    },
  });

  // Handle input submission
  inputBox.key('enter', async () => {
    const message = inputBox.getValue();
    if (message.trim()) {
      // Add user message to chat
      messagesBox.setContent(messagesBox.getContent() + `\n{bold}{green-fg}You:{/green-fg}{/bold} ${message}`);
      messagesBox.setScrollPerc(100);
      layout.screen.render();
      
      // Clear input
      inputBox.clearValue();
      layout.screen.render();
      
      try {
        // Show loading indicator
        loadingIndicator.load('Thinking...');
        
        // Send message to API
        const response = await chat(message);
        
        // Hide loading indicator
        loadingIndicator.stop();
        
        // Add assistant response to chat
        messagesBox.setContent(messagesBox.getContent() + `\n{bold}{blue-fg}Dome:{/blue-fg}{/bold} ${response.message}`);
        messagesBox.setScrollPerc(100);
        layout.screen.render();
      } catch (err) {
        // Hide loading indicator
        loadingIndicator.stop();
        
        // Add error message to chat
        messagesBox.setContent(messagesBox.getContent() + `\n{bold}{red-fg}Error:{/red-fg}{/bold} ${err instanceof Error ? err.message : String(err)}`);
        messagesBox.setScrollPerc(100);
        layout.screen.render();
      }
    }
  });

  // Handle escape key to return to sidebar
  inputBox.key('escape', () => {
    layout.sidebar.focus();
  });

  return {
    id: 'chat',
    title: 'Chat',
    element,
    onFocus: () => {
      // Focus the input box when the chat screen is shown
      inputBox.focus();
    },
  };
}