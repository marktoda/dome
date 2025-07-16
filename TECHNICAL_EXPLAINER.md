# Dome: AI-Powered Note Management System

## Technical Architecture Overview

### System Summary

Dome is a TypeScript-based CLI application that provides AI-powered note management capabilities. Built on the Mastra framework, it combines local markdown file storage with semantic search, AI assistance, and an interactive terminal interface.

## Core Architecture

### Technology Stack

- **Runtime**: Node.js 20.9.0+, ES2022 modules
- **Framework**: Mastra v0.10.12 (AI agent orchestration)
- **AI Provider**: OpenAI GPT-4o-mini with text-embedding-3-small
- **Database**: LibSQL (SQLite-compatible) for memory/metadata
- **Vector Storage**: LanceDB for semantic search embeddings
- **UI Framework**: Ink (React for CLI)
- **Build System**: TypeScript 5.8.3 with standard ES module compilation

### System Components

#### 1. CLI Interface (`/src/cli/`)

**Entry Point**: `index.ts` - Commander.js-based CLI with multiple command modes:

- `dome find <topic>` - Semantic search for notes
- `dome list [--recent] [--tags]` - List notes with filtering
- `dome index` - Build/rebuild vector search index
- `dome reorganize` - AI-powered note organization
- Default: Interactive chat mode

**Interactive UI**: React-based terminal interface using Ink:

- `ChatApp.tsx` - Main TUI application
- `ChatHistory.tsx` - Conversation display
- `InputArea.tsx` - User input handling
- `StatusBar.tsx` - System status indicators

#### 2. Mastra Agent System (`/src/mastra/`)

**Core Agent**: `agents/notes-agent.ts`

- OpenAI GPT-4o-mini powered
- Persistent memory via LibSQL
- Tool-calling capabilities for note operations
- Semantic search integration

**Agent Tools**: `tools/notes-tool.ts`

- `listNotesTool` - Note metadata enumeration
- `getNoteTool` - Individual note retrieval
- `writeNoteTool` - Create/append operations (auto-mode)
- `removeNoteTool` - Note deletion
- `searchNotesTool` - Vector similarity search

#### 3. Note Management Core (`/src/mastra/core/`)

**File Operations**: `notes.ts`

- Vault-based storage (`~/dome/` default, configurable via `DOME_VAULT_PATH`)
- YAML frontmatter parsing with gray-matter
- Auto-create/append logic with intelligent content merging
- Metadata derivation from frontmatter, content, and filesystem

**Search Infrastructure**: `search-indexer.ts`

- LanceDB vector store with HNSW indexing
- OpenAI text-embedding-3-small (1536 dimensions)
- Markdown-aware chunking (256 char chunks, 20 char overlap)
- Batch processing with upsert capabilities

#### 4. Workflows (`/src/mastra/workflows/`)

**Reorganization**: `reorganize-workflow.ts`

- AI-driven note structure optimization
- Content analysis and categorization
- Automated folder/filename suggestions

## Data Architecture

### Note Storage Format

```
~/dome/                     # Vault root (configurable)
├── inbox/                  # Suggested organization
│   ├── ideas.md
│   └── quick-notes.md
├── meetings/
│   ├── weekly-standup.md
│   └── project-review.md
└── projects/
    └── architecture.md
```

### Note Schema

```yaml
---
title: "Note Title"
date: "2025-01-15T10:30:00.000Z"
tags: ["tag1", "tag2"]
source: "cli" | "external"
modified: "2025-01-15T11:15:00.000Z"  # Auto-updated on append
---

# Markdown Content
Body content with full markdown support...
```

### Vector Database Schema

```typescript
{
  id: string;              // "relative/path.md_chunkIndex"
  vector: number[];        // 1536-dim embedding
  metadata: {
    notePath: string;      // Relative path from vault
    text: string;          // Chunk content
    tags: string[];        // Note tags
    modified: string;      // ISO timestamp
    // Additional chunk metadata
  }
}
```

## Key Design Patterns

### 1. Path-Based Note Identity

- Notes identified by filesystem paths (e.g., `meetings/standup.md`)
- No UUID or hash-based systems - human-readable organization
- Direct filesystem mapping for git compatibility

### 2. Auto-Mode Write Operations

```typescript
// Single tool handles both create and append
writeNote(path, content, title?, tags?) → {
  action: "created" | "appended"
  // ... result metadata
}
```

### 3. Fault-Tolerant Parsing

- Graceful handling of malformed YAML frontmatter
- Fallback metadata extraction from content (first `# heading`) and filesystem
- Compatible with manually created and CLI-generated notes

### 4. Semantic Search Pipeline

```
Query → Embedding → Vector Search → Chunk Results → Note Assembly
```

## Core Functionality

### Note Operations

- **Create**: New notes with YAML frontmatter generation
- **Append**: Intelligent content merging with spacing preservation
- **List**: Metadata enumeration with date sorting
- **Search**: Vector similarity matching with relevance scoring
- **Remove**: Safe deletion with confirmation flows

### AI Capabilities

- **Conversational Interface**: Natural language note queries
- **Semantic Search**: "Where did I write about X?" style queries
- **Content Generation**: AI-assisted note creation and expansion
- **Organization**: Automated folder structure and naming suggestions

### Indexing System

- **Incremental Updates**: Upsert-based vector management
- **Batch Processing**: Configurable batch sizes for large vaults
- **HNSW Indexing**: High-performance approximate nearest neighbor search
- **Schema Inference**: Automatic table creation from first batch

## Configuration & Environment

### Environment Variables

- `DOME_VAULT_PATH` - Note storage location (default: `~/dome`)
- `OPENAI_API_KEY` - Required for AI and embedding operations
- `LANCE_DB_PATH` - Vector database location (default: `$VAULT/.vector_db`)

### Build & Development

```bash
npm run cli:build    # Compile TypeScript
npm run cli:dev      # Build and run
npm run dev          # Mastra development server
npm run build        # Production build
```

## Performance Characteristics

### Scalability

- **File Operations**: O(n) scanning with fast-glob optimization
- **Vector Search**: O(log n) with HNSW indexing
- **Memory Usage**: Streaming processing for large note collections
- **Batch Sizes**: Configurable (default: 5 notes per embedding batch)

### Storage Requirements

- **Notes**: Raw markdown files (minimal overhead)
- **Vectors**: ~6KB per note (1536 float32 + metadata)
- **Memory**: LibSQL database for conversation history

## Security & Privacy

- **Local Storage**: All data remains on local filesystem
- **API Usage**: Only OpenAI API calls for embeddings/completions
- **No External Sync**: Designed for local-first operation
- **Git Compatible**: Standard markdown files work with version control

## Extension Points

### Custom Tools

- Agent tool interface allows custom note operations
- Zod schema validation for type safety
- Async execution context with error handling

### Workflow Integration

- Mastra workflow system for complex multi-step operations
- Agent memory persistence for context retention
- Event-driven processing capabilities

### Storage Backends

- Pluggable storage interface (currently LibSQL)
- Vector store abstraction (currently LanceDB)
- Configurable embedding providers

This architecture prioritizes simplicity, local-first operation, and extensibility while providing powerful AI-enhanced note management capabilities.
