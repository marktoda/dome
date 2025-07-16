# Dome – AI-Powered Personal Knowledge Hub

> Turn plain Markdown into a searchable, self-organising second brain – all from your terminal.

---

## ✨ Key Features

- **Markdown First** – Your notes stay as simple `.md` files in a local folder that you own.
- **Context-Aware AI** – Dome uses OpenAI models to suggest folders, templates and links that fit the _current_ context.
- **Semantic Search** – Find notes by meaning with blazing-fast local vector search and an optional cloud fallback.
- **Smart Templates** – Built-in templates for meetings, journals, projects and more (add your own in seconds).
- **AI-Powered Re-organisation** – Merge duplicates, clean up empty files and apply naming conventions automatically.
- **Background Indexing** – A watch mode keeps your search index in sync without you thinking about it.

---

## 🚀 Quick Start

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Build the CLI** (needed once after each pull)

   ```bash
   npm run cli:build
   ```

3. **Link the binary** so `dome` is available on your `PATH`:

   ```bash
   npm link
   ```

4. **Configure your environment**

   ```bash
   # Required for AI features
   export OPENAI_API_KEY="sk-..."

   # Optional – override defaults
   export DOME_VAULT_PATH="$HOME/notes"     # Where markdown files live
   export LANCE_DB_PATH="$HOME/.cache/dome" # Where the vector DB lives
   ```

5. **Start using Dome**

   ```bash
   # Launch interactive chat mode (default)
   dome
   ```

---

## 💻 CLI at a Glance

| Command                     | What it does                                                | Example                                           |
| --------------------------- | ----------------------------------------------------------- | ------------------------------------------------- |
| `dome`                      | Interactive chat with the AI assistant                      | `dome`                                            |
| `dome find <query>`         | Open a prompt to locate notes semantically                  | `dome find "project architecture"`                |
| `dome new <topic>`          | Create (or open) a note pre-filled with the right template  | `dome new "2025-Q1 roadmap"`                      |
| `dome list`                 | List all notes grouped by folder (add `--tags` or `--json`) | `dome list --tags meeting,project`                |
| `dome folder create <name>` | Initialise a folder with a `.dome` context file             | `dome folder create research --template academic` |
| `dome reorganize`           | Run the AI workflow that merges duplicates & cleans up      | `dome reorganize --dry-run`                       |
| `dome index`                | Update the vector index once or in watch-mode               | `dome index --watch`                              |

Run any command with `--help` for all flags.

---

## 🔍 Semantic Search (`dome find`)

The `find` command performs a two-stage search:

1. **Local vector search** using [LanceDB](https://lancedb.com) – instant and offline.
2. **AI fallback** (optional) that queries the OpenAI API when nothing relevant is found locally.

Results are sorted by relevance, colour-coded and de-duplicated. Open the note directly, create a new one, or cancel – all from an interactive list.

---

## 🏗 Folder Contexts

Attach a `.dome` file to any folder to customise behaviour:

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

Placeholders are substituted automatically when `dome new` is executed inside the folder.

---

## ⚙️ Configuration Reference

| Variable          | Default            | Description                                    |
| ----------------- | ------------------ | ---------------------------------------------- |
| `DOME_VAULT_PATH` | `~/dome`           | Root folder that contains your Markdown notes. |
| `OPENAI_API_KEY`  | –                  | OpenAI key for GPT-powered features.           |
| `LANCE_DB_PATH`   | `vault/.vector_db` | Location of the vector search index.           |

---

## 🧩 Architecture Overview

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

- **CLI** – Thin wrappers that map user intent to core services.
- **Core** – Everything related to reading, writing and indexing markdown files.
- **AI** – A set of Mastra agents and workflows that call out to OpenAI when required.

---

## 🛣 Roadmap

- [ ] Offline-only embeddings (no API key required)
- [ ] VS Code extension
- [ ] Web-based vault explorer
- [ ] Advanced templating with conditionals and loops
- [ ] End-to-end encrypted remote sync

---

## 🤝 Contributing

1. Fork the repo & create a branch: `git checkout -b feature/my-cool-feature`
2. Run `npm test` and make sure everything passes.
3. Submit a PR – please describe _what_ you changed and _why_.

We ❤️ documentation improvements and bug-fixes!

---

## 📜 License

Dome is released under the MIT License. See `LICENSE` for details.

---

## 🙏 Acknowledgements

Dome stands on the shoulders of giants:

- [Mastra](https://mastra.ai) – AI application framework
- [LanceDB](https://lancedb.com) – Vector database
- [Commander.js](https://github.com/tj/commander.js) – CLI framework
- [Ink](https://github.com/vadimdemedes/ink) – React for CLIs
- [OpenAI](https://openai.com) – GPT models
