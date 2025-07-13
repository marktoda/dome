# Dome Core Module

Core functionality for the Dome note-taking system.

## Overview

The core module provides fundamental services for managing markdown notes in a vault:

- **Note Management** - Create, read, update, and delete markdown notes
- **Context System** - Folder-based configuration for note behavior
- **Search Indexing** - Vector-based semantic search using embeddings
- **Background Processing** - Automatic indexing of notes

## Main Components

### notes.ts
Core note operations:
- `listNotes()` - List all notes in vault
- `getNote(path)` - Read a specific note
- `writeNote(path, content, title?, tags?)` - Create or append to notes
- `removeNote(path)` - Delete a note

### context/
Hierarchical context system for folders:
- **manager.ts** - Main context management class
- **types.ts** - TypeScript interfaces
- **schema.ts** - Zod validation schemas
- **parser.ts** - YAML file parsing
- **templates.ts** - Default context templates
- **notes-integration.ts** - Context-aware note writing

### search-indexer.ts
Vector search functionality:
- `indexNotes(mode)` - Index notes for search
- `searchSimilarNotes(embedding, k)` - Find similar notes
- `createVectorStore()` - Initialize vector database

### background-indexer.ts
Automatic background indexing:
- Watches for file changes
- Updates search index automatically
- Configurable intervals and debouncing

### errors.ts
Standardized error handling:
- Custom error classes
- Error message extraction
- Consistent error responses

## Environment Variables

- `DOME_VAULT_PATH` - Location of notes vault (default: `~/dome`)
- `LANCE_DB_PATH` - Vector database location (default: `vault/.vector_db`)
- `OPENAI_API_KEY` - Required for embeddings and search

## Usage Examples

### Basic Note Operations
```typescript
import { listNotes, getNote, writeNote } from './notes.js';

// List all notes
const notes = await listNotes();

// Get a specific note
const note = await getNote('meetings/standup.md');

// Create a new note
await writeNote('ideas/new-feature.md', '# New Feature\n\nDescription...');
```

### Context Management
```typescript
import { ContextManager } from './context/manager.js';

const manager = new ContextManager();

// Create a context for a folder
await manager.createContext('/path/to/folder', {
  name: 'Meeting Notes',
  description: 'Team meeting notes',
  rules: {
    fileNaming: 'YYYY-MM-DD-{title}',
    autoTags: ['meeting']
  }
});

// Find context for a note
const context = await manager.findContextForPath('/path/to/note.md');
```

### Search Operations
```typescript
import { indexNotes, searchSimilarNotes } from './search-indexer.js';
import { embed } from 'ai';

// Index all notes
await indexNotes('full');

// Search for similar notes
const { embedding } = await embed({
  model: openai.embedding('text-embedding-3-small'),
  value: 'project planning'
});

const results = await searchSimilarNotes(embedding, 5);
```

## Architecture Notes

- **File-based**: All notes are markdown files on disk
- **Context Inheritance**: Child folders inherit parent contexts
- **Async Operations**: All I/O operations are asynchronous
- **Error Handling**: Consistent error types and responses
- **Type Safety**: Full TypeScript support with interfaces

## Dependencies

- `gray-matter` - YAML frontmatter parsing
- `fast-glob` - File system globbing
- `@mastra/lance` - Vector database
- `ai` - OpenAI embeddings
- `zod` - Schema validation