#!/usr/bin/env node

import blessed from 'blessed';
import contrib from 'blessed-contrib';
import { loadConfig, isAuthenticated } from '../utils/config';
import { error } from '../utils/ui';
import { chat, addContent, search, listNotes, listTasks } from '../utils/api';

// Import the mode system
import {
  BaseMode,
  ModeManager,
  ChatMode,
  FocusMode,
  DashboardMode,
  SearchMode
} from './modes';

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

  // Create a prompt for input with improved configuration
  const inputBox = grid.set(11, 0, 1, 12, blessed.textbox, {
    inputOnFocus: true,
    keys: true,
    mouse: true,
    style: {
      fg: 'white',
      bg: 'black',
      focus: {
        fg: 'cyan',
        bg: 'black',
        bold: true,
      },
    },
    // Ensure input handling is properly configured
    input: true,
    keyable: true,
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

  // Create the mode manager
  const modeManager = new ModeManager(
    screen,
    outputBox,
    statusBar,
    (mode: BaseMode) => {
      // Update the sidebar with the active mode
      updateSidebar(mode);
      
      // Focus the input box
      inputBox.focus();
    }
  );

  // Register all modes
  modeManager.registerModes([
    new ChatMode(screen),
    new FocusMode(screen),
    new DashboardMode(screen),
    new SearchMode(screen),
  ]);

  // Update the sidebar with available modes
  function updateSidebar(activeMode: BaseMode | null): void {
    let content = '\n{bold}Modes:{/bold}\n\n';
    
    modeManager.getAllModes().forEach(mode => {
      const isActive = activeMode && activeMode.getName() === mode.getName();
      const color = mode.getColor();
      const icon = mode.getIcon();
      const name = mode.getName();
      
      if (isActive) {
        content += ` {white-bg}{black-fg}${icon} ${name}{/black-fg}{/white-bg}\n`;
      } else {
        content += ` {${color}-fg}${icon} ${name}{/${color}-fg}\n`;
      }
    });
    
    content += '\n{bold}Commands:{/bold}\n\n';
    content += ' {cyan-fg}/mode <name>{/cyan-fg} - Switch mode\n';
    content += ' {cyan-fg}/help{/cyan-fg} - Show help\n';
    content += ' {cyan-fg}/exit{/cyan-fg} - Exit\n\n';
    
    content += '{bold}Global Shortcuts:{/bold}\n\n';
    content += ' {cyan-fg}F1{/cyan-fg} - Help\n';
    content += ' {cyan-fg}F2{/cyan-fg} - Mode list\n';
    content += ' {cyan-fg}Ctrl+c{/cyan-fg} - Exit\n';
    
    sidebar.setContent(content);
    screen.render();
  }

  // Add a message to the output box
  function addMessage(message: string): void {
    outputBox.pushLine(message);
    outputBox.setScrollPerc(100);
    screen.render();
  }

  // Show help text
  function showHelp(): void {
    const activeMode = modeManager.getActiveMode();
    
    if (activeMode) {
      // Show mode-specific help
      const helpText = activeMode.getHelpText();
      addMessage(helpText);
    } else {
      // Show general help
      addMessage('\n{bold}Available Commands:{/bold}');
      addMessage('{bold}/mode <name>{/bold} - Switch to a specific mode');
      addMessage('{bold}/help{/bold} - Show help for the current mode');
      addMessage('{bold}/exit{/bold} - Exit the application');
      
      addMessage('\n{bold}Available Modes:{/bold}');
      modeManager.getAllModes().forEach(mode => {
        const color = mode.getColor();
        const icon = mode.getIcon();
        const name = mode.getName();
        const description = mode.getDescription();
        
        addMessage(`{${color}-fg}${icon} ${name}{/${color}-fg}: ${description}`);
      });
      
      addMessage('\n{bold}Global Keybindings:{/bold}');
      addMessage('{bold}F1{/bold} - Show help');
      addMessage('{bold}F2{/bold} - Show mode list');
      addMessage('{bold}Ctrl+c{/bold} - Exit');
    }
  }

  // Process a slash command
  async function processCommand(command: string, args: string[]): Promise<void> {
    switch (command) {
      case 'exit':
        screen.destroy();
        process.exit(0);
        break;

      case 'mode':
        if (args.length === 0) {
          addMessage('{red-fg}Error: Missing mode name. Usage: /mode <name>{/red-fg}');
        } else {
          const modeName = args[0];
          const success = modeManager.switchToMode(modeName);
          
          if (!success) {
            addMessage(`{red-fg}Error: Unknown mode "${modeName}"{/red-fg}`);
          }
        }
        break;

      case 'help':
        showHelp();
        break;

      case 'add':
        if (args.length === 0) {
          addMessage('{red-fg}Error: Missing content. Usage: /add <content>{/red-fg}');
        } else {
          const content = args.join(' ');
          addMessage(`{bold}Adding content:{/bold} ${content}`);

          try {
            // Show "processing" indicator
            statusBar.setContent(' {bold}Mode:{/bold} Add | Processing...');
            screen.render();

            // Add content using the API
            const response = await addContent(content);

            // Display success message
            addMessage(`{green-fg}Content added successfully!{/green-fg}`);
            if (response.id) {
              addMessage(`{bold}ID:{/bold} ${response.id}`);
            }

            // Update status bar
            const activeMode = modeManager.getActiveMode();
            if (activeMode) {
              statusBar.setContent(` {bold}Mode:{/bold} ${activeMode.getName()} | Ready`);
            } else {
              statusBar.setContent(' {bold}Mode:{/bold} None | Ready');
            }
            screen.render();
          } catch (err) {
            addMessage(
              `{red-fg}Error adding content: ${
                err instanceof Error ? err.message : String(err)
              }{/red-fg}`,
            );
            // Update status bar
            const activeMode = modeManager.getActiveMode();
            if (activeMode) {
              statusBar.setContent(` {bold}Mode:{/bold} ${activeMode.getName()} | Ready`);
            } else {
              statusBar.setContent(' {bold}Mode:{/bold} None | Ready');
            }
            screen.render();
          }
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

          try {
            // Show "searching" indicator
            statusBar.setContent(' {bold}Mode:{/bold} Search | Searching...');
            screen.render();

            // Perform search using the API
            const results = await search(query);

            // Display results
            if (!results.results || results.results.length === 0) {
              addMessage(`{yellow-fg}No results found for query: "${query}"{/yellow-fg}`);
            } else {
              addMessage(`{green-fg}Found ${results.results.length} results:{/green-fg}`);

              // Display results
              results.results.slice(0, 5).forEach((match: any, index: number) => {
                addMessage(
                  `\n{bold}Result ${index + 1} (Score: ${match.score?.toFixed(2) || 'N/A'}){/bold}`,
                );
                if (match.title) {
                  addMessage(`{bold}Title:{/bold} ${match.title}`);
                }
                if (match.type) {
                  addMessage(`{bold}Type:{/bold} ${match.type}`);
                }
                if (match.tags && match.tags.length > 0) {
                  addMessage(`{bold}Tags:{/bold} ${match.tags.join(', ')}`);
                }
                addMessage(`{bold}Created:{/bold} ${new Date(match.createdAt).toLocaleString()}`);

                // Display content excerpt
                if (match.excerpt) {
                  addMessage('\n{bold}Excerpt:{/bold}');
                  addMessage(match.excerpt);
                }

                addMessage('{gray-fg}' + '-'.repeat(50) + '{/gray-fg}');
              });

              // Show message if results were limited
              if (results.results.length > 5) {
                addMessage(
                  `\n{gray-fg}Showing 5 of ${results.results.length} results. Use the search command for more details.{/gray-fg}`,
                );
              }
            }

            // Update status bar
            const activeMode = modeManager.getActiveMode();
            if (activeMode) {
              statusBar.setContent(` {bold}Mode:{/bold} ${activeMode.getName()} | Ready`);
            } else {
              statusBar.setContent(' {bold}Mode:{/bold} None | Ready');
            }
            screen.render();
          } catch (err) {
            addMessage(
              `{red-fg}Error searching: ${
                err instanceof Error ? err.message : String(err)
              }{/red-fg}`,
            );
            // Update status bar
            const activeMode = modeManager.getActiveMode();
            if (activeMode) {
              statusBar.setContent(` {bold}Mode:{/bold} ${activeMode.getName()} | Ready`);
            } else {
              statusBar.setContent(' {bold}Mode:{/bold} None | Ready');
            }
            screen.render();
          }
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

      // Update status bar
      const activeMode = modeManager.getActiveMode();
      if (activeMode) {
        statusBar.setContent(` {bold}Mode:{/bold} ${activeMode.getName()} | Ready`);
      } else {
        statusBar.setContent(' {bold}Mode:{/bold} None | Ready');
      }
      screen.render();
    } catch (err) {
      addMessage(`{red-fg}Error: ${err instanceof Error ? err.message : String(err)}{/red-fg}`);
      // Update status bar
      const activeMode = modeManager.getActiveMode();
      if (activeMode) {
        statusBar.setContent(` {bold}Mode:{/bold} ${activeMode.getName()} | Ready`);
      } else {
        statusBar.setContent(' {bold}Mode:{/bold} None | Ready');
      }
      screen.render();
    }
  }

  // Handle note mode
  function handleNoteMode(input: string): void {
    addMessage(`{bold}Adding note:{/bold} ${input}`);
    // TODO: Implement note functionality
    addMessage('{yellow-fg}Note functionality not yet implemented{/yellow-fg}');
  }

  // Handle search mode
  async function handleSearchMode(input: string): Promise<void> {
    addMessage(`{bold}Searching for:{/bold} ${input}`);

    try {
      // Show "searching" indicator
      statusBar.setContent(' {bold}Mode:{/bold} Search | Searching...');
      screen.render();

      // Perform search using the API
      const results = await search(input);

      // Display results
      if (!results.results || results.results.length === 0) {
        addMessage(`{yellow-fg}No results found for query: "${input}"{/yellow-fg}`);
      } else {
        addMessage(`{green-fg}Found ${results.results.length} results:{/green-fg}`);

        // Display results
        results.results.slice(0, 5).forEach((match: any, index: number) => {
          addMessage(
            `\n{bold}Result ${index + 1} (Score: ${match.score?.toFixed(2) || 'N/A'}){/bold}`,
          );
          if (match.title) {
            addMessage(`{bold}Title:{/bold} ${match.title}`);
          }
          if (match.type) {
            addMessage(`{bold}Type:{/bold} ${match.type}`);
          }
          if (match.tags && match.tags.length > 0) {
            addMessage(`{bold}Tags:{/bold} ${match.tags.join(', ')}`);
          }
          addMessage(`{bold}Created:{/bold} ${new Date(match.createdAt).toLocaleString()}`);

          // Display content excerpt
          if (match.excerpt) {
            addMessage('\n{bold}Excerpt:{/bold}');
            addMessage(match.excerpt);
          }

          addMessage('{gray-fg}' + '-'.repeat(50) + '{/gray-fg}');
        });

        // Show message if results were limited
        if (results.results.length > 5) {
          addMessage(
            `\n{gray-fg}Showing 5 of ${results.results.length} results. Use the search command for more details.{/gray-fg}`,
          );
        }
      }

      // Update status bar
      const activeMode = modeManager.getActiveMode();
      if (activeMode) {
        statusBar.setContent(` {bold}Mode:{/bold} ${activeMode.getName()} | Ready`);
      } else {
        statusBar.setContent(' {bold}Mode:{/bold} None | Ready');
      }
      screen.render();
    } catch (err) {
      addMessage(
        `{red-fg}Error searching: ${err instanceof Error ? err.message : String(err)}{/red-fg}`,
      );
      // Update status bar
      const activeMode = modeManager.getActiveMode();
      if (activeMode) {
        statusBar.setContent(` {bold}Mode:{/bold} ${activeMode.getName()} | Ready`);
      } else {
        statusBar.setContent(' {bold}Mode:{/bold} None | Ready');
      }
      screen.render();
    }
  }

  // Completely revamped input handling to fix the duplicate character issue
  
  // Remove all key handlers from the input box except for enter
  inputBox.removeAllListeners('keypress');
  
  // Handle input submission with a new approach
  inputBox.on('submit', async (data: string) => {
    const input = data.trim();
    console.log(`Processing input: "${input}"`);

    if (!input) {
      inputBox.clearValue();
      inputBox.focus();
      return;
    }

    // Clear the input box immediately
    inputBox.clearValue();
    screen.render();

    try {
      // Handle slash commands
      if (input.startsWith('/')) {
        const [command, ...args] = input.slice(1).split(' ');
        console.log(`Executing command: ${command} with args: ${args.join(', ')}`);
        await processCommand(command, args);
      } else {
        // Handle input with the active mode
        const activeMode = modeManager.getActiveMode();
        
        if (activeMode) {
          console.log(`Sending input to mode: ${activeMode.getName()}`);
          await modeManager.handleInput(input);
        } else {
          addMessage('{yellow-fg}No active mode. Use /mode <name> to switch to a mode.{/yellow-fg}');
        }
      }
    } catch (err) {
      addMessage(
        `{red-fg}Unexpected error: ${err instanceof Error ? err.message : String(err)}{/red-fg}`,
      );
    }

    // Always make sure the input box regains focus after processing
    inputBox.focus();
    screen.render();
  });

  // Completely revamp key handling to fix input issues
  
  // Only bind global keys to the screen, not to the input box
  // This prevents duplicate key events
  
  // Exit key
  screen.key(['C-c'], () => {
    screen.destroy();
    process.exit(0);
  });
  
  // Help key (F1)
  screen.key(['f1'], () => {
    showHelp();
  });
  
  // Mode selection key (F2)
  screen.key(['f2'], () => {
    // Show mode selection dialog
    const modeList = blessed.list({
      parent: screen,
      top: 'center',
      left: 'center',
      width: '50%',
      height: '50%',
      border: {
        type: 'line',
      },
      style: {
        border: {
          fg: 'blue',
        },
        selected: {
          bg: 'blue',
          fg: 'white',
        },
      },
      label: ' Select Mode ',
      keys: true,
      vi: true,
      mouse: true,
      tags: true,
      items: modeManager.getAllModes().map(mode =>
        `{${mode.getColor()}-fg}${mode.getIcon()} ${mode.getName()}{/${mode.getColor()}-fg}: ${mode.getDescription()}`
      ),
    });

    modeList.on('select', (item, index) => {
      const mode = modeManager.getAllModes()[index];
      modeManager.switchToMode(mode.getName());
      screen.remove(modeList);
      screen.render();
    });

    modeList.key(['escape', 'q'], () => {
      screen.remove(modeList);
      screen.render();
    });

    screen.render();
  });
  
  // Mode switching keys
  screen.key(['C-n'], () => {
    modeManager.switchToMode('Focus');
  });
  
  screen.key(['C-l'], () => {
    modeManager.switchToMode('Dashboard');
  });
  
  screen.key(['C-s'], () => {
    modeManager.switchToMode('Search');
  });
  
  // Special handling for add and help commands
  screen.key(['C-a'], () => {
    inputBox.setValue('/add ');
    inputBox.focus();
  });
  
  screen.key(['C-h'], () => {
    inputBox.setValue('/help');
    inputBox.focus();
    
    // Simulate pressing enter
    setTimeout(() => {
      const enterEvent = { name: 'enter' };
      inputBox.emit('keypress', '\r', enterEvent);
    }, 100);
  });

  // Add a welcome message
  addMessage('{center}{bold}Welcome to Dome CLI{/bold}{/center}');
  addMessage('{center}Type a message to chat with Dome or use slash commands{/center}');
  addMessage('');

  // Switch to the default mode (Chat)
  modeManager.switchToMode('Chat');

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
