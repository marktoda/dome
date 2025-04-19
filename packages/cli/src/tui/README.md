# Enhanced TUI for Dome CLI

The Enhanced Terminal User Interface (TUI) for Dome CLI provides a powerful, customizable interface with multiple specialized modes for different tasks.

## Features

- **Modular Mode System**: Easily switch between different specialized interfaces
- **Custom Keybindings**: Mode-specific keyboard shortcuts for efficient workflows
- **Enhanced UI**: Improved layout and visual design
- **Advanced Search**: Powerful search capabilities with filters and sorting
- **Dashboard View**: Overview of notes, tasks, and recent activity
- **Focus Mode**: Distraction-free writing environment
- **Customizable**: Extensible architecture for adding new modes

## Available Modes

### Chat Mode (💬)

Conversational interface for interacting with the assistant.

- **Features**:
  - Message history with user/assistant formatting
  - Command history
  - System messages

- **Commands**:
  - `/clear` - Clear chat history
  - `/history` - Show chat history summary
  - `/save` - Save chat history to a file

- **Keybindings**:
  - `Ctrl+c` - Clear chat history
  - `Ctrl+r` - Regenerate last response

### Focus Mode (✍️)

Distraction-free writing environment for notes and content.

- **Features**:
  - Full-screen text editor
  - Word and character count
  - Auto-save functionality
  - Status indicators

- **Commands**:
  - `/save` - Save content
  - `/clear` - Clear content
  - `/autosave [off|seconds]` - Toggle auto-save or set interval
  - `/wordcount` - Display word and character counts

- **Keybindings**:
  - `Ctrl+s` - Save content
  - `Ctrl+a` - Toggle auto-save
  - `Ctrl+c` - Clear content
  - `Esc` - Exit focus mode

### Dashboard Mode (📊)

Overview of notes, tasks, and recent activity.

- **Features**:
  - Notes list with previews
  - Tasks list with status indicators
  - Recent activity log
  - Statistics summary

- **Commands**:
  - `/refresh` - Refresh dashboard data
  - `/notes` - Focus notes list
  - `/tasks` - Focus tasks list
  - `/activity` - Focus activity log

- **Keybindings**:
  - `Ctrl+r` - Refresh dashboard
  - `Ctrl+n` - Focus notes list
  - `Ctrl+t` - Focus tasks list
  - `Ctrl+a` - Focus activity log
  - `Enter` - View details of selected item

### Search Mode (🔍)

Advanced search capabilities with filters and sorting.

- **Features**:
  - Full-text search
  - Type filtering
  - Date range filtering
  - Tag filtering
  - Customizable sorting
  - Result previews

- **Commands**:
  - `/filter` - Toggle filter panel
  - `/sort <field> <order>` - Sort by field (relevance, date, title)
  - `/reset` - Reset all filters
  - `/type <type>` - Filter by type (note, task, etc.)
  - `/date from <YYYY-MM-DD>` - Filter from date
  - `/date to <YYYY-MM-DD>` - Filter to date
  - `/tags <tag1> <tag2> ...` - Filter by tags

- **Keybindings**:
  - `Ctrl+f` - Toggle filter panel
  - `Ctrl+s` - Change sort order
  - `Ctrl+r` - Reset filters
  - `Ctrl+n` - Next result
  - `Ctrl+p` - Previous result

## Global Commands

- `/mode <name>` - Switch to a specific mode
- `/help` - Show help for the current mode
- `/exit` - Exit the application

## Global Keybindings

- `F1` - Show help
- `F2` - Show mode selection dialog
- `F10` - Exit
- `Ctrl+c` - Exit

## Usage

To start the enhanced TUI:

```bash
# Using the CLI directly
dome enhanced

# Using npm scripts
npm run enhanced

# Development mode
npm run enhanced:dev

# With local API
npm run enhanced:local

# With custom API URL
npm run enhanced:url http://your-api-url
```

## Extending with New Modes

The Enhanced TUI is designed to be extensible. To create a new mode:

1. Create a new class that extends `BaseMode`
2. Implement the required methods
3. Register the mode in `enhancedTui.ts`

See the existing mode implementations for examples.