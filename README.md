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
# 1. Install dependencies
npm install

# 2. Set up environment configuration
cp .env.example .env
# Edit .env with your OpenAI API key and other settings

# 3. Build the CLI
npm run build

# 4. Link the binary so 'dome' is available on your PATH
npm link

# 5. Set up PostgreSQL with vector support (for semantic search)
docker run --name dome-postgres \
  -e POSTGRES_DB=dome \
  -e POSTGRES_USER=dome \
  -e POSTGRES_PASSWORD=dome123 \
  -p 5433:5432 \
  -d pgvector/pgvector:pg15

# Enable vector extension
docker exec dome-postgres psql -U dome -d dome -c "CREATE EXTENSION IF NOT EXISTS vector;"

# 6. Test the setup
dome list

# 7. Create your first note
dome new "My first note"

# 8. Index notes for search
dome index
```

### Environment Configuration

Copy `.env.example` to `.env` and configure:

- **`OPENAI_API_KEY`** - Required for AI features ([Get one here](https://platform.openai.com/api-keys))
- **`DOME_VAULT_PATH`** - Where your notes are stored (default: `~/dome`)
- **`POSTGRES_URI`** - Database connection for vector search

## 💻 CLI Commands

| Command                     | Description                                | Example                                           |
| --------------------------- | ------------------------------------------ | ------------------------------------------------- |
| `dome`                      | Interactive chat with AI assistant         | `dome`                                            |
| `dome find <query>`         | Semantic search for notes                  | `dome find "project architecture"`                |
| `dome new <topic>`          | Create note with appropriate template      | `dome new "2025-Q1 roadmap"`                      |
| `dome list`                 | List all notes grouped by folder           | `dome list --tags meeting,project`                |
| `dome folder create <name>` | Initialize folder with context file        | `dome folder create research --template academic` |
| `dome reorganize`           | AI workflow to merge duplicates & clean up | `dome reorganize --dry-run`                       |
| `dome index`                | Update vector index once or watch mode     | `dome index --watch`                              |

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

| Variable          | Default            | Description                                |
| ----------------- | ------------------ | ------------------------------------------ |
| `DOME_VAULT_PATH` | `~/dome`           | Root folder containing your Markdown notes |
| `OPENAI_API_KEY`  | –                  | OpenAI key for GPT-powered features        |
| `LANCE_DB_PATH`   | `vault/.vector_db` | Location of the vector search index        |

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
