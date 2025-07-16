# Dome CLI Module

Command-line interface for the Dome note-taking system.

## Overview

The CLI module provides:

- Interactive chat interface with AI assistant
- Command-based operations for notes
- Context management commands
- File operations and organization

## Commands

### Main Commands

#### `dome` (default)

Launch interactive chat mode with the AI assistant.

#### `dome find <topic>`

Search for and open an existing note.

#### `dome list`

List all notes in the vault.

- `--recent` - Show only recent notes
- `--tags <tags>` - Filter by tags
- `--json` - Output as JSON

#### `dome index`

Manage the search index.

- `--full` - Full reindex
- `--watch` - Watch for changes

#### `dome reorganize`

AI-powered vault reorganization.

- `--dry-run` - Preview changes
- `--merge-duplicates` - Merge similar notes
- `--cleanup-empty` - Remove empty folders

### Context Commands

#### `dome context create <folder>`

Create a context for a folder.

- `-t, --template <name>` - Use a template
- `-n, --name <name>` - Context name
- `-d, --description <desc>` - Description

#### `dome context list`

List all contexts in vault.

- `--json` - Output as JSON

#### `dome context validate <note>`

Check if a note follows context rules.

#### `dome setup`

Interactive setup wizard for contexts.

## Architecture

### Components

- **commands/** - Command implementations
  - `chat.tsx` - Interactive chat UI
  - `find.ts` - Note finder
  - `list.ts` - Note listing
  - `context.ts` - Context management
  - `setup.ts` - Setup wizard
- **components/** - React Ink UI components
  - `ChatApp.tsx` - Main chat application
  - `StatusBar.tsx` - Status display
  - `ChatHistory.tsx` - Message history
  - `InputArea.tsx` - User input
- **actions/** - Business logic
  - `note-finder.ts` - Note search logic
- **services/** - External services
  - `editor-service.ts` - Editor integration

## Chat Interface

The default chat interface provides:

- Real-time AI responses
- Background indexing status
- Command shortcuts
- Multi-line input support

### Chat Commands

- `/help` - Show help
- `/status` - Show indexing status
- `/clear` - Clear chat history
- `/exit` - Exit chat

### Keyboard Shortcuts

- `Ctrl+C` - Exit
- `Ctrl+L` - Clear screen
- `Shift+Enter` - Multi-line input

## Error Handling

All commands use consistent error handling:

- Clear error messages with ❌ prefix
- Success messages with ✅ prefix
- Warnings with ⚠️ prefix
- Info messages with ℹ️ prefix

## Configuration

The CLI respects these environment variables:

- `DOME_VAULT_PATH` - Vault location
- `EDITOR` - Preferred text editor

## Extension Points

### Adding New Commands

1. Create command file in `commands/`
2. Export a handler function
3. Register in `index.ts`

Example:

```typescript
// commands/mycommand.ts
export async function handleMyCommand(args: any) {
  // Implementation
}

// index.ts
program.command('mycommand').description('My new command').action(handleMyCommand);
```

### Custom UI Components

Create React components using Ink:

```typescript
import React from 'react';
import { Box, Text } from 'ink';

export const MyComponent: React.FC = () => {
  return (
    <Box>
      <Text>Custom UI</Text>
    </Box>
  );
};
```
