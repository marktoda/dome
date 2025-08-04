# Dome – AI-Powered Personal Knowledge Hub

Turn plain Markdown into a searchable, self-organising second brain – all from your terminal.

## ✨ Key Features

- **Markdown First** – Your notes stay as simple `.md` files in a local folder that you own
- **Context-Aware AI** – Uses OpenAI models to suggest folders, templates and links that fit the current context
- **Semantic Search** – Find notes by meaning with blazing-fast local vector search and optional cloud fallback
- **Smart Templates** – Built-in templates for meetings, journals, projects and more (add your own in seconds)
- **AI-Powered Reorganization** – Merge duplicates, clean up empty files and apply naming conventions automatically
- **Background Indexing** – Watch mode keeps your search index in sync without you thinking about it

## 🚀 Quick Start

```bash
# Install dependencies
npm install

# Build the CLI (needed once after each pull)
npm run build

# Link the binary so 'dome' is available on your PATH
npm link

# Configure your environment
export OPENAI_API_KEY="sk-..."                  # Required for AI features
export DOME_VAULT_PATH="$HOME/notes"            # Optional (default: ~/dome)
export LANCE_DB_PATH="$HOME/.cache/dome"        # Optional (default: vault/.vector_db)

# Launch interactive chat mode
dome
```

## 💻 CLI Commands

| Command | Description | Example |
|---------|-------------|---------|
| `dome` | Interactive chat with AI assistant | `dome` |
| `dome find <query>` | Semantic search for notes | `dome find "project architecture"` |
| `dome new <topic>` | Create note with appropriate template | `dome new "2025-Q1 roadmap"` |
| `dome list` | List all notes grouped by folder | `dome list --tags meeting,project` |
| `dome folder create <name>` | Initialize folder with context file | `dome folder create research --template academic` |
| `dome reorganize` | AI workflow to merge duplicates & clean up | `dome reorganize --dry-run` |
| `dome index` | Update vector index once or watch mode | `dome index --watch` |

Run any command with `--help` for all flags.

## 🔍 Semantic Search

The `find` command performs two-stage search:
1. **Local vector search** using [LanceDB](https://lancedb.com) – instant and offline
2. **AI fallback** (optional) queries OpenAI API when nothing relevant is found locally

Results are sorted by relevance, colour-coded and de-duplicated.

## 🏗 Folder Contexts

Attach a `.dome` file to any folder to customize behavior:

```toml
name        = "Research"
description = "Academic research and paper notes"

[template]
file = "templates/research.md"

[naming]
pattern = "YYYY-MM-DD-{title}"

[ai]
instructions = "You are a helpful research assistant…"
```

## ⚙️ Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DOME_VAULT_PATH` | `~/dome` | Root folder containing your Markdown notes |
| `OPENAI_API_KEY` | – | OpenAI key for GPT-powered features |
| `LANCE_DB_PATH` | `vault/.vector_db` | Location of the vector search index |

## 🧩 Architecture

```mermaid
graph TD;
  subgraph CLI
    A[dome] --> B[Commands];
    B --> C[find];
    B --> D[new];
    B --> E[list];
    B --> F[reorganize];
  end

  subgraph Core
    G[Note Store] --> H[Vector Index (LanceDB)];
    G --> I[Context Manager];
  end

  subgraph AI
    J[OpenAI Completion] --> K[Mastra Agents];
  end

  C --> H;
  D --> I;
  F --> K;
  B -.->|HTTP/FS| G;
```

- **CLI** – Thin wrappers mapping user intent to core services
- **Core** – Reading, writing and indexing markdown files
- **AI** – Mastra agents and workflows calling OpenAI when required

## 🛣 Roadmap

- [ ] Offline-only embeddings (no API key required)
- [ ] VS Code extension
- [ ] Web-based vault explorer
- [ ] Advanced templating with conditionals and loops
- [ ] End-to-end encrypted remote sync

## 🤝 Contributing

1. Fork & create a branch: `git checkout -b feature/my-cool-feature`
2. Run `npm test` and ensure everything passes
3. Submit a PR describing what you changed and why

We ❤️ documentation improvements and bug-fixes!

## 📜 License

MIT License. See `LICENSE` for details.

## 🙏 Acknowledgements

Built with:
- [Mastra](https://mastra.ai) – AI application framework
- [LanceDB](https://lancedb.com) – Vector database
- [Commander.js](https://github.com/tj/commander.js) – CLI framework
- [Ink](https://github.com/vadimdemedes/ink) – React for CLIs
- [OpenAI](https://openai.com) – GPT models