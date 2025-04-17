# Dome CLI

A terminal UI client for interacting with the dome API.

## Features

- Command-line interface for all dome API operations
- Terminal UI using Ink (React for the terminal)
- Full-screen curses-based TUI with interactive navigation
- Authentication with API key
- Environment switching (development, production)
- Interactive chat with the RAG-enhanced interface
- Support for adding notes, tasks, and reminders
- Search across stored content
- List and view notes and tasks
- Theme customization (light/dark)

## Installation

### From Source

1. Clone the repository
2. Install dependencies:
   ```bash
   pnpm install
   ```
3. Build the CLI:
   ```bash
   pnpm --filter @dome/cli build
   ```
4. Link the CLI globally:
   ```bash
   cd packages/cli
   npm link
   ```

## Usage

### Authentication

Before using the CLI, you need to authenticate with your API key:

```bash
dome login
```

You can also provide the API key directly:

```bash
dome login --key YOUR_API_KEY
```

To log out:

```bash
dome logout
```

### Configuration

View current configuration:

```bash
dome config get
```

Set configuration values:

```bash
dome config set --base-url http://localhost:8787
dome config set --environment production
```

### Adding Content

Add a note:

```bash
dome add "This is a note to remember"
```

Add content from a file:

```bash
dome add path/to/file.txt
```

### Working with Notes

Start a note session:

```bash
dome note meeting
```

This will start an interactive session where you can type multiple lines. Type `/end` to finish the session.

You can also add a single note directly:

```bash
dome note meeting --content "Discussed project timeline"
```

### Listing Items

List notes:

```bash
dome list notes
```

List tasks:

```bash
dome list tasks
```

Filter items:

```bash
dome list notes --filter "tag:work"
dome list tasks --filter "status:pending"
```

### Viewing Items

View a specific note or task:

```bash
dome show note-id-123
```

### Searching

Search across all content:

```bash
dome search "project timeline"
```

Limit the number of results:

```bash
dome search "project timeline" --limit 5
```

### Chat

Start an interactive chat session:

```bash
dome chat
```

Send a single message:

```bash
dome chat --message "What meetings do I have scheduled for tomorrow?"
```

### Full-Screen TUI

Launch the full-screen terminal user interface:

```bash
dome tui
```

Or using the justfile:

```bash
just run-tui
```

The TUI provides a more interactive experience with:

- Dashboard with overview and quick actions
- Interactive chat with message history
- Notes management with list and detail views
- Search functionality with result previews
- Settings configuration
- Keyboard navigation and shortcuts
- Theme customization

#### TUI Keyboard Shortcuts

- Arrow keys: Navigate menus and lists
- Enter: Select an item
- Escape: Go back or exit current view
- q: Quit the application
- ?: Show help screen
- h: Return to dashboard
- c: Quick access to chat
- n: Quick access to notes
- t: Quick access to tasks
- s: Quick access to search

### Environment Switching

Use the `--prod` flag to switch to production environment:

```bash
dome --prod list notes
```

## Development

### Project Structure

- `src/index.ts` - Main entry point
- `src/commands/` - Command implementations
- `src/components/` - React components for the terminal UI
- `src/tui/` - Full-screen TUI implementation
  - `src/tui/index.ts` - TUI entry point
  - `src/tui/layouts/` - Layout components
  - `src/tui/screens/` - Screen implementations
  - `src/tui/components/` - TUI components
- `src/utils/` - Utility functions and API client

### Building

```bash
pnpm build
```

### Setting up the TUI

```bash
just setup-tui
```

### Testing

```bash
pnpm test
```

## License

Private