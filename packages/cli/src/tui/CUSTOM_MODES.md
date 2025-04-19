# Creating Custom Modes for Enhanced TUI

This guide explains how to create custom modes for the Enhanced TUI in Dome CLI.

## Overview

The Enhanced TUI is built on a modular architecture that allows you to create specialized interfaces for different tasks. Each mode provides a unique UI and functionality while sharing common infrastructure like the input box, status bar, and command processing.

## Mode Architecture

Each mode is a class that extends the `BaseMode` abstract class and implements several required methods:

- `onActivate()`: Called when the mode is activated
- `onDeactivate()`: Called when the mode is deactivated
- `handleInput(input: string)`: Handles user input
- `handleCommand(command: string, args: string[])`: Handles slash commands
- `render(container: blessed.Widgets.BoxElement)`: Renders the mode's UI
- `getHelpText()`: Returns help text for the mode

## Creating a New Mode

### 1. Start with the Template

The easiest way to create a new mode is to copy the `CustomModeTemplate.ts` file:

```bash
cp src/tui/modes/CustomModeTemplate.ts src/tui/modes/YourNewMode.ts
```

### 2. Implement Your Mode

Edit the new file to implement your mode:

```typescript
import blessed from 'blessed';
import { BaseMode, ModeConfig } from './BaseMode';

export class YourNewMode extends BaseMode {
  // Add your mode-specific properties here
  
  constructor(screen: blessed.Widgets.Screen) {
    const config: ModeConfig = {
      name: 'YourMode',           // The name of your mode
      description: 'Your mode description', 
      icon: '🔧',                 // An emoji icon for your mode
      color: 'magenta',           // The color for your mode
      keybindings: {
        // Your keybindings
      },
      commands: [
        // Your commands
      ],
    };
    
    super(config, screen);
  }
  
  // Implement required methods...
}
```

### 3. Register Your Mode

Add your mode to the `enhancedTui.ts` file:

```typescript
// Import your mode
import { YourNewMode } from './modes/YourNewMode';

// In the startEnhancedTui function:
modeManager.registerModes([
  new ChatMode(screen),
  new FocusMode(screen),
  new DashboardMode(screen),
  new SearchMode(screen),
  new YourNewMode(screen), // Add your mode here
]);
```

### 4. Export Your Mode

Add your mode to the `modes/index.ts` file:

```typescript
export { YourNewMode } from './YourNewMode';
```

## Mode Configuration

The `ModeConfig` interface defines the configuration for a mode:

```typescript
interface ModeConfig {
  name: string;           // The name of the mode
  description: string;    // A short description
  icon?: string;          // An emoji icon
  color?: string;         // The color (cyan, magenta, yellow, red, green, blue)
  keybindings?: Record<string, string>; // Key bindings and descriptions
  commands?: string[];    // Supported commands
}
```

## UI Components

The Enhanced TUI uses the [blessed](https://github.com/chjj/blessed) library for terminal UI components. Here are some common components you might use:

### Box

A basic container:

```typescript
const box = blessed.box({
  parent: container,
  top: 0,
  left: 0,
  width: '100%',
  height: '100%',
  border: {
    type: 'line',
  },
  style: {
    border: {
      fg: 'blue',
    },
  },
  content: 'Hello, world!',
});
```

### List

A selectable list:

```typescript
const list = blessed.list({
  parent: container,
  top: 0,
  left: 0,
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
  items: ['Item 1', 'Item 2', 'Item 3'],
  keys: true,
  vi: true,
});
```

### Text Input

A text input field:

```typescript
const input = blessed.textbox({
  parent: container,
  top: 0,
  left: 0,
  width: '100%',
  height: 3,
  border: {
    type: 'line',
  },
  style: {
    border: {
      fg: 'blue',
    },
    focus: {
      border: {
        fg: 'green',
      },
    },
  },
  inputOnFocus: true,
});
```

## Event Handling

Blessed components support event handling:

```typescript
// Handle key press
component.key('enter', () => {
  // Do something when Enter is pressed
});

// Handle mouse click
component.on('click', () => {
  // Do something when clicked
});

// Handle focus
component.on('focus', () => {
  // Do something when focused
});
```

## Best Practices

1. **Clean Up Resources**: Always clean up resources in `onDeactivate()` to prevent memory leaks.

2. **Handle Errors**: Wrap async code in try/catch blocks to prevent crashes.

3. **Provide Feedback**: Always provide visual feedback for user actions.

4. **Use Consistent UI**: Follow the UI patterns established in other modes.

5. **Document Your Mode**: Add clear documentation for your mode's features and commands.

6. **Test Thoroughly**: Test your mode with different inputs and edge cases.

## Example: Simple Todo Mode

Here's a simple example of a todo list mode:

```typescript
import blessed from 'blessed';
import { BaseMode, ModeConfig } from './BaseMode';

export class TodoMode extends BaseMode {
  private todoList: blessed.Widgets.ListElement | null = null;
  private todos: string[] = [];

  constructor(screen: blessed.Widgets.Screen) {
    const config: ModeConfig = {
      name: 'Todo',
      description: 'Simple todo list manager',
      icon: '📝',
      color: 'green',
      keybindings: {
        'Ctrl+a': 'Add todo',
        'Ctrl+d': 'Delete todo',
        'Ctrl+c': 'Clear all todos',
      },
      commands: ['add', 'delete', 'clear'],
    };
    
    super(config, screen);
  }

  protected onActivate(): void {
    // Load todos from storage
  }

  protected onDeactivate(): void {
    // Save todos to storage
  }

  async handleInput(input: string): Promise<void> {
    // Add a new todo
    this.todos.push(input);
    this.updateTodoList();
  }

  async handleCommand(command: string, args: string[]): Promise<boolean> {
    switch (command) {
      case 'add':
        if (args.length > 0) {
          this.todos.push(args.join(' '));
          this.updateTodoList();
        }
        return true;

      case 'delete':
        if (this.todoList) {
          const selected = this.todoList.selected;
          if (selected !== undefined && selected >= 0 && selected < this.todos.length) {
            this.todos.splice(selected, 1);
            this.updateTodoList();
          }
        }
        return true;

      case 'clear':
        this.todos = [];
        this.updateTodoList();
        return true;

      default:
        return false;
    }
  }

  render(container: blessed.Widgets.BoxElement): void {
    this.todoList = blessed.list({
      parent: container,
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      border: {
        type: 'line',
      },
      style: {
        border: {
          fg: 'green',
        },
        selected: {
          bg: 'green',
          fg: 'black',
        },
      },
      label: ' Todo List ',
      keys: true,
      vi: true,
      tags: true,
    });

    this.todoList.key('C-a', () => {
      // Show an input dialog
    });

    this.todoList.key('C-d', () => {
      const selected = this.todoList?.selected;
      if (selected !== undefined && selected >= 0 && selected < this.todos.length) {
        this.todos.splice(selected, 1);
        this.updateTodoList();
      }
    });

    this.todoList.key('C-c', () => {
      this.todos = [];
      this.updateTodoList();
    });

    this.updateTodoList();
  }

  private updateTodoList(): void {
    if (!this.todoList) {
      return;
    }

    this.todoList.clearItems();

    if (this.todos.length === 0) {
      this.todoList.addItem('{gray-fg}No todos. Add one with Ctrl+a or by typing.{/gray-fg}');
      this.screen.render();
      return;
    }

    this.todos.forEach((todo, index) => {
      this.todoList?.addItem(`${index + 1}. ${todo}`);
    });

    this.screen.render();
  }

  getHelpText(): string {
    return `
{bold}Todo Mode Help{/bold}

Todo mode provides a simple todo list manager.

{bold}Commands:{/bold}
  {cyan-fg}/add <todo>{/cyan-fg} - Add a new todo
  {cyan-fg}/delete{/cyan-fg} - Delete the selected todo
  {cyan-fg}/clear{/cyan-fg} - Clear all todos

{bold}Keybindings:{/bold}
  {cyan-fg}Ctrl+a{/cyan-fg} - Add todo
  {cyan-fg}Ctrl+d{/cyan-fg} - Delete todo
  {cyan-fg}Ctrl+c{/cyan-fg} - Clear all todos
`;
  }
}
```

## Advanced Features

For more advanced modes, you might want to:

1. **Use Multiple Panels**: Split your UI into multiple panels for different functions.
2. **Add Dialogs**: Create popup dialogs for user input or confirmation.
3. **Use Custom Widgets**: Create custom widgets for specialized functionality.
4. **Add Persistence**: Save and load mode state between sessions.
5. **Implement Filtering/Sorting**: Add filtering and sorting capabilities.
6. **Add Keyboard Navigation**: Implement keyboard navigation for complex UIs.

## Resources

- [Blessed Documentation](https://github.com/chjj/blessed)
- [Blessed-Contrib](https://github.com/yaronn/blessed-contrib) - More advanced widgets
- [Terminal UI Best Practices](https://github.com/chjj/blessed/wiki/Terminal-UI-Best-Practices)