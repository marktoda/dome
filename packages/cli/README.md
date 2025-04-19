# Dome CLI

A terminal user interface (TUI) client for the Dome API.

## Features

- Interactive chat with Dome
- Multiple specialized modes for different tasks
- Command-based interface with slash commands
- Keyboard shortcuts for quick actions
- Search functionality
- Note and task management

## Installation

```bash
# Install dependencies
pnpm install

# Build the CLI
pnpm build
```

## Usage

```bash
# Start the TUI
pnpm tui

# Start the TUI in development mode
pnpm tui:dev

# Start the TUI with a custom API URL
pnpm tui:url http://your-api-url

# Start the TUI with the local API
pnpm tui:local
```

## Available Modes

The TUI supports multiple specialized modes for different tasks:

### Chat Mode (💬)

Conversational interface for interacting with the assistant.

- **Features**:
  - Message history with user/assistant formatting
  - Command history
  - System messages

### Focus Mode (✍️)

Distraction-free writing environment for notes and content.

- **Features**:
  - Full-screen text editor
  - Word and character count
  - Auto-save functionality
  - Status indicators

### Dashboard Mode (📊)

Overview of notes, tasks, and recent activity.

- **Features**:
  - Notes list with previews
  - Tasks list with status indicators
  - Recent activity log
  - Statistics summary

### Search Mode (🔍)

Advanced search capabilities with filters and sorting.

- **Features**:
  - Full-text search
  - Type filtering
  - Date range filtering
  - Tag filtering
  - Customizable sorting
  - Result previews

## Commands

- `/mode <name>` - Switch to a specific mode
- `/help` - Show help for the current mode
- `/add <content>` - Add content
- `/note <context> <content>` - Add a note
- `/list [notes|tasks]` - List items
- `/search <query>` - Search content
- `/exit` - Exit the application

## Keyboard Shortcuts

- `F1` - Show help
- `F2` - Show mode selection dialog
- `Ctrl+n` - Switch to Focus mode
- `Ctrl+l` - Switch to Dashboard mode
- `Ctrl+s` - Switch to Search mode
- `Ctrl+a` - Quick add content
- `Ctrl+h` - Show help
- `Ctrl+c` - Exit

## Creating Custom Modes

The TUI supports custom modes. See the [Custom Modes documentation](./src/tui/CUSTOM_MODES.md) for details on creating your own modes.

## Configuration

The CLI uses a configuration file stored in `~/.config/dome/config.json`. You can modify this file directly or use the `dome config` command to change settings.

```bash
# Set the API key
dome config set --api-key your-api-key

# Set the base URL
dome config set --base-url http://your-api-url

# Set the environment
dome config set --environment production

# Set the theme
dome config set --theme dark
```

## Development

```bash
# Run tests
pnpm test

# Run linting
pnpm lint

# Build the CLI
pnpm build

# Run the CLI in development mode
pnpm dev
