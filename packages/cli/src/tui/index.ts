#!/usr/bin/env node

import blessed from 'blessed';
import contrib from 'blessed-contrib';
import { loadConfig, isAuthenticated } from '../utils/config';
import { error } from '../utils/ui';
import { chat } from '../utils/api';
import { listNotes, listTasks } from '../utils/api';

/**
 * Start the TUI with a prompt-based interface
 */
export function startPromptTui(): void {
  // Check if user is authenticated
  if (!isAuthenticated()) {
    console.log(error('You need to login first. Run `dome login` to authenticate.'));
    process.exit(1);
  }

  // Create a screen object
  const screen = blessed.screen({
    smartCSR: true,
    title: 'Dome CLI',
    autoPadding: true,
    fullUnicode: true,
  });

  // Set key bindings for global navigation
  screen.key(['C-c'], () => {
    // Clean up and exit
    screen.destroy();
    process.exit(0);
  });

  // Also handle SIGINT (Ctrl+C) at the process level
  process.on('SIGINT', () => {
    // Clean up and exit
    screen.destroy();
    process.exit(0);
  });

  // Enable key handling for the entire program
  screen.enableKeys();
  screen.enableInput();

  // Enable key handling for the entire program
  screen.enableKeys();
  screen.enableInput();

  // Create a layout grid
  const grid = new contrib.grid({
    rows: 12,
    cols: 12,
    screen: screen,
  });

  // Create a header
  const header = grid.set(0, 0, 1, 12, blessed.box, {
    content: '{center}{bold}Dome CLI{/bold}{/center}',
    tags: true,
    style: {
      fg: 'cyan',
      bold: true,
    },
  });

  // Create a sidebar for quick actions
  const sidebar = grid.set(1, 0, 9, 3, blessed.box, {
    label: ' Quick Actions ',
    tags: true,
    border: {
      type: 'line',
    },
    style: {
      border: {
        fg: 'blue',
      },
    },
    content:
      '\n{bold}Commands:{/bold}\n\n' +
      ' {cyan-fg}/add{/cyan-fg} - Add content\n' +
      ' {cyan-fg}/note{/cyan-fg} - Add a note\n' +
      ' {cyan-fg}/list{/cyan-fg} - List items\n' +
      ' {cyan-fg}/search{/cyan-fg} - Search\n' +
      ' {cyan-fg}/help{/cyan-fg} - Show help\n' +
      ' {cyan-fg}/exit{/cyan-fg} - Exit\n\n' +
      '{bold}Shortcuts:{/bold}\n\n' +
      ' {cyan-fg}Ctrl+n{/cyan-fg} - Note mode\n' +
      ' {cyan-fg}Ctrl+l{/cyan-fg} - List mode\n' +
      ' {cyan-fg}Ctrl+s{/cyan-fg} - Search mode\n' +
      ' {cyan-fg}Ctrl+h{/cyan-fg} - Help\n' +
      ' {cyan-fg}Ctrl+c{/cyan-fg} - Exit',
  });

  // Create a box for the output/history
  const outputBox = grid.set(1, 3, 9, 9, blessed.box, {
    scrollable: true,
    alwaysScroll: true,
    tags: true,
    label: ' Output ',
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
  });

  // Create a status bar
  const statusBar = grid.set(10, 0, 1, 12, blessed.box, {
    content: ' {bold}Mode:{/bold} Chat | Type a message or command',
    tags: true,
    style: {
      fg: 'cyan',
      bold: true,
    },
  });

  // Create a prompt for input
  const inputBox = grid.set(11, 0, 1, 12, blessed.textbox, {
    inputOnFocus: true,
    style: {
      fg: 'white',
      bg: 'black',
      focus: {
        fg: 'cyan',
        bg: 'black',
        bold: true,
      },
    },
  });

  // Create a system info box
  const sysInfoBox = blessed.box({
    parent: sidebar,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 3,
    content: `{right}v0.1.0{/right}`,
    tags: true,
    style: {
      fg: 'gray',
    },
  });

  // Current mode
  let currentMode = 'chat';

  // Set the status line based on the current mode
  function updateStatusLine(mode: string): void {
    statusBar.setContent(
      ` {bold}Mode:{/bold} ${
        mode.charAt(0).toUpperCase() + mode.slice(1)
      } | Type a message or command`,
    );
    screen.render();
  }

  // Add a message to the output box
  function addMessage(message: string): void {
    outputBox.pushLine(message);
    outputBox.setScrollPerc(100);
    screen.render();
  }

  // Process a slash command
  async function processCommand(command: string, args: string[]): Promise<void> {
    switch (command) {
      case 'exit':
        screen.destroy();
        process.exit(0);
        break;

      case 'help':
        addMessage('\n{bold}Available Commands:{/bold}');
        addMessage('{bold}/add <content>{/bold} - Add content');
        addMessage('{bold}/note <context> <content>{/bold} - Add a note');
        addMessage('{bold}/list [notes|tasks]{/bold} - List items');
        addMessage('{bold}/search <query>{/bold} - Search content');
        addMessage('{bold}/help{/bold} - Show help');
        addMessage('{bold}/exit{/bold} - Exit the application');
        addMessage('\n{bold}Keybindings:{/bold}');
        addMessage('{bold}Ctrl+c{/bold} - Exit');
        addMessage('{bold}Ctrl+n{/bold} - New note mode');
        addMessage('{bold}Ctrl+l{/bold} - List mode');
        addMessage('{bold}Ctrl+s{/bold} - Search mode');
        addMessage('{bold}Ctrl+h{/bold} - Help');
        break;

      case 'add':
        if (args.length === 0) {
          addMessage('{red-fg}Error: Missing content. Usage: /add <content>{/red-fg}');
        } else {
          const content = args.join(' ');
          addMessage(`{bold}Adding content:{/bold} ${content}`);
          // TODO: Implement add functionality
          addMessage('{yellow-fg}Add functionality not yet implemented{/yellow-fg}');
        }
        break;

      case 'note':
        if (args.length < 2) {
          addMessage(
            '{red-fg}Error: Missing context or content. Usage: /note <context> <content>{/red-fg}',
          );
        } else {
          const context = args[0];
          const content = args.slice(1).join(' ');
          addMessage(`{bold}Adding note:{/bold} Context: ${context}, Content: ${content}`);
          // TODO: Implement note functionality
          addMessage('{yellow-fg}Note functionality not yet implemented{/yellow-fg}');
        }
        break;

      case 'list':
        const type = args[0] || 'notes';
        if (type !== 'notes' && type !== 'tasks') {
          addMessage('{red-fg}Error: Invalid list type. Usage: /list [notes|tasks]{/red-fg}');
        } else {
          addMessage(`{bold}Listing ${type}:{/bold}`);
          try {
            const response = type === 'notes' ? await listNotes() : await listTasks();

            // Handle different response formats
            // It could be an array directly or an object with a notes/tasks property
            let items: any[] = [];

            if (Array.isArray(response)) {
              // If response is already an array
              items = response;
            } else if (typeof response === 'object' && response !== null) {
              // If response is an object, try to extract the items array
              items = (response as any).notes || (response as any).tasks || [];
            }

            if (items.length === 0) {
              addMessage(`No ${type} found.`);
            } else {
              items.forEach((item: any) => {
                if (type === 'notes') {
                  // Handle note item structure
                  const title = item.title || 'Untitled';
                  const content = item.body || item.content || '';
                  addMessage(
                    `• ${title}: ${content.substring(0, 50)}${content.length > 50 ? '...' : ''}`,
                  );
                } else {
                  // Handle task item structure
                  addMessage(
                    `• ${item.description || item.title || 'Untitled task'} (${
                      item.status || 'unknown'
                    })`,
                  );
                }
              });
            }
          } catch (err) {
            addMessage(
              `{red-fg}Error listing ${type}: ${
                err instanceof Error ? err.message : String(err)
              }{/red-fg}`,
            );
          }
        }
        break;

      case 'search':
        if (args.length === 0) {
          addMessage('{red-fg}Error: Missing query. Usage: /search <query>{/red-fg}');
        } else {
          const query = args.join(' ');
          addMessage(`{bold}Searching for:{/bold} ${query}`);
          // TODO: Implement search functionality
          addMessage('{yellow-fg}Search functionality not yet implemented{/yellow-fg}');
        }
        break;

      default:
        addMessage(`{red-fg}Unknown command: ${command}{/red-fg}`);
        break;
    }
  }

  // Handle chat mode
  async function handleChatMode(input: string): Promise<void> {
    // Display user message
    addMessage(`{bold}{green-fg}You:{/green-fg}{/bold} ${input}`);

    try {
      // Show "thinking" indicator
      statusBar.setContent(' {bold}Mode:{/bold} Chat | Dome is thinking...');
      screen.render();

      // Send message to API
      const response = await chat(input);

      // Display response
      addMessage(`{bold}{blue-fg}Dome:{/blue-fg}{/bold} ${response.message}`);

      // Reset status line
      updateStatusLine('chat');
    } catch (err) {
      addMessage(`{red-fg}Error: ${err instanceof Error ? err.message : String(err)}{/red-fg}`);
      updateStatusLine('chat');
    }
  }

  // Handle note mode
  function handleNoteMode(input: string): void {
    addMessage(`{bold}Adding note:{/bold} ${input}`);
    // TODO: Implement note functionality
    addMessage('{yellow-fg}Note functionality not yet implemented{/yellow-fg}');
  }

  // Handle search mode
  function handleSearchMode(input: string): void {
    addMessage(`{bold}Searching for:{/bold} ${input}`);
    // TODO: Implement search functionality
    addMessage('{yellow-fg}Search functionality not yet implemented{/yellow-fg}');
  }

  // Handle input submission
  inputBox.key('enter', async () => {
    const input = inputBox.getValue().trim();

    if (!input) {
      return;
    }

    // Clear the input box
    inputBox.clearValue();
    screen.render();

    try {
      // Handle slash commands
      if (input.startsWith('/')) {
        const [command, ...args] = input.slice(1).split(' ');
        await processCommand(command, args);
      } else {
        // Handle based on current mode
        switch (currentMode) {
          case 'chat':
            await handleChatMode(input);
            break;
          case 'note':
            handleNoteMode(input);
            break;
          case 'search':
            handleSearchMode(input);
            break;
        }
      }
    } catch (err) {
      addMessage(
        `{red-fg}Unexpected error: ${err instanceof Error ? err.message : String(err)}{/red-fg}`,
      );
    }

    // Always make sure the input box regains focus after processing
    setTimeout(() => {
      inputBox.focus();
      screen.render();
    }, 100);
  });

  // Mode switching keybindings - bind to both screen and inputBox
  const bindKeyToAll = (key: string, handler: () => void) => {
    screen.key(key, handler);
    inputBox.key(key, handler);
  };

  bindKeyToAll('C-n', () => {
    currentMode = 'note';
    updateStatusLine('note');
    inputBox.focus();
  });

  bindKeyToAll('C-l', () => {
    currentMode = 'list';
    updateStatusLine('list');
    inputBox.setValue('/list ');
    inputBox.focus();
  });

  bindKeyToAll('C-s', () => {
    currentMode = 'search';
    updateStatusLine('search');
    inputBox.focus();
  });

  bindKeyToAll('C-h', () => {
    inputBox.setValue('/help');
    inputBox.focus();

    // Simulate pressing enter
    setTimeout(() => {
      const enterEvent = { name: 'enter' };
      inputBox.emit('keypress', '\r', enterEvent);
    }, 100);
  });

  // Make sure Ctrl+C works on the input box too
  inputBox.key('C-c', () => {
    screen.destroy();
    process.exit(0);
  });

  // Add a welcome message
  addMessage('{center}{bold}Welcome to Dome CLI{/bold}{/center}');
  addMessage('{center}Type a message to chat with Dome or use slash commands{/center}');
  addMessage('');

  // Focus the input box
  inputBox.focus();

  // Render the screen
  screen.render();
}

// Export the startPromptTui function as startTui for backward compatibility
export const startTui = startPromptTui;

// If this file is run directly, start the TUI
if (require.main === module) {
  startPromptTui();
}
