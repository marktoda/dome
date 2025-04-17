# Dome CLI

A terminal UI client for interacting with the dome API.

## Features

- Command-line interface for all dome API operations
- Terminal UI using Ink (React for the terminal)
- Authentication with API key
- Environment switching (development, production)
- Interactive chat with the RAG-enhanced interface
- Support for adding notes, tasks, and reminders
- Search across stored content
- List and view notes and tasks

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
- `src/utils/` - Utility functions and API client

### Building

```bash
pnpm build
```

### Testing

```bash
pnpm test
```

## License

Private