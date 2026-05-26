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

#### Vault surface

`openVault` returns a `Vault` with this surface (the canonical names other parts of this spec and consumers depend on):

- `path: string`, `config: VaultConfig`, `pageTypes: PageTypesConfig` — readonly resolved-from-disk values.
- `tools: BoundToolSurface` — the seven Tools curried with this Vault and the privileged writer. The canonical Tool entry point for in-process consumers; see §"Tool catalog" below.
- `aiTools: ai.ToolSet` — the same seven Tools shaped for Vercel-AI-SDK `generateText` consumption. Workflow runners filter this set by name; see [[wiki/specs/prompts-and-workflows]] §"Runner".
- `toolParsers` — per-Tool parse-and-invoke functions for transports that deliver raw input (the MCP adapter, future HTTP / SSE). Each parses through the Tool's Zod schema and invokes the same Vault-bound function `tools` exposes.
- `drainHooks(): Promise<void>` — wait for all async hooks dispatched so far to settle. Tests and `dome reconcile` call this to reach a deterministic state.
- `dispatchEvents(events: ReadonlyArray<HookEvent>): Promise<void>` — push the given events through the Vault's hook dispatcher. Used by `dome reconcile` (inbox scan, git-diff replay, scheduled catchup) and `VaultWatcher` (out-of-band edits) to drive hook handlers without each subsystem having to assemble its own `ctxFactory`.
- `rebuildIndex(): Promise<void>` — regenerate `index.md` from scratch by walking every wiki page. Public SDK seam consulted by `dome doctor --rebuild-index` and any consumer that needs a from-scratch rebuild; consults the privileged writer internally rather than exposing it.

### Document

A Document is any markdown file in a Vault. It is a value, not a service. Fields:

- `path: string` — relative to vault root. The single canonical location field.
- `frontmatter: Record<string, unknown>` — parsed YAML.
- `body: string` — markdown body, frontmatter excluded.
- `linksOut: ReadonlyArray<WikiLink>` — parsed `[[wikilinks]]`.
- `mtime: string | null` — ISO-8601 filesystem mtime as observed at read time, or `null` for synthesized Documents (e.g., from `makeDocument({ path })` without a real file behind it). Threaded into mutating Tools as `expected_mtime` to enable optimistic locking; see §"Concurrency".

Computed accessors (not fields — derived from `path` on access):

- `document.category` → `'raw' | 'wiki' | 'log' | 'index' | 'notes' | 'inbox' | 'config' | 'external'` — `'external'` covers `.git/` and other top-level subdirs unknown to Dome (e.g., this vault's `cohesive/` session residue); tolerated read-only, no Tool writes to external paths. See [[wiki/specs/vault-layout]] §"Category derivation".
- `document.type` → `string | null` — for wiki/, the plural directory name (e.g., `"entities"` for `wiki/entities/danny.md`). Frontmatter `type:` is the singular form (e.g., `"entity"`); the two are reconciled via the `pluralOf` / `singularOf` helpers in `src/page-type.ts`. See [[wiki/specs/page-schema]] §"Universal frontmatter".
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

#### Tool catalog (the seven)

The SDK ships exactly **seven Tools**. Anything beyond mutation primitives is a workflow (a prompt the agent loads) or a hook (a handler against events) — see the anti-concept list below.

Naming convention: Tools that operate on any Document use `<verb>Document`; Tools that operate on a specific Dome surface (`log.md`, the index, wikilinks) use their surface-specific name.

`(auto)` in the Invariants column means the Tool's effect array always includes the corresponding Effect — the caller does not separately invoke that Effect's producer Tool. For `EVERY_WRITE_IS_LOGGED (auto)`, the Tool emits its `appendLog` Effect alongside the primary mutation Effect; the caller does not call `appendLog` explicitly. The matrix at [[wiki/matrices/tool-invariant-enforcement]] spells the same semantic per-cell ("emits appendLog effect when default enabled").

| Tool | Purpose | Invariants enforced (axioms in **bold**) |
|---|---|---|
| `readDocument` | Read a Document by path. | — |
| `writeDocument` | Create or update a Document anywhere in the vault. | **`RAW_IS_IMMUTABLE`**, **`INDEX_AND_LOG_ARE_DISPATCHER_OWNED`**, `PAGE_TYPE_BY_DIRECTORY`, `WIKILINKS_ARE_FULLPATH`, `EVERY_WRITE_IS_LOGGED` (auto), opt-in: `SENSITIVE_GOES_TO_INBOX`, `PAGE_CREATION_REQUIRES_RECURRENCE` |
| `appendLog` | Append an entry to `log.md`. The only mutation primitive for `log.md`. | **`LOG_IS_APPEND_ONLY`** |
| `searchIndex` | Search the index + page bodies for matches. | — |
| `wikilinkResolve` | Resolve a wikilink to a Document or `null`. | `WIKILINKS_ARE_FULLPATH` |
| `moveDocument` | Move a Document; rewrites incoming wikilinks atomically. Refuses if either path is under `raw/`. | **`RAW_IS_IMMUTABLE`**, **`INDEX_AND_LOG_ARE_DISPATCHER_OWNED`**, `EVERY_WRITE_IS_LOGGED` (auto), `PAGE_TYPE_BY_DIRECTORY` |
| `deleteDocument` | Delete a Document. Refuses under `raw/`. Fires `document.deleted.<category>.<type>` so cleanup hooks can react. | **`RAW_IS_IMMUTABLE`**, **`INDEX_AND_LOG_ARE_DISPATCHER_OWNED`**, `EVERY_WRITE_IS_LOGGED` (auto) |

`writeDocument` is the universal mutation entrypoint for creates and updates. `moveDocument` atomically relocates + rewrites backlinks. `deleteDocument` removes pages cleanly (lint proposes deleting orphan pages; users retire obsolete syntheses; migrate may delete superseded files). Sensitive content writes to `inbox/review/<file>.md`; ingest writes to `wiki/<type>/<name>.md`; quick-capture writes to `inbox/raw/<ts>.md`. The path determines the category and the invariant-enforcement profile.

The catalog is open: plugins register additional Tools through the registration mechanism. The seven above are the entirety of what the SDK ships.

#### Tool catalog is one declarative array

The seven Tools above are declared once, in `src/tools/registry.ts`, as the canonical `TOOL_REGISTRY`. Every downstream catalog — the `BoundToolSurface` exposed on `Vault.tools`, the AI SDK `ToolSet` consumed by `runWorkflow`, the MCP adapters built by `buildToolAdapters`, the snake_case names in `MCP_TOOL_NAMES`, the Zod enum that validates workflow-prompt frontmatter `tools:` lists — derives from this one array. Adding an 8th Tool in v0.5.1 / v1+ is two file edits: a new `src/tools/<name>.ts` implementation, and one new entry in the registry. The MCP adapter, the AI SDK exposure, the frontmatter validator, and the bound surface all pick it up automatically.

This is the structural enforcement of "seven Tools, sealed." Prior to the registry, the seven names lived in five+ parallel catalogs and the seal depended on reviewer attention.

#### Tool signatures

Canonical input/output shapes for the seven Tools. Other specs and invariant docs cite these shapes rather than restate them inline.

```ts
// Read
readDocument(input: { path: string }): ToolReturn<Document>

// Universal mutation entrypoint
writeDocument(input: {
  path: string;
  body: string;
  frontmatter: Record<string, unknown>;
  expected_mtime?: string;
  // ↑ optional optimistic-locking snapshot from a prior readDocument; when
  //   passed, the Tool re-reads the file's current mtime immediately before
  //   writing and returns concurrent-write-conflict on mismatch. Omit to
  //   accept "last write wins". See §"Concurrency".
  opts?: {
    create?: boolean;
    // ↑ true on new-page create; gates PAGE_CREATION_REQUIRES_RECURRENCE.
    //   When that invariant is enabled and create=true, `reason` is required.
    reason?: 'recurring' | 'named_explicitly' | 'structural';
    // ↑ required when create=true AND PAGE_CREATION_REQUIRES_RECURRENCE enabled;
    //   otherwise optional. Logged with the page-creation log entry.
    sensitivity_classified?: 'normal' | 'sensitive';
    // ↑ gates SENSITIVE_GOES_TO_INBOX routing. When that invariant is enabled
    //   and the value is 'sensitive', writeDocument refuses writes to wiki/*
    //   and instructs the caller to target inbox/review/*.
  }
}): ToolReturn<Document>

// Append-only log mutation
appendLog(input: {
  verb: 'ingest' | 'query' | 'lint' | 'update' | 'bootstrap' | string;
  subject: string;
  body?: string;
  refs?: ReadonlyArray<string>;
}): ToolReturn<LogEntry>

// Read-only search
searchIndex(input: {
  query: string;
  filters?: { category?: string; type?: string; tags?: string[] };
}): ToolReturn<ReadonlyArray<SearchMatch>>

// Read-only resolution
wikilinkResolve(input: { link: string }): ToolReturn<Document | null>

// Atomic move + backlink rewrite
moveDocument(input: {
  from: string;
  to: string;
  reason: string;
  expected_mtime?: string;  // optimistic locking on `from`; see §"Concurrency"
}): ToolReturn<Document>

// Delete with hook-firing event
deleteDocument(input: {
  path: string;
  reason: string;
  expected_mtime?: string;  // optimistic locking; see §"Concurrency"
}): ToolReturn<void>
```

`ToolReturn<T>` is the `{ result: Result<T, ToolError>; effects: Effect[] }` shape defined in §"Tool" above. The Zod schema authoritative implementation lives in the SDK package; this spec carries the canonical TypeScript shape.

Plugin-registered Tools follow the same `input: object → ToolReturn<T>` convention.

#### Concurrency

Mutating Tools (`writeDocument`, `moveDocument`, `deleteDocument`) support **caller-supplied optimistic locking**. `readDocument` returns the document's filesystem `mtime` (ISO-8601 string) in the returned `Document`. Callers thread that mtime into the mutating call as `expected_mtime?: string`. The Tool re-reads the target's current `mtime` immediately before writing; on mismatch it returns:

```
Result.err({
  kind: 'concurrent-write-conflict',
  path: string,
  expected_mtime: ISODate,
  actual_mtime: ISODate
})
```

Omitting `expected_mtime` is the v0.5 default and means "last write wins" — no conflict detection. Workflows ingesting in a single-user, single-session vault (the common v0.5 case) can ignore it; multi-session harnesses that hold a Document across user turns thread it. See [[wiki/gotchas/concurrent-harness-write]] for full scenarios.

### Hook

A Hook is a handler registered against an event pattern. Hooks observe events derived from Tool Effects and may propose follow-on Tool calls. Hooks cannot mutate the vault directly — see [[wiki/invariants/HOOKS_CANNOT_BYPASS_TOOLS]].

Two registration forms (full details in [[wiki/specs/hooks]]):

- **Programmatic** — TypeScript file in `.dome/hooks/*.ts` calling `registerHook(eventPattern, handler)`.
- **Declarative** — YAML file in `.dome/hooks/*.yaml` declaring an event pattern + optional path-pattern filter + a workflow name.

Events are derived from Effects automatically; there is no `fireEvent` API. See [[wiki/matrices/event-types-and-payloads]].

**Two shipped default hooks** ride in the SDK as enabled-by-default:

- `auto-update-index` — on `document.written.wiki.*` and `document.deleted.wiki.*`, writes the affected index entries via `dispatcher.writeIndex(entry)` (the privileged internal API documented in [[wiki/invariants/INDEX_AND_LOG_ARE_DISPATCHER_OWNED]]).
- `auto-cross-reference` — on `document.written.wiki.entity`, searches the wiki for mentions of the new entity and writes backlinks via `writeDocument`.

`index.md` and `log.md` are dispatcher-owned per [[wiki/invariants/INDEX_AND_LOG_ARE_DISPATCHER_OWNED]]. Public Tools reject these paths; the dispatcher provides a privileged internal API (`dispatcher.writeIndex`, `dispatcher.appendLogEntry`) that shipped-default hooks and the `appendLog` Tool call. The privileged API is not part of the registration mechanism — plugins cannot register their own dispatcher-owned paths, and plugin / vault-local hook handlers receive a `HookContext` without the `dispatcher` field.

Both shipped defaults can be disabled in `.dome/config.yaml`. When `auto-update-index` is disabled, `index.md` is unmaintained — `dome doctor --rebuild-index` regenerates it from `wiki/` on demand (see [[wiki/specs/cli]] §"dome doctor"). When `auto-cross-reference` is disabled, new entity pages land without inbound backlinks; existing pages remain untouched until the user runs `dome lint` or re-enables the hook. The Dome project's docs vault leaves both enabled.

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
| **Axioms** | Cannot be disabled. Disabling them changes what Dome is. | `RAW_IS_IMMUTABLE`, `MARKDOWN_IS_SOURCE_OF_TRUTH`, `LOG_IS_APPEND_ONLY`, `HOOKS_CANNOT_BYPASS_TOOLS`, `VAULT_IS_GIT_REPO`, `INDEX_AND_LOG_ARE_DISPATCHER_OWNED`. The 7 Tools. `index.md` + `log.md`. MCP server. CLI commands. |
| **Shipped defaults** | Enabled by default; can opt out in `.dome/config.yaml`. | `EVERY_WRITE_IS_LOGGED`, `PAGE_TYPE_BY_DIRECTORY`, `WIKILINKS_ARE_FULLPATH`, `INBOX_IS_EPHEMERAL`. 4 default page types. `auto-update-index` + `auto-cross-reference` hooks. `intake-raw` shipped-default hook. `ingest`, `query`, `lint`, `migrate`, `export-context` workflows. |
| **Opt-in** | Shipped, not active by default. Activated by adding the corresponding hook YAML / workflow / invariant entry to `<vault>/.dome/`. | `SENSITIVE_GOES_TO_INBOX`, `PAGE_CREATION_REQUIRES_RECURRENCE`. `sensitivity-classify`, `voice-ingest`, `research`, `clip-integrate` workflows. `inbox/<bucket>/` directories beyond `inbox/raw/`. |

`dome init <path>` produces a minimal general-purpose vault — the axioms and shipped defaults, including the `intake-raw` shipped-default intake hook + the `inbox/raw/` directory it listens on. Activation of opt-in features beyond `intake-raw` is manual: copy the relevant hook YAML template from the SDK into `<vault>/.dome/hooks/` and create the `inbox/<bucket>/` directory the hook listens on. A future "packs" or "presets" mechanism may layer convenience over this; v0.5 keeps it manual.

The shipped-defaults catalog has a single source of truth in the SDK: `src/shipped-defaults.ts` exports `SHIPPED_VAULT_CONFIG: VaultConfig` and `SHIPPED_PAGE_TYPES: PageTypesConfig` as typed objects, plus YAML serializers (`shippedConfigYaml`, `shippedPageTypesYaml`) for the on-disk projections. The runtime fallback in `openVault`, the `dome init` / `dome migrate` scaffolder, and the eval / test vault factories all derive from the same constants — adding or flipping a shipped default touches one file.

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
- **Distribution**: `bun publish` to npm as `@dome/sdk` (placeholder name). Single package with two entrypoints:
  - `@dome/sdk` — the core SDK (Vault, Document, Tool, Hook, types, registrations, MCP). What a programmatic consumer or non-CLI shell embeds.
  - `@dome/sdk/cli` — the CLI shell (`runCli`, the seven `dome*` command functions, `CliError`, `renderCliError`). The `bin/dome` script and any consumer that wants to embed the CLI in its own process imports from here.

  The split is wired via `package.json` `exports`. A future mobile / web / voice shell consumes only `@dome/sdk` and never pulls Commander or the seven `dome <cmd>` implementations into its bundle.
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

The canonical inventory of derived operational state under `<vault>/.dome/state/` (gitignored, rebuildable, non-canonical) lives in [[wiki/specs/vault-layout]] §"Derived operational state under `.dome/`". As of v0.5: `last-reconciled-sha.txt`, `scheduled.json`, `quarantined.json`. Deleting any of them does not lose canonical knowledge — it just causes the next reconciliation pass or hook-dispatch cycle to do more work. The vault's markdown content (`wiki/`, `raw/`, etc.) is the only canonical surface, per [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]].

**Why no lockfile / in-flight tracking?** Earlier designs included `.dome/in-flight/<handler>-<event-id>.json` lockfiles for crash recovery. They're not needed: with per-workflow atomic commits (see §"Commit policy" below), idempotency contract on hooks (see [[wiki/specs/hooks]]), and `scheduled.json` for scheduled-event catchup, every hook-crash recovery case is covered by `git status` + `git diff` + `scheduled.json`. Adding lockfiles is overhead without solving a real problem.

### Commit policy

Dome workflows commit at completion (per-workflow atomic commit). See [[wiki/specs/hooks]] §"Commit policy" for the full mechanism. The short version: each workflow accumulates Effects in memory; applies them atomically; writes the log.md entry; runs `git add <touched-paths>` then `git commit -m "<log-subject>"`. Hooks (which run as their own workflows) commit independently.

User out-of-band edits remain uncommitted unless the user explicitly commits. Reconciliation handles both via `git diff` (committed) + `git status --porcelain` (uncommitted).

`.dome/config.yaml` `git.auto_commit_workflows` defaults to `true`; set to `false` for manual-only commit control.

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
