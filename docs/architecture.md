# Notes System Architecture

## Overview

The notes system is a simplified, path-based markdown note management system built with Mastra tools. It provides a clean API for creating, reading, and appending to notes stored in a local vault directory.

## Core Design Principles

### 1. Simplicity First
- **Path-based identification**: Notes are identified by their file path (e.g., `meetings/weekly-standup.md`)
- **No complex ID systems**: Eliminated UUIDs and hash-based identification for clarity
- **Auto-mode by default**: `writeNoteTool` automatically creates or appends without mode selection

### 2. Fault-Tolerant Parsing
- Graceful handling of missing or malformed YAML front-matter
- Fallback metadata extraction from file system and content
- Compatible with both CLI-generated and manually created notes

### 3. Iterative Content Workflows
- Perfect for running meeting notes that grow over time
- Intelligent content appending with proper spacing
- Automatic modification timestamps on updates

## System Components

### Tools Layer

#### `listNotesTool`
**Purpose**: List all notes with metadata from the vault

**Input**: None (empty object)
**Output**: Array of note metadata
```typescript
{
  title: string;
  date: string; 
  tags: string[];
  path: string;
  source: "cli" | "external";
}[]
```

#### `getNoteTool`
**Purpose**: Retrieve a specific note by path

**Input**: 
```typescript
{
  path: string; // e.g., "meetings/weekly-standup.md"
}
```

**Output**:
```typescript
{
  title: string;
  date: string;
  tags: string[];
  path: string;
  source: "cli" | "external";
  body: string;
  fullPath: string;
} | null
```

#### `writeNoteTool`
**Purpose**: Create new notes or append to existing ones (auto-mode)

**Input**:
```typescript
{
  path: string;                    // Target note path
  content: string;                 // Markdown content to write/append
  title?: string;                  // Title (for new notes only)
  tags?: string[];                 // Tags (for new notes only)
}
```

**Output**:
```typescript
{
  path: string;
  title: string;
  action: "created" | "appended";
  contentLength: number;
  fullPath: string;
}
```

### Agent Layer

#### `notesAgent`
**Configuration**:
- **Model**: OpenAI GPT-4o-mini
- **Tools**: All three notes tools
- **Memory**: LibSQL-backed persistent memory
- **Instructions**: Optimized for path-based note management workflows

### Data Layer

#### Vault Structure
```
~/dome/                          # Default vault (configurable via DOME_VAULT_PATH)
├── inbox/                       # Suggested folder structure
│   ├── ideas.md
│   └── quick-notes.md
├── meetings/
│   ├── weekly-standup.md
│   └── project-review.md
└── projects/
    └── architecture-notes.md
```

#### Note Format
```markdown
---
title: "Meeting Notes"
date: "2025-01-15T10:30:00.000Z"
tags: ["meeting", "weekly"]
source: "cli"
modified: "2025-01-15T11:15:00.000Z"  # Added on append
---

# Meeting Content

Initial meeting notes...

## Later Addition
Content appended later...
```

## Key Algorithms

### Auto Create/Append Logic
```typescript
async function writeNote(path, content, title?, tags?) {
  const existingNote = await getNote(path);
  
  if (existingNote) {
    // APPEND: Preserve front-matter, add content with spacing
    return appendToExistingNote(existingNote, content);
  } else {
    // CREATE: Generate new note with front-matter
    return createNewNote(path, content, title, tags);
  }
}
```

### Metadata Derivation Strategy
```
Priority for metadata fields:
1. YAML front-matter (explicit)
2. Content analysis (first # heading for title)
3. File system fallbacks (filename, timestamps)
4. Sensible defaults (empty arrays, current time)
```

### File Discovery
- Uses `fast-glob` for efficient recursive markdown file discovery
- Supports any folder structure and naming convention
- Respects `.gitignore` patterns automatically

## Error Handling & Resilience

### Graceful Degradation
- Missing vault directory → Creates automatically
- Malformed YAML → Falls back to filename/content parsing
- Missing files → Returns null without throwing
- Permission errors → Logged but don't crash system

### Data Safety
- Preserves existing front-matter on append operations
- Atomic file operations where possible
- No destructive operations without explicit user intent

## Configuration

### Environment Variables
- `DOME_VAULT_PATH`: Override default vault location (default: `~/dome`)

### Dependencies
- `fast-glob`: Efficient file pattern matching
- `gray-matter`: YAML front-matter parsing with fallbacks
- `@mastra/core`: Tool and agent framework
- Standard Node.js file system operations

## Usage Patterns

### Basic Note Creation
```typescript
writeNote("inbox/idea.md", "## New Feature Idea\nDetails...", "Feature Brainstorm", ["ideas"])
```

### Running Meeting Notes
```typescript
// Start meeting
writeNote("meetings/standup.md", "## Daily Standup\n### Attendees\n- Alice, Bob", "Daily Standup")

// Add agenda items
writeNote("meetings/standup.md", "### Action Items\n- [ ] Review PR #123")

// Add decisions
writeNote("meetings/standup.md", "### Decisions\n- Move deadline to Friday")
```

### Note Discovery
```typescript
// List all notes
const notes = await listNotes();

// Get specific note
const note = await getNote("meetings/standup.md");
```

## Benefits of This Architecture

1. **Intuitive**: Path-based identification matches user mental models
2. **Flexible**: Works with any folder structure and naming convention
3. **Fault-tolerant**: Handles real-world messiness gracefully
4. **Lightweight**: Minimal dependencies and complexity
5. **Extensible**: Clean tool interfaces for future enhancements
6. **Git-friendly**: Standard markdown files work with version control

## Future Considerations

- **Search capabilities**: Full-text search across note content
- **Tag-based organization**: Enhanced tag management and filtering
- **Template system**: Note templates for consistent formatting
- **Sync mechanisms**: Multi-device synchronization options
- **Performance optimization**: Caching and indexing for large vaults