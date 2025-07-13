# Dome Context System

Hierarchical folder-based configuration system for the Dome vault.

## Overview

The context system allows each folder in your vault to have its own `.dome` configuration file that defines:
- Templates for new notes
- File naming conventions
- Required fields and validation rules
- Auto-applied tags
- AI assistant behavior

## Components

### types.ts
Core TypeScript interfaces:
- `DomeContext` - Main context configuration
- `ValidationResult` - Validation results with errors/warnings
- `ContextSearchResult` - Context lookup results

### schema.ts
Zod schemas for validation:
- `domeContextSchema` - Validates context configuration
- `validateContext()` - Runtime validation
- `validateFileNamingPattern()` - Pattern validation

### parser.ts
YAML file operations:
- `readContextFile()` - Load .dome files
- `writeContextFile()` - Save context configuration
- `findNearestContextFile()` - Walk up directory tree
- `listContextFiles()` - Find all contexts in vault

### manager.ts
Main context management:
- `ContextManager` - Core class for context operations
- `loadContext()` - Load from specific folder
- `findContextForPath()` - Find context for a note
- `getMergedContext()` - Merge inherited contexts
- `validateNoteAgainstContext()` - Check note compliance
- `applyTemplate()` - Generate note from template

### templates.ts
Default context templates:
- `loadDefaultTemplates()` - Get all built-in templates
- `getTemplate()` - Get specific template by ID
- Templates: meetings, journal, projects, ideas, reading

### notes-integration.ts
Integration with note writing:
- `writeNoteWithContext()` - Context-aware note creation
- Applies templates, naming rules, and auto-tags

### search-integration.ts
Context-aware search:
- `searchNotesWithContext()` - Filter search by context
- `getNotesInContext()` - List all notes in a context

## Context File Format

`.dome` files use YAML with optional content:

```yaml
---
name: "Meeting Notes"
description: "Team meetings and 1-1s"
template:
  frontmatter:
    attendees: []
    action_items: []
  content: |
    # Meeting: {title}
    Date: {date}
    
    ## Discussion
rules:
  fileNaming: "YYYY-MM-DD-{title}"
  requiredFields: ["attendees"]
  autoTags: ["meeting"]
---
Optional AI instructions go here as content.
These instructions modify how the AI behaves
when working with notes in this folder.
```

## File Naming Patterns

Supported placeholders:
- `YYYY`, `MM`, `DD` - Date components
- `HH`, `mm`, `ss` - Time components
- `{title}` - Note title (slugified)
- `{date}` - ISO date
- `{time}` - Time without colons
- `{uuid}` - Random ID

## Context Inheritance

Contexts inherit from parent folders:

```
vault/
├── .dome              # Root context (all notes)
├── projects/
│   ├── .dome         # Projects context
│   └── webapp/
│       └── notes.md  # Inherits projects + root
└── personal/
    ├── .dome         # Personal context
    └── journal.md    # Uses personal context
```

Child contexts:
- Override parent settings
- Merge arrays (tags, required fields)
- Inherit templates and AI instructions

## Usage

### Create Context
```typescript
const manager = new ContextManager();
await manager.createContext('/path/to/folder', {
  name: 'Project Notes',
  description: 'Project documentation',
  rules: {
    fileNaming: '{title}',
    autoTags: ['project']
  }
});
```

### Find Context for Note
```typescript
const result = await manager.findContextForPath('/path/to/note.md');
if (result) {
  console.log(result.context.name);
  console.log(result.isInherited);
  console.log(result.depth);
}
```

### Validate Note
```typescript
const validation = await manager.validateNoteAgainstContext(
  '/path/to/note.md',
  noteContent
);

if (!validation.isValid) {
  console.log('Errors:', validation.errors);
  console.log('Warnings:', validation.warnings);
}
```

### Apply Template
```typescript
const content = manager.applyTemplate(context, {
  title: 'Weekly Standup',
  date: '2024-01-15',
  attendees: ['Alice', 'Bob']
});
```

## Built-in Templates

### meetings
- Meeting notes with attendees, action items, decisions
- Date-based naming: `YYYY-MM-DD-{title}`
- Required: attendees list

### journal  
- Daily journal entries
- One file per day: `YYYY-MM-DD`
- Tracks mood, highlights, gratitude

### projects
- Project planning and tracking
- Status, timeline, stakeholders
- Goals and progress tracking

### ideas
- Quick idea capture
- Minimal structure
- Links related concepts

### reading
- Book and article notes
- Author, source type, ratings
- Key takeaways and quotes