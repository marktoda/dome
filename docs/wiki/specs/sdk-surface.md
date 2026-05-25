---
type: spec
created: 2026-05-25
updated: 2026-05-25
sources: ["[[raw/original-architecture]]", "[[cohesive/brainstorms/2026-05-25-dome-vision]]"]
---

# SDK surface

This spec is normative for the Dome SDK's public API. The SDK is a TypeScript package implemented for Bun (`bun` runtime) that exposes four concepts and a single registration mechanism. Everything beyond these is a pattern built on top.

## The four concepts

### Vault

A Vault is a directory + config + registry. One `Vault` instance per process per vault path. Constructed by `openVault(path: string)`. The instance:

- Knows its `path` (absolute directory).
- Loads `.dome/page-types.yaml` and `.dome/config.yaml`.
- Loads its registry — see "Registration" below.
- Exposes the Tool methods listed in "Tools" below.
- Holds an in-process event queue for async Hook dispatch.

A Vault is opened, used, and closed in one process lifetime. There is no Vault server in v0.5; the process IS the vault runtime.

### Document

A Document is any markdown file in a Vault. It is a value, not a service. Fields:

- `path: string` — relative to vault root. The single canonical location field.
- `frontmatter: Record<string, unknown>` — parsed YAML.
- `body: string` — markdown body, frontmatter excluded.
- `linksOut: ReadonlyArray<WikiLink>` — parsed `[[wikilinks]]`.

Computed accessors (not fields — derived from `path` on access):

- `document.category` → `'raw' | 'wiki' | 'log' | 'index' | 'notes' | 'inbox' | 'config'`
- `document.type` → `string | null` — for wiki/, derived from immediate subdirectory; otherwise `null`.
- `document.isImmutable` → `boolean` — true when `category === 'raw'`.

Documents are immutable values. Mutating a document means calling a Tool that produces a new on-disk state.

### Tool

A Tool is a typed function that operates on a Vault and one or more Documents. Every mutation in Dome flows through a Tool. Tools are the *only* legitimate path to mutation; see [[wiki/invariants/HOOKS_CANNOT_BYPASS_TOOLS]].

Each Tool:

- Takes a typed input (validated with Zod).
- Enforces zero or more invariants at call site (see [[wiki/matrices/tool-invariant-enforcement]]).
- Returns `Result<Output, ToolError>`.
- May produce `Effect[]` — the mutations it performed. Hooks are derived from this stream.

Tool return shape (normative API documentation):

```
type ToolReturn<TOutput> = {
  result: Result<TOutput, ToolError>;
  effects: Effect[];
};

type Effect =
  | { kind: 'wrote-document'; path: string; diff: UnifiedDiff }
  | { kind: 'appended-log'; entry: LogEntry }
  | { kind: 'moved-document'; from: string; to: string };
```

Tools never throw on invariant violations. They return `Result.err({ kind: 'invariant-violated', invariant: 'RAW_IS_IMMUTABLE', detail: ... })`. Throwing is reserved for SDK bugs.

#### Tool catalog (the six)

The SDK ships exactly **six Tools**. Anything beyond mutation primitives is a workflow (a prompt the agent loads) or a hook (a handler against events) — see the anti-concept list below.

| Tool | Purpose | Invariants enforced (axioms in **bold**) |
|---|---|---|
| `readPage` | Read a Document by path. | — |
| `writePage` | Create or update a Document anywhere in the vault. | **`RAW_IS_IMMUTABLE`**, `PAGE_TYPE_BY_DIRECTORY`, `WIKILINKS_ARE_FULLPATH`, `EVERY_WRITE_IS_LOGGED` (auto), opt-in: `SENSITIVE_GOES_TO_INBOX`, `PAGE_CREATION_REQUIRES_RECURRENCE` |
| `appendLog` | Append an entry to `log.md`. The only mutation primitive for `log.md`. | **`LOG_IS_APPEND_ONLY`** |
| `searchIndex` | Search the index + page bodies for matches. | — |
| `wikilinkResolve` | Resolve a wikilink to a Document or `null`. | `WIKILINKS_ARE_FULLPATH` |
| `moveDocument` | Move a Document. Refuses if either path is under `raw/`. | **`RAW_IS_IMMUTABLE`**, `EVERY_WRITE_IS_LOGGED` (auto), `PAGE_TYPE_BY_DIRECTORY` |

`writePage` is the universal mutation entrypoint. Sensitive content writes to `inbox/review/<file>.md`; ingest writes to `wiki/<type>/<name>.md`; quick-capture writes to `inbox/raw/<ts>.md`. The path determines the category and the invariant-enforcement profile.

The catalog is open: plugins register additional Tools through the registration mechanism. The six above are the entirety of what the SDK ships.

### Hook

A Hook is a handler registered against an event pattern. Hooks observe events derived from Tool Effects and may propose follow-on Tool calls. Hooks cannot mutate the vault directly — see [[wiki/invariants/HOOKS_CANNOT_BYPASS_TOOLS]].

Two registration forms (full details in [[wiki/specs/hooks]]):

- **Programmatic** — TypeScript file in `.dome/hooks/*.ts` calling `registerHook(eventPattern, handler)`.
- **Declarative** — YAML file in `.dome/hooks/*.yaml` declaring an event pattern + optional path-pattern filter + a workflow name.

Events are derived from Effects automatically; there is no `fireEvent` API. See [[wiki/matrices/event-types-and-payloads]].

**Two shipped default hooks** ride in the SDK as enabled-by-default:

- `auto-update-index` — on `document.written.wiki.*` and `document.deleted.wiki.*`, writes the affected index entries via `writePage(index.md, ...)`.
- `auto-cross-reference` — on `document.written.wiki.entity`, searches the wiki for mentions of the new entity and proposes backlinks via `writePage`.

Both can be disabled in `.dome/config.yaml` for vaults that don't want them. The Dome project's docs vault leaves both enabled.

## Registration

A single layered registration mechanism feeds the Vault's registry from three sources:

1. **SDK defaults** — built into the package; loaded first.
2. **Installed plugins** — npm packages declaring a `dome.plugins` entry in their `package.json`; loaded after defaults.
3. **Vault-local files** — files in `<vault>/.dome/` (tools, hooks, prompts, page-types.yaml); loaded last and override prior sources.

Five kinds of registration:

| Kind | What gets registered | Where defaults live | Where vault-local overrides live |
|---|---|---|---|
| Tool | Function over Vault + Documents | SDK package `tools/` | `<vault>/.dome/tools/*.ts` |
| Hook | Handler against event pattern | SDK package `hooks/` | `<vault>/.dome/hooks/{*.ts, *.yaml}` |
| Prompt | Markdown file (workflow if it carries frontmatter; see [[wiki/specs/prompts-and-workflows]]) | SDK package `prompts/` | `<vault>/.dome/prompts/*.md` |
| Page type | String label + optional schema | `.dome/page-types.yaml` defaults block | `.dome/page-types.yaml` extensions block |
| CLI command | (name, handler) | SDK package `cli/` | `<vault>/.dome/cli/*.ts` |

The 5×3 registration matrix is exhaustive. "Plugins" is a packaging convention — an npm package that registers any combination of the five kinds — not a primitive.

## Tiered feature model

The SDK ships features across three tiers. The tier determines whether a feature is active in a given vault.

| Tier | Description | Examples |
|---|---|---|
| **Axioms** | Cannot be disabled. Disabling them changes what Dome is. | `RAW_IS_IMMUTABLE`, `MARKDOWN_IS_SOURCE_OF_TRUTH`, `HOOKS_CANNOT_BYPASS_TOOLS`, `LOG_IS_APPEND_ONLY`. The 6 Tools. `index.md` + `log.md`. MCP server. CLI commands. |
| **Shipped defaults** | Enabled by default; can opt out in `.dome/config.yaml`. | `WIKILINKS_ARE_FULLPATH`, `PAGE_TYPE_BY_DIRECTORY`, `EVERY_WRITE_IS_LOGGED`. 4 default page types. `auto-update-index` + `auto-cross-reference` hooks. `ingest`, `query`, `lint`, `migrate`, `export-context` workflows. |
| **Opt-in** | Shipped, not active by default. Activated by adding the corresponding hook YAML / workflow / invariant entry to `<vault>/.dome/`. | `SENSITIVE_GOES_TO_INBOX`, `PAGE_CREATION_REQUIRES_RECURRENCE`. `sensitivity-classify`, `voice-ingest`, `research`, `clip-integrate` workflows. `inbox/<bucket>/` directories. |

`dome init <path>` produces a minimal general-purpose vault — just the tier-1 axioms and tier-2 defaults. Activation of tier-3 features is manual: copy the relevant hook YAML template from the SDK into `<vault>/.dome/hooks/` and create the `inbox/<bucket>/` directory the hook listens on. A future "packs" or "presets" mechanism may layer convenience over this; v0.5 keeps it manual.

## Outputs the SDK does not have

These exist as patterns built on the four concepts; they are NOT separate SDK primitives:

- **Workflow** — a prompt with frontmatter declaring `tools:` and `triggers:` IS a workflow. There is no `Workflow` type in the SDK.
- **Agent** — the harness that hosts an agent loop is the *user* of the SDK, not part of it. See [[wiki/specs/harnesses]].
- **Event** — events are *derived* from Tool Effects by the Hook dispatcher. There is no `fireEvent` API; emitting an Effect from a Tool IS the event.
- **Plugin** — packaging convention over registrations.
- **Intake** — a hook with a path-pattern filter that invokes a workflow. Not a separate concept; see [[wiki/specs/hooks]] §"Declarative form."

This is the **anti-concept list**: things future contributors might be tempted to add as primitives but shouldn't. The principle: every concept in the core is a thing future contributors must understand to make a change. Four is what the surface affords; everything else is composition.

## Runtime

- **Language**: TypeScript 5.x
- **Runtime**: Bun 1.x. The SDK uses Bun's native APIs where they're cleaner (file watcher, test runner, bundler). It does not depend on Node-only modules.
- **Distribution**: `bun publish` to npm as `@dome/sdk` (placeholder name). Single package.
- **MCP server**: `bun run dome serve` invokes the MCP server using `@modelcontextprotocol/sdk`; see [[wiki/specs/mcp-surface]].

### Dependencies (v0.5 baseline)

| Library | Purpose | Why this one |
|---|---|---|
| `@anthropic-ai/sdk` | LLM client for the headless agent loop | Anthropic's official TS SDK |
| `@modelcontextprotocol/sdk` | MCP server implementation | First-class TS MCP support |
| `isomorphic-git` | Git operations (reconciliation, init, status, diff) | Pure JS — no native git binary required; per [[wiki/invariants/VAULT_IS_GIT_REPO]] every vault is a git repo, and isomorphic-git lets us read/write `.git/` from Bun directly. See [[wiki/entities/isomorphic-git]]. |
| `chokidar` | Cross-platform filesystem watcher | Mature, Bun-compatible |
| `zod` | Runtime input validation | Derives JSON Schema for MCP tool inputs |
| `gray-matter` | YAML frontmatter parser | Standard for markdown frontmatter |
| `remark` / `unified` | Markdown AST | Standard for markdown manipulation |
| `p-queue` | Async hook dispatch queue | In-process; durable state is the lockfile pattern, not the queue |

Bun built-ins used directly (no extra dependency): `Bun.write` (atomic file writes), `Bun.file` (file reads + existence checks), `Bun.hash` (xxhash, used for non-canonical caching where git history isn't appropriate), the built-in test runner, `Bun.spawn` (for tool subprocess work).

### Derived operational state on disk

Three directories under `<vault>/.dome/` hold operational state that is NOT canonical (gitignored, rebuildable):

- `.dome/in-flight/<handler>-<event-id>.json` — lockfiles for hooks currently executing. Written at hook start, deleted at completion. Reconciliation walks this directory to re-fire crashed hooks.
- `.dome/state/last-reconciled-sha.txt` — the git SHA of the last successful `dome reconcile`. Reconciliation diffs against this.
- `.dome/state/scheduled.json` — last-fire timestamps for scheduled hooks. Reconciliation uses these to catch up missed intervals.
- `.dome/cache/` — reserved for plugin-defined caches; empty in the v0.5 SDK base.

All four are derived state. Deleting them does not lose canonical knowledge — it just causes the next reconciliation pass to do more work (fire more events, re-fire scheduled hooks once). The vault's markdown content (`wiki/`, `raw/`, etc.) is the only canonical surface, per [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]].

## Why this design

Three principles guide every design decision in this spec:

**Four concepts, not more.** Every concept in the core is a thing future contributors must understand to make a correct change. Fewer concepts → less context required → safer changes. The anti-concept list above is the structural defense against scope creep — workflows, agents, events, plugins, intakes all *feel* like primitives, but adding them as concepts would mean every contributor must learn five extra things to make a one-line change.

**Invariants at the tool boundary, not in agent discipline.** A second brain that silently writes wrong claims corrupts the user's thinking. Naive defense ("the agent is well-behaved, the prompts are good") is brittle: model upgrades change behavior, prompts have bugs, plugin authors make mistakes. Every invariant in Dome is enforced *inside* the Tool that would otherwise violate it. The Tool refuses; the caller sees an error; the agent corrects. The vault stays in a valid state regardless of who or what is calling.

**Prompts are the contract.** Dome's behavior is encoded in *prompts* (markdown files), not in TypeScript code. Tools are mechanical (small, content-agnostic operations); the LLM, instructed by prompts, decides what to do with content. Behavior changes happen by editing prompts in `prompts/` (SDK default) or `<vault>/.dome/prompts/` (vault override), not by writing or modifying Tools. This is what makes Dome both *understandable* (prompts are user-readable) and *tunable* (prompts evolve at the speed of language, not at the speed of releases). The original LLM Wiki gist (line 50 of `raw/original-architecture.md`) names this: "the core product is the workflow encoded in prompts."

The three principles compose: small core (four concepts) + structural enforcement at the boundary (invariants in Tools) + behavior as readable prose (prompts as contract). Together they make Dome legible to a new contributor in an afternoon and stable as a substrate over years.

## Related

- [[wiki/specs/vault-layout]] — directory structure and category derivation.
- [[wiki/specs/page-schema]] — frontmatter contract.
- [[wiki/specs/hooks]] — hook registration forms, event projection, execution model, shipped defaults.
- [[wiki/specs/prompts-and-workflows]] — how prompts double as workflows via frontmatter.
- [[wiki/specs/harnesses]] — how Claude Code and others mount Dome via MCP.
- [[wiki/specs/mcp-surface]] — MCP tool catalog.
- [[wiki/specs/cli]] — CLI command surface.
- [[wiki/matrices/tool-invariant-enforcement]] — Tool × invariant matrix.
- [[wiki/concepts/brain-companion]] — product framing.
- [[wiki/concepts/llm-wiki-pattern]] — historical inspiration.
