# Dome Development Guide for Claude

This document provides essential information for AI assistants (particularly Claude) when working with the Dome codebase.

## Project Overview

**Dome** is an AI-powered note-taking and knowledge management CLI application built with TypeScript. It provides intelligent note organization, search, and processing capabilities through a command-line interface.

### Key Features
- 📝 Markdown-based note management with frontmatter support
- 🤖 AI-powered note categorization and summarization
- 🔍 Vector-based semantic search using embeddings
- 👁️ File watching with automatic processing pipelines
- 💬 Interactive chat interface for note exploration
- 🏷️ Automatic tagging and metadata extraction

## Architecture

### Core Components

```
src/
├── core/              # Core business logic
│   ├── entities/      # Domain models (Note, NoteId, etc.)
│   ├── processors/    # File processing pipeline
│   ├── services/      # Business services
│   ├── store/         # Data persistence layer
│   └── utils/         # Shared utilities
├── watcher/           # File watching system
├── cli/               # Command-line interface
│   ├── commands/      # CLI commands
│   ├── chat/          # Interactive chat UI
│   └── services/      # CLI-specific services
└── mastra/            # AI integration layer
```

### Technology Stack
- **Runtime**: Node.js 20+
- **Language**: TypeScript 5.x
- **Database**: PostgreSQL with pgvector extension
- **AI**: OpenAI API (GPT-4, embeddings)
- **CLI Framework**: Commander.js
- **UI**: React + Ink (for interactive components)
- **Testing**: None currently (should be added)

## Development Guidelines

### Code Style

1. **TypeScript Usage**
   ```typescript
   // ✅ Good: Use type annotations
   export function processNote(note: Note): Promise<ProcessedNote>
   
   // ❌ Bad: Avoid any types
   export function processNote(note: any): any
   ```

2. **Import Conventions**
   ```typescript
   // Use node: prefix for built-in modules
   import path from 'node:path';
   import { readFile } from 'node:fs/promises';
   
   // Group imports: external, internal, relative
   import { z } from 'zod';
   import { config } from '@core/utils/config.js';
   import { Note } from './entities/Note.js';
   ```

3. **Error Handling**
   ```typescript
   try {
     const result = await operation();
     return result;
   } catch (error) {
     logger.error(`Operation failed: ${error}`);
     throw new CustomError('User-friendly message', { cause: error });
   }
   ```

### Configuration Management

All configuration is centralized in `src/core/utils/config.ts`. Never access `process.env` directly.

```typescript
// ✅ Good: Use centralized config
import { config } from '@core/utils/config.js';
const vaultPath = config.paths.vault;

// ❌ Bad: Direct env access
const vaultPath = process.env.DOME_VAULT_PATH;
```

### Environment Variables

Required environment variables:
- `OPENAI_API_KEY` - OpenAI API key for AI features
- `POSTGRES_URI` - PostgreSQL connection string
- `DOME_VAULT_PATH` - Path to notes vault (default: ~/dome)

Optional configuration:
- `DOME_DEFAULT_MODEL` - AI model for generation (default: gpt-5-mini)
- `DOME_EMBEDDING_MODEL` - Model for embeddings (default: text-embedding-3-small)
- `LOG_LEVEL` - Logging level (default: info)
- `NODE_ENV` - Environment (development/production/test)

### File Processing Pipeline

The application uses a processor pipeline pattern for handling file changes:

1. **FileProcessor** - Base abstract class for all processors
2. **SequentialProcessor** - Runs processors in sequence
3. **Processor Types**:
   - `FrontmatterProcessor` - Extracts/updates YAML frontmatter
   - `TodoProcessor` - Extracts TODO items
   - `EmbeddingProcessor` - Generates vector embeddings
   - `IndexProcessor` - Updates directory indices

### AI Integration

AI features use the Vercel AI SDK with OpenAI:

```typescript
import { openai } from '@ai-sdk/openai';
import { generateText, generateObject } from 'ai';

// Text generation
const { text } = await generateText({
  model: openai(config.ai.models.default),
  prompt: 'Your prompt',
  temperature: config.ai.temperature,
});

// Structured output
const { object } = await generateObject({
  model: openai(config.ai.models.default),
  schema: yourZodSchema,
  prompt: 'Your prompt',
});
```

### Database Schema

PostgreSQL with pgvector extension:

```sql
-- Vector storage for semantic search
CREATE TABLE notes_vectors (
  id TEXT PRIMARY KEY,
  vector vector(1536),  -- OpenAI embedding dimension
  metadata JSONB
);

-- Create index for similarity search
CREATE INDEX ON notes_vectors USING ivfflat (vector vector_cosine_ops);
```

## Common Tasks

### Adding a New CLI Command

1. Create command file in `src/cli/commands/`
2. Define command using Commander.js
3. Register in `src/cli/index.ts`

```typescript
// src/cli/commands/my-command.ts
import { Command } from 'commander';

export const myCommand = new Command('my-command')
  .description('Description of your command')
  .option('-f, --flag', 'Flag description')
  .action(async (options) => {
    // Implementation
  });
```

### Adding a New Processor

1. Create processor in `src/core/processors/`
2. Extend `FileProcessor` base class
3. Register in `WatcherService`

```typescript
export class MyProcessor extends FileProcessor {
  readonly name = 'MyProcessor';
  
  protected async processFile(event: FileEvent): Promise<void> {
    // Implementation
  }
}
```

### Working with Notes

```typescript
import { NoteService } from '@core/services/NoteService.js';

const noteService = new NoteService();

// List all notes
const notes = await noteService.listNotes();

// Get specific note
const note = await noteService.getNote(noteId);

// Write note
await noteService.writeNote(noteId, content);
```

## Testing Commands

### Build and Type Check
```bash
npm run build        # Compile TypeScript
npm run typecheck    # Run type checking only
```

### Linting
```bash
npm run lint         # Run ESLint
npm run lint:fix     # Auto-fix linting issues
```

### Development
```bash
npm run dev          # Start in development mode
npm run watch        # Start file watcher
```

### CLI Commands
```bash
dome --help          # Show all commands
dome new             # Create new note
dome list            # List notes
dome search <query>  # Search notes
dome chat            # Start interactive chat
dome watch           # Start file watcher
```

## Debugging Tips

1. **Enable Debug Logging**
   ```bash
   LOG_LEVEL=debug dome watch
   # or
   DEBUG=1 dome watch
   ```

2. **Check Configuration**
   ```bash
   dome config          # Display current configuration
   ```

3. **Database Issues**
   - Ensure PostgreSQL is running
   - Verify pgvector extension is installed
   - Check connection string in POSTGRES_URI

4. **Common Errors**
   - "OPENAI_API_KEY not found" - Set the environment variable
   - "Vector dimension mismatch" - Embedding model changed, reindex needed
   - "Cannot find module" - Run `npm install` and `npm run build`

## Best Practices

### When Making Changes

1. **Always build before testing**: `npm run build`
2. **Check types**: `npm run typecheck`
3. **Update documentation**: Add JSDoc comments for public APIs
4. **Handle errors gracefully**: Use try-catch and provide context
5. **Use the logger**: Don't use console.log in production code
6. **Follow patterns**: Look at existing code for conventions

### Performance Considerations

1. **Batch operations** when possible (e.g., database inserts)
2. **Use debouncing** for file system events
3. **Cache expensive computations** (embeddings, summaries)
4. **Limit concurrent AI calls** to avoid rate limits

### Security

1. **Never commit secrets** - Use environment variables
2. **Validate user input** - Use Zod schemas
3. **Sanitize file paths** - Prevent directory traversal
4. **Limit file access** - Stay within vault boundaries

## Project Maintenance

### Dependencies to Watch
- `@ai-sdk/openai` - AI functionality
- `gray-matter` - Frontmatter parsing
- `commander` - CLI framework
- `ink` & `ink-select-input` - Interactive UI
- `pino` - Logging
- `chokidar` - File watching

### Known Issues
1. No test coverage - Tests should be added
2. Limited error recovery in processors
3. No migration system for database schema
4. Missing API documentation

### Future Improvements
1. Add comprehensive test suite
2. Implement database migrations
3. Add support for more AI providers
4. Create web UI companion
5. Add plugin system for custom processors
6. Implement note synchronization
7. Add collaborative features

## Quick Reference

### File Extensions
- `.md` - Markdown notes
- `.dome` - Folder context files
- `.index.json` - Directory indices

### Special Files
- `.dome` - Folder configuration (YAML frontmatter)
- `.index.json` - Auto-generated directory index
- `todo.md` - Aggregated TODO items

### Common Patterns
```typescript
// Service initialization
const noteService = new NoteService();
const searchService = new NoteSearchService(noteService);

// Async error handling
const result = await operation().catch(error => {
  logger.error(`Operation failed: ${error}`);
  return defaultValue;
});

// Path handling
import { toRel, toAbs } from '@core/utils/path-utils.js';
const relativePath = toRel(absolutePath);
const absolutePath = toAbs(relativePath);
```

## Contact and Resources

- **Repository**: Check package.json for repository URL
- **Issues**: Report bugs through GitHub issues
- **Documentation**: This file and inline JSDoc comments
- **Configuration**: See `src/core/utils/config.ts` for all options

---

*Last updated: 2024*
*Version: 1.0.0*
