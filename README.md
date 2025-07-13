# Dome - AI-Powered Personal Knowledge Management

Dome is an intelligent note-taking system that combines the simplicity of markdown files with the power of AI assistance and semantic search.

## Features

- **📝 Markdown-Based**: All notes are plain markdown files in your local vault
- **🤖 AI Assistant**: Context-aware AI that adapts to different types of notes
- **🔍 Semantic Search**: Find notes by meaning, not just keywords
- **📁 Context System**: Folder-specific templates, rules, and behaviors
- **🔄 Auto-Organization**: AI-powered note reorganization and deduplication
- **⚡ Background Indexing**: Automatic search index updates
- **🎯 Smart Templates**: Pre-configured templates for meetings, journals, projects, etc.

## Quick Start

### Installation

```bash
npm install
npm run cli:build
npm link
```

### Basic Usage

```bash
# Start interactive chat
dome

# Find and open a note
dome find "meeting notes"

# List all notes
dome list

# Create context for a folder
dome context create meetings --template meetings

# Setup contexts interactively
dome setup
```

## Core Concepts

### Vault Structure

Your notes live in a vault (default: `~/dome`). You can organize them however you like:

```
~/dome/
├── meetings/
│   ├── .dome              # Context configuration
│   ├── 2024-01-15-standup.md
│   └── 2024-01-16-planning.md
├── projects/
│   ├── .dome
│   └── webapp/
│       ├── architecture.md
│       └── todo.md
└── journal/
    ├── .dome
    └── 2024-01-15.md
```

### Context System

Each folder can have a `.dome` file that configures:

- **Templates**: Default content for new notes
- **File Naming**: Automatic naming patterns (e.g., `YYYY-MM-DD-{title}`)
- **Validation**: Required fields and rules
- **AI Behavior**: Custom instructions for the AI assistant

### AI Assistant

The AI assistant helps you:

- Create and organize notes
- Extract insights from your vault
- Find related information
- Maintain consistent formatting

## Configuration

### Environment Variables

- `DOME_VAULT_PATH`: Location of your notes vault (default: `~/dome`)
- `OPENAI_API_KEY`: Required for AI features and semantic search
- `LANCE_DB_PATH`: Vector database location (default: `vault/.vector_db`)

### Context Templates

Built-in templates for common use cases:

- **meetings**: Team meetings, 1-1s, standups
- **journal**: Daily reflections and logs
- **projects**: Project documentation and planning
- **ideas**: Quick idea capture
- **reading**: Book and article notes

## Advanced Features

### Semantic Search

Find notes by meaning:

```bash
dome
> search for discussions about project architecture
```

### Note Reorganization

Clean up and organize your vault:

```bash
dome reorganize --dry-run
dome reorganize --merge-duplicates
```

### Background Indexing

Automatic search index updates:

```bash
dome index --watch
```

### Custom Contexts

Create custom folder behaviors:

```bash
dome context create research --name "Research Notes" \
  --description "Academic research and paper notes"
```

## Architecture

- **Core Module** (`src/mastra/core/`): Note management, contexts, search
- **CLI Module** (`src/cli/`): Command-line interface
- **Agents** (`src/mastra/agents/`): AI assistants
- **Tools** (`src/mastra/tools/`): AI tool implementations
- **Workflows** (`src/mastra/workflows/`): Complex operations

## Development

### Project Structure

```
src/
├── cli/              # CLI commands and UI
├── mastra/
│   ├── core/        # Core functionality
│   │   ├── context/ # Context system
│   │   └── ...      # Other core modules
│   ├── agents/      # AI agents
│   ├── tools/       # AI tools
│   └── workflows/   # Complex workflows
└── tests/           # Test suite
```

### Running Tests

```bash
npm test
```

### Building

```bash
npm run cli:build
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## License

[License information here]

## Acknowledgments

Built with:

- [Mastra](https://mastra.ai) - AI application framework
- [Commander.js](https://github.com/tj/commander.js) - CLI framework
- [Ink](https://github.com/vadimdemedes/ink) - React for CLIs
- [LanceDB](https://lancedb.com) - Vector database
- [OpenAI](https://openai.com) - AI models

# TODO

- Chat feature should include the relevant documents on the side that I can click through
  - it should also let me open the editor into a temp file with all of them included
