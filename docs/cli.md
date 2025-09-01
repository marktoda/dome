# Dome CLI Design

## Overview

The Dome CLI provides a fast, intuitive interface for note-taking with AI-powered assistance. It combines quick topic-based note creation with intelligent note discovery and interactive chat capabilities.

## Command Interface

### `dome add <topic>`

**Purpose**: Quick note creation or editing based on topic matching

**Behavior**:

1. **Topic Analysis**: Parse the topic string and search for existing notes
2. **Smart Matching**: Find notes with similar titles using fuzzy matching
3. **Editor Integration**: Open user's preferred editor with the note
4. **Auto-save**: Automatically save changes back to the vault

**Examples**:

```bash
# Creates or opens existing "Eric 1-1" meeting note
dome add "eric 1-1"

# Creates or opens project planning note
dome add "project roadmap q1"

# Creates or opens daily journal entry
dome add "daily journal"
```

**Topic-to-Path Mapping**:

- Normalize topic: lowercase, replace spaces with hyphens
- Smart categorization based on keywords:
  - "1-1", "meeting", "standup" → `meetings/`
  - "daily", "journal", "log" → `journal/`
  - "project", "roadmap", "planning" → `projects/`
  - Default → `inbox/`
- Generate path: `{category}/{normalized-topic}.md`

### `dome list`

**Purpose**: Display all notes with metadata

**Output Format**:

```
Notes in ~/dome:

📁 meetings/
  📝 eric-1-1.md                    (modified 2 hours ago)
  📝 weekly-standup.md              (modified yesterday)

📁 projects/
  📝 architecture-notes.md          (modified 3 days ago)
  📝 roadmap-q1.md                  (modified 1 week ago)

📁 inbox/
  📝 quick-ideas.md                 (modified today)

Total: 5 notes
```

**Options**:

```bash
dome list --recent          # Show only recently modified notes
dome list --tags meeting    # Filter by tags
dome list --json           # Machine-readable output
```

### `dome` (Interactive Mode)

**Purpose**: AI-powered chat interface for note management

**Features**:

- **Natural language queries**: "Show me all meeting notes from this week"
- **Note manipulation**: "Create a todo list from my meeting notes"
- **Search and discovery**: "Find notes about the new feature"

**Interface**:

```
🏠 Dome AI Assistant

Connected to vault: ~/dome (5 notes)
Type 'help' for commands, 'exit' to quit

> summarize my meeting notes from this week

📝 **Weekly Meeting Summary**
- Eric 1-1: Discussed project timeline and deliverables
- Team Standup: Sprint planning and blockers review
- Architecture Review: Database schema decisions

> create a todo from my eric 1-1 note

✅ **Created Todo List** (saved to inbox/eric-1-1-todos.md)
- [ ] Review API documentation
- [ ] Schedule follow-up meeting
- [ ] Update project timeline

> exit
```

## Architecture

### CLI Framework

**Technology**: Commander.js for robust command parsing

```typescript
#!/usr/bin/env node
import { Command } from 'commander';
import { setupMastra } from './mastra-setup.js';

const program = new Command();

program.name('dome').description('AI-powered note-taking system').version('1.0.0');

program
  .command('add')
  .argument('<topic>', 'note topic')
  .description('create or edit a note on the given topic')
  .action(handleAdd);

program
  .command('list')
  .description('list all notes')
  .option('-r, --recent', 'show only recent notes')
  .option('--tags <tags>', 'filter by tags')
  .action(handleList);
```

### Core Components

#### Topic Matcher

```typescript
interface TopicMatcher {
  findBestMatch(topic: string): Promise<string | null>;
  generatePath(topic: string): string;
  categorize(topic: string): string;
}

class SmartTopicMatcher implements TopicMatcher {
  private categories = {
    meetings: ['1-1', 'meeting', 'standup', 'review', 'sync'],
    journal: ['daily', 'journal', 'log', 'reflection'],
    projects: ['project', 'roadmap', 'planning', 'feature'],
    inbox: [], // default fallback
  };

  async findBestMatch(topic: string): Promise<string | null> {
    const notes = await listNotes();
    const normalized = this.normalizeTopic(topic);

    // Exact title match
    const exactMatch = notes.find(n => n.title.toLowerCase() === topic.toLowerCase());
    if (exactMatch) return exactMatch.path;

    // Fuzzy matching using similarity scoring
    const candidates = notes
      .map(n => ({
        note: n,
        score: this.calculateSimilarity(normalized, n.title),
      }))
      .filter(c => c.score > 0.7)
      .sort((a, b) => b.score - a.score);

    return candidates[0]?.note.path || null;
  }
}
```

#### Editor Integration

```typescript
interface EditorService {
  openNote(path: string, isNew: boolean): Promise<boolean>;
  detectEditor(): string;
}

class EditorService {
  detectEditor(): string {
    return (
      process.env.EDITOR ||
      process.env.VISUAL ||
      (process.platform === 'win32' ? 'notepad' : 'nano')
    );
  }

  async openNote(path: string, isNew: boolean): Promise<boolean> {
    const editor = this.detectEditor();
    const fullPath = join(vaultPath, path);

    if (isNew) {
      // Create note with template
      await this.createNoteTemplate(fullPath, this.extractTitle(path));
    }

    // Open in editor
    const { spawn } = await import('child_process');
    return new Promise((resolve, reject) => {
      const child = spawn(editor, [fullPath], {
        stdio: 'inherit',
      });

      child.on('exit', code => {
        resolve(code === 0);
      });
    });
  }
}
```

#### Interactive Chat

```typescript
interface ChatSession {
  start(): Promise<void>;
  processQuery(input: string): Promise<string>;
  end(): void;
}

class DomeChatSession implements ChatSession {
  private agent: Agent;
  private rl: ReadLine;

  async start() {
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '> ',
    });

    console.log('🏠 Dome AI Assistant\n');
    console.log(`Connected to vault: ${vaultPath}`);
    console.log("Type 'help' for commands, 'exit' to quit\n");

    this.rl.prompt();
    this.rl.on('line', this.handleInput.bind(this));
  }

  async processQuery(input: string): Promise<string> {
    // Route to agent with context about available tools
    const response = await this.agent.run({
      input,
      context: {
        vaultPath,
        availableCommands: ['list', 'search', 'create'],
      },
    });

    return response.text;
  }
}
```

## Implementation Plan

### Phase 1: Basic CLI Structure

```typescript
// src/cli/index.ts
export { setupCLI } from './commands/index.js';

// src/cli/commands/add.ts
export async function handleAdd(topic: string) {
  const matcher = new SmartTopicMatcher();
  const editor = new EditorService();

  // Find existing note or determine new path
  const existingPath = await matcher.findBestMatch(topic);
  const targetPath = existingPath || matcher.generatePath(topic);
  const isNew = !existingPath;

  console.log(isNew ? `Creating new note: ${targetPath}` : `Opening existing note: ${targetPath}`);

  // Open in editor
  const success = await editor.openNote(targetPath, isNew);

  if (success) {
    console.log('✅ Note saved successfully');
  } else {
    console.error('❌ Error saving note');
    process.exit(1);
  }
}
```

### Phase 2: Smart Matching

```typescript
// src/matching/fuzzy-matcher.ts
export class FuzzyMatcher {
  calculateSimilarity(a: string, b: string): number {
    // Levenshtein distance + semantic weighting
    const distance = this.levenshteinDistance(a, b);
    const maxLength = Math.max(a.length, b.length);
    return 1 - distance / maxLength;
  }

  extractKeywords(text: string): string[] {
    // Extract meaningful words, ignore common stopwords
    return text
      .toLowerCase()
      .split(/\s+/)
      .filter(word => !this.isStopword(word))
      .filter(word => word.length > 2);
  }
}
```

### Phase 3: Interactive Mode

```typescript
// src/chat/session.ts
export class ChatSession {
  private commands = {
    help: () => this.showHelp(),
    list: () => this.listNotes(),
    search: (query: string) => this.searchNotes(query),
    exit: () => this.exit(),
  };

  async handleInput(input: string) {
    const trimmed = input.trim();

    // Check for built-in commands
    if (this.commands[trimmed]) {
      await this.commands[trimmed]();
      return;
    }

    // Route to AI agent
    try {
      const response = await this.processQuery(trimmed);
      console.log(response);
    } catch (error) {
      console.error('❌ Error:', error.message);
    }

    this.rl.prompt();
  }
}
```

## Configuration

### Environment Variables

```bash
# Vault location
DOME_VAULT_PATH=~/dome

# Preferred editor
EDITOR=code  # or vim, nano, etc.

# AI model settings
DOME_MODEL=gpt-5-mini
DOME_MAX_TOKENS=2000
```

### Config File (`~/.dome/config.json`)

```json
{
  "vault": {
    "path": "~/dome",
    "categories": {
      "meetings": ["1-1", "meeting", "standup"],
      "journal": ["daily", "journal", "log"],
      "projects": ["project", "roadmap", "planning"]
    }
  },
  "editor": {
    "command": "code",
    "args": ["--wait"]
  },
  "matching": {
    "threshold": 0.7,
    "maxSuggestions": 3
  }
}
```

## Error Handling

### Graceful Failures

```typescript
// Editor not found
if (!editorExists) {
  console.error('❌ No editor found. Set EDITOR environment variable.');
  console.log('Examples: export EDITOR=nano');
  process.exit(1);
}

// Vault not accessible
if (!vaultAccessible) {
  console.log('📁 Creating vault directory at', vaultPath);
  await mkdir(vaultPath, { recursive: true });
}

// Note conflicts
if (hasUnsavedChanges) {
  const answer = await confirm('Note has unsaved changes. Continue?');
  if (!answer) process.exit(0);
}
```

## Package Structure

```
dome-cli/
├── package.json
├── src/
│   ├── cli/
│   │   ├── index.ts          # Main CLI entry
│   │   ├── commands/
│   │   │   ├── add.ts
│   │   │   ├── list.ts
│   │   │   └── chat.ts
│   │   └── utils/
│   ├── matching/
│   │   ├── topic-matcher.ts
│   │   └── fuzzy-matcher.ts
│   ├── editor/
│   │   └── editor-service.ts
│   ├── chat/
│   │   └── session.ts
│   └── mastra/
│       └── setup.ts          # Mastra configuration
├── bin/
│   └── dome                  # Executable script
└── docs/
    └── cli.md               # This document
```

## Benefits

1. **Lightning Fast**: Single command to create or edit notes
2. **Intelligent**: Smart topic matching reduces cognitive overhead
3. **Flexible**: Works with any editor and vault structure
4. **AI-Powered**: Natural language interaction with your notes
5. **Keyboard-Friendly**: Optimized for developer workflows
6. **Cross-Platform**: Works on macOS, Linux, and Windows

## Future Enhancements

- **Shell Completion**: Tab completion for topics and commands
- **Quick Templates**: Predefined note templates for common types
- **Sync Integration**: Git-based synchronization across devices
- **Plugin System**: Extensible architecture for custom commands
- **Mobile Companion**: Basic mobile app for quick note capture
