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

A Vault is a directory + config + registry. One `Vault` instance per process per vault path. Constructed by `openVault(path: string): Promise<Result<Vault, ToolError>>` — the factory returns a `Result` so failure modes (non-git directory; missing `.dome/`; corrupted config) surface as typed errors at the boundary rather than throwing; consumers unwrap with `if (!r.ok) handle(r.error)`. The instance, once unwrapped:

- Knows its `path` (absolute directory).
- Loads `.dome/page-types.yaml` and `.dome/config.yaml`.
- Loads its registry — see "Registration" below.
- Exposes the Tool methods listed in "Tools" below.
- Holds an in-process event queue for async Hook dispatch.

A Vault is opened, used, and closed in one process lifetime. There is no Vault server in v0.5; the process IS the vault runtime.

#### Vault surface

`openVault` returns a `Vault` with this surface (the canonical names other parts of this spec and consumers depend on):

- `path: string`, `config: VaultConfig`, `pageTypes: PageTypesConfig` — readonly resolved-from-disk values.
- `tools: BoundToolSurface` — the eight Tools curried with this Vault and the privileged writer. The canonical Tool entry point for in-process consumers; see §"Tool catalog" below.
- `drainHooks(): Promise<void>` — wait for all async hooks dispatched so far AND any in-flight quarantine persistence writes to settle. Tests, `dome reconcile`, and `vault.close()` call this to reach a deterministic state. Idempotent — re-callable without side effects.
- `dispatchEvents(events: ReadonlyArray<HookEvent>): Promise<void>` — push the given events through the Vault's hook dispatcher. Used by `dome reconcile` (inbox scan, git-diff replay, scheduled catchup) and `VaultWatcher` (out-of-band edits) to drive hook handlers without each subsystem having to assemble its own `ctxFactory`.
- `rebuildIndex(): Promise<void>` — regenerate `index.md` from scratch by walking every wiki page. Public SDK seam consulted by `dome doctor --rebuild-index` and any consumer that needs a from-scratch rebuild; consults the privileged writer internally rather than exposing it.
- `close(): Promise<void>` — release the Vault. See §"Vault lifecycle" below for the full semantics.

**Tool projections live off Vault.** The AI-SDK `ToolSet` shape (consumed by `runWorkflow` / `generateText`) is the only per-Vault Tool projection that lives outside the core entrypoint. Protocol-rendered projections (the MCP server's `ToolAdapter[]`; future HTTP/voice adapters) consume the **`AbstractSurface`** introduced in §"Consumer surfaces" below — they wrap `surface.tools` (which is the same `BoundToolSurface` that `vault.tools` exposes, one set of hook-dispatch-wrapped Tool entries per Vault) rather than re-binding the registry.

- `projectAiSdk(vault): ai.ToolSet` lives in `@dome/sdk/workflows`. Wraps each Tool in `vault.tools` as an AI-SDK `Tool<>` shaped for `generateText` consumption. The hook-dispatch wrap is the single-source helper named in §"Hook dispatch is intrinsic" below — `projectAiSdk` does not re-implement it.

The split honors [[wiki/invariants/CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY]]: a consumer that only reads/writes via `vault.tools` pays no LLM or MCP dependency cost. The protocol-rendered projections live in their respective entrypoints (`renderMcp` in `@dome/sdk/mcp`; future `renderHttp` in `@dome/sdk/http`) and consume the protocol-agnostic `AbstractSurface` produced by core.

##### Hook dispatch is intrinsic

Mutating Tools always fire the Vault's hook dispatcher after each invoke — `vault.tools.writeDocument`, the MCP adapter's `dome.write_document`, and the AI-SDK ToolSet's `writeDocument` all dispatch identically. The wrap is a **single-source helper**, `wrapMutatingInvoke(vault, entry, writer)` in `src/tools/registry.ts`, returning an `(input: unknown) => Promise<ToolReturn<unknown>>` that (a) invokes the Tool against its compact, schema-validated input, (b) reads `vault.dispatchEvents` lazily off the Vault closure, (c) calls `vault.dispatchEvents(projectEffectsToEvents(out.effects))` if `entry.mutating === true`. `bindTools` (the source for `vault.tools`) and `bindAiSdkTools` (the source for `projectAiSdk(vault)`) both consume the helper; protocol renderers (`renderMcp` reads `surface.tools` which is already wrapped via `bindTools`; future `renderHttp` / `renderVoice` do the same) inherit the wrap by construction because they project from `surface.tools` rather than re-binding the registry. Read-only Tools (`readDocument`, `searchIndex`, `wikilinkResolve`) emit no effects and are exposed unwrapped — the helper short-circuits when `entry.mutating === false`.

This is the [[wiki/invariants/HOOK_DISPATCH_IS_VAULT_BOUND]] axiom. Structural enforcement: the single-source helper plus `tests/integration/mcp-hook-dispatch.test.ts` (MCP path) and `tests/integration/ai-sdk-hook-dispatch.test.ts` (AI-SDK path). A future renderer (`renderHttp`, `renderVoice`) inherits the wrap by construction because it projects from `surface.tools` rather than re-binding the registry; a projection that re-implements the wrap inline regresses both tests.

#### Vault lifecycle

A Vault is opened, used, drained, and closed in one process lifetime. There is no Vault server in v0.5; the process IS the vault runtime.

```
openVault(path) → Result<Vault, ToolError>   (unwrap to Vault)
   │
   │   in-process use: vault.tools.*, vault.dispatchEvents(...), workflows, watchers
   │
   ├─→ drainHooks()  (idempotent; settles async hook queue + quarantine writes)
   │
   └─→ close()        (one-shot; drains hooks then releases resources)
```

**`drainHooks()`** is idempotent — re-callable any number of times. It awaits both `HookDispatcher.drain()` (the p-queue) AND `HookRegistry.flushPersist()` (the quarantine-write chain). Callers that need a deterministic post-hook state (tests, `dome reconcile`, the CLI's `--drain-hooks` flag) invoke it without coordinating with other callers.

**`close()`** is one-shot. Semantics: (a) call `drainHooks()` to settle outstanding work; (b) flip an internal `closed` flag so subsequent `vault.dispatchEvents(...)` calls become silent no-ops — the dispatcher accepts no new event work after close. `vault.tools.X` calls are NOT guarded in v0.5 (the Tool function still writes the file), but their hook-dispatch side-effects no-op via the closed flag, so post-close mutations are "silent": the file changes but `auto-update-index`, `auto-cross-reference`, and declarative-YAML hooks do not fire. The flag is the load-bearing v1+ seam for long-running mobile/desktop shells that open and re-open Vaults — calls that accidentally outlive the Vault's intended lifetime fail quietly rather than queueing events into a dispatcher whose handlers may have been freed. A stricter post-close guard on `vault.tools.X` is reserved for a future minor.

The watcher lifecycle is **outside** the Vault. `VaultWatcher` is always caller-owned: constructed by the consumer (e.g., `domeServe`), started by the consumer, stopped by the consumer. `vault.close()` does NOT stop watchers — even ones that were dispatching into `vault.dispatchEvents(...)` — because the Vault doesn't know about them. The caller-owns-resource pattern mirrors Bun's file handles: whoever opened it, closes it.

#### Composable construction

`openVault(path)` is the canonical entry point and remains a one-call construction for the common case. Internally it composes three named helpers, each independently consumable by a future consumer surface that wants a custom subset of the built-in Vault behavior:

```ts
async function openVault(root: string): Promise<Result<Vault, ToolError>> {
  const { config, pageTypes } = await loadVaultConfig(root);
  const registry = buildBuiltinHookRegistry(root, config);
  const vaultRef: { current: Vault | null } = { current: null };
  const wired = wireDispatcher(registry, makePrivilegedWriter(root), { vaultRef });
  const vault: Vault = { path: root, config, pageTypes, tools: bindTools(root, wired.dispatchEvents),
                         drainHooks: wired.drainHooks, dispatchEvents: wired.dispatchEvents,
                         rebuildIndex: /* ... */, close: wired.close };
  vaultRef.current = vault;
  await loadDeclarativeHooks(root, registry, vault);
  return Result.ok(vault);
}
```

The three helpers:

- **`loadVaultConfig(root): Promise<{ config: VaultConfig; pageTypes: PageTypesConfig }>`** — reads `.dome/config.yaml` and `.dome/page-types.yaml`, applies the shipped-default fallback for missing files, returns the resolved configs. Pure I/O; no side effects beyond file reads.
- **`buildBuiltinHookRegistry(root, config): HookRegistry`** — constructs a `HookRegistry` and registers the built-in shipped-default handlers (`auto-update-index`, `auto-cross-reference`, `log-out-of-band-write`, `intake-raw` per `.dome/config.yaml.hooks.enabled` flags). Returns the populated registry.
- **`wireDispatcher(registry, writer, { vaultRef }): { dispatcher, dispatchEvents, drainHooks, close }`** — constructs the `HookDispatcher`, wires the cycle-detection listener, and returns the closures `openVault` exposes as Vault methods. The `vaultRef: { current: Vault | null }` setter is the structural fence against the temporal-dead-zone scar earlier shapes carried: closures hold a reference to the *holder* of the Vault, not the Vault itself, so the closure order does not depend on which line of `openVault` runs first. `wireDispatcher` returns before the Vault exists; `dispatchEvents` reads `vaultRef.current` at call-time.

**The `vaultRef` setter is load-bearing.** It replaces three positional-ordering rules earlier shapes of `openVault` carried (the "TDZ closure" comment, the "loadDeclarativeHooks LAST" comment, the cycle-listener wiring window). With `vaultRef`, the construction order is free: `wireDispatcher` returns before `vault` is assigned; `loadDeclarativeHooks` runs at any point after `registry` is populated and `vault` is published to `vaultRef.current`; the cycle listener attaches to the dispatcher before the Vault exists. The bootstrap-order regression test at `tests/integration/vault-bootstrap-order.test.ts` scrambles the section order and asserts hook-cycle logging still works — the structural fence against a future contributor "tidying up" `openVault` into a TDZ-prone shape.

A future v1 consumer surface (e.g., a desktop shell that wants a Vault-without-watcher, or an in-memory test Vault, or a Vault with a different built-in hook set) consumes the three helpers independently:

```ts
// A v1 desktop shell that wants a Vault with a custom hook registry
const { config, pageTypes } = await loadVaultConfig(root);
const registry = new HookRegistry();
registry.register(autoUpdateIndex);
registry.register(myDesktopShellHook);
const vaultRef = { current: null as Vault | null };
const wired = wireDispatcher(registry, makePrivilegedWriter(root), { vaultRef });
const vault: Vault = { path: root, config, pageTypes, ...wired, tools: bindTools(root, wired.dispatchEvents) };
vaultRef.current = vault;
```

`openVault(path)` remains the recommended path for the 99% case; the composable-construction shape is the v1+ extensibility seam.

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

A Tool is a typed function that operates on a Vault and one or more Documents. Every mutation *within Dome's own dispatcher / hook / workflow chain* flows through a Tool — Tools are the only legitimate path for internal mutation; see [[wiki/invariants/HOOKS_CANNOT_BYPASS_TOOLS]] (axiom: hooks observe events and call Tools; they never write directly).

Consumer shells (Claude Code's native `Write`, vim, Obsidian, the Dome mobile app once it ships) write to the vault filesystem directly. These external writes are *not* routed through Tools; the watcher catches them, fires `vault.out-of-band-edit`, hooks react, and `dome reconcile` catches up any events the daemon missed — see [[VISION]] §"Principles" #3 "Invariants are enforced two ways, by scope" and [[wiki/invariants/VAULT_RECONCILES_AFTER_NATIVE_WRITE]] for the integrity story for external writes.

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

#### Tool catalog (the eight)

The SDK ships exactly **eight Tools**. Anything beyond mutation primitives is a workflow (a prompt the agent loads) or a hook (a handler against events) — see the anti-concept list below.

Naming convention: Tools that operate on any Document use `<verb>Document`; Tools that operate on a specific Dome surface (`log.md`, the index, wikilinks, marker-delimited page sections) use their surface-specific name.

`(auto)` in the Invariants column means the Tool's effect array always includes the corresponding Effect — the caller does not separately invoke that Effect's producer Tool. For `EVERY_WRITE_IS_LOGGED (auto)`, the Tool emits its `appendLog` Effect alongside the primary mutation Effect; the caller does not call `appendLog` explicitly. The matrix at [[wiki/matrices/tool-invariant-enforcement]] spells the same semantic per-cell ("emits appendLog effect when default enabled").

| Tool | Purpose | Invariants enforced (axioms in **bold**) |
|---|---|---|
| `readDocument` | Read a Document by path. | — |
| `writeDocument` | Create or update a Document anywhere in the vault. | **`RAW_IS_IMMUTABLE`**, **`INDEX_AND_LOG_ARE_DISPATCHER_OWNED`**, `PAGE_TYPE_BY_DIRECTORY`, `WIKILINKS_ARE_FULLPATH`, `EVERY_WRITE_IS_LOGGED` (auto), opt-in: `PAGE_CREATION_REQUIRES_RECURRENCE` |
| `upsertSection` | Idempotently insert or update a marker-delimited section of an existing Document. Find-or-create by `<!-- section:<key> -->` markers; replace section body in place if the markers exist, append the section with markers if they don't. | **`RAW_IS_IMMUTABLE`**, **`INDEX_AND_LOG_ARE_DISPATCHER_OWNED`**, `WIKILINKS_ARE_FULLPATH`, `EVERY_WRITE_IS_LOGGED` (auto) |
| `appendLog` | Append an entry to `log.md`. The only mutation primitive for `log.md`. | **`LOG_IS_APPEND_ONLY`** |
| `searchIndex` | Search the index + page bodies for matches. | — |
| `wikilinkResolve` | Resolve a wikilink to a Document or `null`. | `WIKILINKS_ARE_FULLPATH` |
| `moveDocument` | Move a Document; rewrites incoming wikilinks atomically. Refuses if either path is under `raw/`. | **`RAW_IS_IMMUTABLE`**, **`INDEX_AND_LOG_ARE_DISPATCHER_OWNED`**, `EVERY_WRITE_IS_LOGGED` (auto), `PAGE_TYPE_BY_DIRECTORY` |
| `deleteDocument` | Delete a Document. Refuses under `raw/`. Fires `document.deleted.<category>.<type>` so cleanup hooks can react. | **`RAW_IS_IMMUTABLE`**, **`INDEX_AND_LOG_ARE_DISPATCHER_OWNED`**, `EVERY_WRITE_IS_LOGGED` (auto) |

`writeDocument` is the universal mutation entrypoint for creates and updates. `upsertSection` is the idempotent-by-construction mutation for marker-delimited subsections — used by extension-bundle workflows that append-or-update narrative sections on existing pages (entity "Recent context", concept "Recent positions", weekly-rollup sections) without duplicating on re-fire. `moveDocument` atomically relocates + rewrites backlinks. `deleteDocument` removes pages cleanly (lint proposes deleting orphan pages; users retire obsolete syntheses; migrate may delete superseded files). Ingest writes to `wiki/<type>/<name>.md`; quick-capture writes to `inbox/raw/<ts>.md`; lint reports write to `inbox/review/lint-report-YYYY-MM-DD.md`. The path determines the category and the invariant-enforcement profile.

The catalog is open: plugins register additional Tools through the registration mechanism. The eight above are the entirety of what the SDK ships.

#### Tool catalog is one declarative array

The eight Tools above are declared once, in `src/tools/registry.ts`, as the canonical `TOOL_REGISTRY`. Every downstream catalog — the `BoundToolSurface` exposed on `Vault.tools`, the AI SDK `ToolSet` produced by `projectAiSdk(vault)`, the MCP `ToolAdapter[]` produced by `renderMcp(surface)`, the snake_case names in `MCP_TOOL_NAMES`, the Zod enum that validates workflow-prompt frontmatter `tools:` lists — derives from this one array. Adding a 9th Tool in v0.5.1 / v1+ is two file edits: a new `src/tools/<name>.ts` implementation, and one new entry in the registry. `renderMcp`, the AI SDK exposure, the frontmatter validator, and the bound surface all pick it up automatically.

This is the structural enforcement of "the canonical Tool set, sealed." Prior to the registry, the canonical names lived in five+ parallel catalogs and the seal depended on reviewer attention.

#### Tool signatures

Canonical input/output shapes for the eight Tools. Other specs and invariant docs cite these shapes rather than restate them inline.

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
  }
}): ToolReturn<Document>

// Idempotent marker-delimited section update.
// Finds <!-- section:<sectionKey> --> ... <!-- /section:<sectionKey> --> markers
// in the document body; replaces the content between them with `content`.
// If markers are absent, appends the markers + content to the end of the body.
// Re-running with the same `(path, sectionKey, content)` produces no diff
// (the read-write cycle short-circuits when content matches).
upsertSection(input: {
  path: string;
  sectionKey: string;          // identifier embedded in the marker; e.g., "recent-context-2026-05-26"
  content: string;             // section body; markdown
  expected_mtime?: string;     // optimistic locking on the underlying document
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

**Three shipped default hooks** ride in the SDK as enabled-by-default:

- `auto-update-index` — on `document.written.wiki.*` and `document.deleted.wiki.*`, writes the affected index entries via `dispatcher.writeIndex(entry)` (the privileged internal API documented in [[wiki/invariants/INDEX_AND_LOG_ARE_DISPATCHER_OWNED]]).
- `auto-cross-reference` — on `document.written.wiki.entity`, searches the wiki for mentions of the new entity and writes backlinks via `writeDocument`.
- `intake-raw` — the shipped-default intake hook on `document.written.inbox.raw.*`, invoking the `ingest` workflow to compile raw captures into wiki updates. The hook's declarative YAML ships at `.dome/hooks/intake-raw.yaml` via `dome init`; see [[wiki/specs/hooks]] §"Intake patterns — shipped-default and opt-in" for the full intake-pattern shape and how `intake-raw` differs from the four opt-in intake templates.

`index.md` and `log.md` are dispatcher-owned per [[wiki/invariants/INDEX_AND_LOG_ARE_DISPATCHER_OWNED]]. Public Tools reject these paths; the dispatcher provides a privileged internal API (`dispatcher.writeIndex`, `dispatcher.appendLogEntry`) that shipped-default hooks and the `appendLog` Tool call. The privileged API is not part of the registration mechanism — plugins cannot register their own dispatcher-owned paths, and plugin / vault-local hook handlers receive a `HookContext` without the `dispatcher` field.

All three shipped defaults can be disabled in `.dome/config.yaml`. When `auto-update-index` is disabled, `index.md` is unmaintained — `dome doctor --rebuild-index` regenerates it from `wiki/` on demand (see [[wiki/specs/cli]] §"dome doctor"). When `auto-cross-reference` is disabled, new entity pages land without inbound backlinks; existing pages remain untouched until the user runs `dome lint` or re-enables the hook. When `intake-raw` is disabled (by removing the YAML or the `inbox/raw/` directory), quick-capture stops compiling automatically — captured files remain in `inbox/raw/` until the user runs `dome reconcile` or re-enables the hook. The Dome project's docs vault leaves all three enabled.

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

The 5×3 registration matrix is exhaustive. "Plugins" is a packaging convention — an npm package that registers any combination of the five kinds — not a primitive. **Extension bundles** are the second packaging convention — a vault-local directory under `<vault>/.dome/extensions/<name>/` that registers any combination of the five kinds; see §"Extension bundles" below.

## Extension bundles

An **extension bundle** is a packaging convention: a directory under `<vault>/.dome/extensions/<bundle-name>/` containing a `manifest.yaml` plus any combination of the five registration kinds. Bundles are *not* a new primitive — they are a coherent unit of vault-local additions over the existing 5-kind registration surface. The bundle mechanism makes "ship one feature as a coherent unit" possible without each feature having to hand-thread its page-type registration, AGENTS.md teaching, workflows, hooks, and CLI commands into the vault separately.

### Bundle directory shape

```
<vault>/.dome/extensions/<bundle-name>/
  manifest.yaml          # bundle identity: name, version, optional deps
  page-types.yaml        # optional — extension types this bundle contributes
  preamble.md            # optional — fragment threaded into AGENTS.md templated section
  workflows/             # optional — prompt files with workflow frontmatter
    *.md
  hooks/                 # optional — declarative YAML (v0.5) or programmatic TS (v0.5.1+)
    *.yaml
  cli/                   # optional — bundle-contributed CLI commands
    *.ts
  tools/                 # optional — bundle-contributed Tools (v0.5.1+)
    *.ts
```

The five contribution kinds map one-to-one onto the registration kinds in the §"Registration" table above. A bundle that contributes only a page type and a hook is a valid bundle; a bundle that contributes nothing (empty directory besides `manifest.yaml`) loads as a no-op. See [[wiki/matrices/extension-bundle-shape]] for the canonical map of which bundle contributes which kinds.

### `manifest.yaml` schema

```yaml
name: dailies              # required; matches directory name
version: 1.0.0             # required; semver
description: "..."         # optional
deps: []                   # optional; future v0.5.1+ for cross-bundle dependencies
```

`name` MUST equal the bundle's directory name; the loader rejects mismatches per the `bundle-load-failure` error taxonomy below. `version` is informational in v0.5; v0.5.1+ may layer dependency resolution.

#### Bundle-loader error taxonomy

The bundle loader returns a single `ToolError` kind on all bundle-load failures: `kind: 'bundle-load-failure'`, with a `detail:` discriminator naming the specific failure. The canonical detail values are:

| `detail:` discriminator | When it fires |
|---|---|
| `manifest-missing` | `<bundle>/manifest.yaml` does not exist; the directory is rejected as a bundle. |
| `manifest-invalid` | `<bundle>/manifest.yaml` fails Zod validation (missing `name:`, malformed `version:`, etc.). |
| `name-mismatch` | `<bundle>/manifest.yaml`'s `name:` field does not equal the directory name. |
| `page-type-collision` | Two bundles declare the same page-type `name:` in their `page-types.yaml extensions:` blocks; OR a bundle's page-type collides with a vault-local declaration in `<vault>/.dome/page-types.yaml`. The detail message names both sources and the colliding key. |
| `workflow-invalid` | A `<bundle>/workflows/<name>.md` fails workflow-frontmatter validation (missing `tools:`, unknown tool name, etc.). |
| `hook-invalid` | A `<bundle>/hooks/<name>.yaml` fails `DeclarativeHookSchema` validation (per [[wiki/specs/hooks]] §"Declarative — `.dome/hooks/*.yaml`"). |
| `cli-collision` | A `<bundle>/cli/<name>.ts` exports a command name that collides with a shipped CLI command or another bundle's CLI command. |

Adding a new failure mode is one `detail:` value addition; the `kind:` stays `bundle-load-failure` so callers that handle the kind once continue to work. See [[wiki/gotchas/extension-bundle-load-order]] for the `page-type-collision` and `cli-collision` scenarios in particular.

### Bundle load lifecycle

`openVault` loads bundles after vault-local files in the existing load order (SDK defaults → plugins → vault-local → **extension bundles**). Bundles within `.dome/extensions/` load alphabetically by directory name. Each loaded bundle:

1. **Page-types merge.** Entries in `<bundle>/page-types.yaml extensions:` are appended to the vault's `PageTypesConfig.extensions` list. Cross-bundle name collisions reject the load per [[wiki/gotchas/extension-bundle-load-order]].
2. **Preamble fragment.** `<bundle>/preamble.md` content is captured for inclusion in AGENTS.md's templated `## Extension conventions` section on the next `dome doctor --repair` (and on `dome init` for fresh vaults). Per [[wiki/invariants/AGENTS_MD_IS_ORIENTATION_SURFACE]] §"Extension-bundle preamble fragments", fragments render in load order as subsections.
3. **Workflows merge.** `<bundle>/workflows/*.md` are added to the vault's `PromptLoader` per [[wiki/specs/prompts-and-workflows]] §"Prompt loading lifecycle". The loader scans extension directories alongside `<vault>/.dome/prompts/`.
4. **Hooks register.** `<bundle>/hooks/*.yaml` (and `*.ts` in v0.5.1+) are registered against the vault's `HookRegistry` with ID `<bundle>:<filename>`. The bundle-name prefix prevents cross-bundle hook-ID collision.
5. **CLI commands register.** `<bundle>/cli/*.ts` are added to the `runCli` command set, appearing in `dome --help` after the SDK's shipped commands.
6. **Tools register** (v0.5.1+). `<bundle>/tools/*.ts` are added to the vault's tool registry, projected into `BoundToolSurface`, `projectAiSdk`, and `renderMcp` automatically via the registry-derives-from-one-array pattern.

The bundle loader is **fail-loud**: a malformed `manifest.yaml`, a missing referenced workflow, an invalid hook YAML, or a cross-bundle collision aborts `openVault` with a `bundle-load-failure` `ToolError`. The hand-installed v0.5 use case benefits from immediate feedback over silent skip-and-continue.

### How bundles ship

First-party bundles ship from the SDK at `assets/extensions/<bundle-name>/`. The Phase 1 `dailies` bundle (page type + preamble + creator workflows + scheduled hooks + the bundle-contributed `migrate-dailies` CLI command) is the first such ship; subsequent first-party bundles (`aggregation` for weekly/monthly rollups, `recall` for query workflows) ship the same way.

Users install a first-party bundle by copying its directory into `<vault>/.dome/extensions/`:

```bash
cp -r $(bun pm root)/@dome/sdk/assets/extensions/dailies ~/vaults/work/.dome/extensions/
dome doctor --repair    # regenerates AGENTS.md with the dailies preamble fragment
```

A `dome install-extension <name>` CLI helper is deferred to v0.5.1+; v0.5 ships the copy-by-hand pattern documented above. Third-party bundles follow the same copy-into-`.dome/extensions/` path; npm-distributable bundles are a v1+ concern out of scope for v0.5.

### Why bundles aren't a new primitive

A bundle is fundamentally just a directory of registration entries that happen to be packaged together. The substrate concept is still the 5-kind registration surface; "bundle" is a load-grouping convention that makes ergonomic features (page-type + preamble + workflows + hooks shipped as one unit) practical. Adding a bundle does not extend the four-concept core (Vault, Document, Tool, Hook); it composes registrations.

## Tiered feature model

The SDK ships features across three tiers. The tier determines whether a feature is active in a given vault.

| Tier | Description | Examples |
|---|---|---|
| **Axioms** | Cannot be disabled. Disabling them changes what Dome is. | The axiom-tier invariants (canonical list: [[wiki/invariants/]] filtered by `tier: axiom`; `src/types.ts` `INVARIANTS` for the typed const). The 8 Tools. `index.md` + `log.md`. CLI commands. |
| **Shipped defaults** | Enabled by default; can opt out in `.dome/config.yaml`. | `EVERY_WRITE_IS_LOGGED`, `PAGE_TYPE_BY_DIRECTORY`, `WIKILINKS_ARE_FULLPATH`, `INBOX_IS_EPHEMERAL`, `AGENTS_MD_IS_ORIENTATION_SURFACE`. 4 default page types. `auto-update-index` + `auto-cross-reference` hooks. `intake-raw` shipped-default hook. `ingest`, `query`, `lint`, `migrate`, `export-context` workflows. `inbox/raw/` + `inbox/review/` directories. |
| **Opt-in** | Shipped, not active by default. Activated by adding the corresponding hook YAML / workflow / invariant entry to `<vault>/.dome/`. | `PAGE_CREATION_REQUIRES_RECURRENCE`. `voice-ingest`, `research`, `clip-integrate` workflows. `inbox/<bucket>/` intake directories beyond `inbox/raw/`. |

The MCP server is *not* a tier in the table above — it is a preserved code surface, non-primary in v0.5 per [[wiki/specs/mcp-surface]] §"Status in v0.5". The table's tiers describe invariant/feature *enablement*; the MCP server is a *consumer-shell entrypoint choice* (the first per-protocol renderer over `AbstractSurface`, per §"Consumer surfaces" below) and lives outside the enablement-tier model.

`dome init <path>` produces a minimal general-purpose vault — the axioms and shipped defaults, including the `intake-raw` shipped-default intake hook + the `inbox/raw/` directory it listens on, and the `inbox/review/` lint-report destination. Activation of opt-in features beyond `intake-raw` is manual: copy the relevant hook YAML template from the SDK into `<vault>/.dome/hooks/` and create the `inbox/<bucket>/` directory the hook listens on. A future "packs" or "presets" mechanism may layer convenience over this; v0.5 keeps it manual.

The shipped-defaults catalog has a single source of truth in the SDK: `src/shipped-defaults.ts` exports `SHIPPED_VAULT_CONFIG: VaultConfig` and `SHIPPED_PAGE_TYPES: PageTypesConfig` as typed objects, plus YAML serializers (`shippedConfigYaml`, `shippedPageTypesYaml`) for the on-disk projections. The runtime fallback in `openVault`, the `dome init` / `dome migrate` scaffolder, and the eval / test vault factories all derive from the same constants — adding or flipping a shipped default touches one file.

### Adding a new invariant

Three file edits, paralleling the "Adding a 9th Tool" recipe in §"Tool catalog is one declarative array":

1. **Add a `NAME: "NAME"` entry** to `src/types.ts` `INVARIANTS`. The const is `as const` and produces `InvariantName = typeof INVARIANTS[keyof typeof INVARIANTS]` — adding the entry extends the union type everywhere `InvariantName` is referenced (the `ToolError` `invariant-violated` kind; the cohesion-scorecard surface; the `dome doctor` invariant-coverage check).
2. **Create the doc** at `docs/wiki/invariants/<NAME>.md` from the invariant template (statement, tier, why, structural enforcement, counter-example, test guarantee, related). Tier is one of axiom / shipped-default / opt-in; the tier choice has structural consequences (axioms cannot be disabled in `.dome/config.yaml`; shipped-defaults can; opt-ins ship inactive).
3. **Create the test** at `tests/invariants/<slug>.test.ts` (slug = NAME lowercased with underscores → hyphens). The AC3 lockstep test at `tests/integration/invariant-coverage.test.ts` iterates `Object.entries(INVARIANTS)` and asserts each named invariant has a corresponding test file — missing a test file fails AC3.

For an **off-matrix invariant** (one not enforced at a Tool's call site — e.g., `CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY` enforced at the bundling layer, `HOOK_DISPATCH_IS_VAULT_BOUND` enforced at the registry-helper layer), the `tests/invariants/<slug>.test.ts` file is **not** a `expect(true).toBe(true)` stub. It imports from the canonical enforcement test (e.g., `tests/integration/bundle-deps.test.ts` for the LLM/MCP boundary) and asserts the structural fence runs there. See §"Off-matrix lockstep convention" below for the canonical stub shape.

The shipped-default tier additionally edits `src/shipped-defaults.ts` `SHIPPED_VAULT_CONFIG.invariants` to add the enable flag; the opt-in tier ships the invariant as inactive (the doc says `tier: opt-in`; activation happens by the user adding the corresponding entry to `<vault>/.dome/config.yaml`).

#### Off-matrix lockstep convention

The five off-matrix invariants — `VAULT_IS_GIT_REPO`, `INBOX_IS_EPHEMERAL`, `CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY`, `WORKFLOWS_KNOW_VAULT_CONTEXT`, `HOOK_DISPATCH_IS_VAULT_BOUND` — are enforced at boundaries other than a Tool's call site. Their `tests/invariants/<slug>.test.ts` lockstep file follows the **delegating-stub** shape:

```ts
// tests/invariants/hook-dispatch-is-vault-bound.test.ts
import { describe, test } from "bun:test";

describe("HOOK_DISPATCH_IS_VAULT_BOUND (off-matrix)", () => {
  test("enforced by tests/integration/mcp-hook-dispatch.test.ts (MCP projection)", async () => {
    await import("../integration/mcp-hook-dispatch.test");
  });
  test("enforced by tests/integration/ai-sdk-hook-dispatch.test.ts (AI-SDK projection)", async () => {
    await import("../integration/ai-sdk-hook-dispatch.test");
  });
});
```

The dynamic `import("...")` runs the linked test file's `describe`/`test` blocks; a regression in either projection fails the lockstep stub's test for the off-matrix invariant. The `expect(true).toBe(true)` shape is **not** the convention — it produces a stub that AC3 accepts but that enforces nothing.

The AC3 meta-check at `tests/integration/invariant-coverage.test.ts` requires the lockstep file to either run a `describe()` block referencing the enforcement test (for off-matrix invariants) or contain at least one `expect()` call against vault state (for on-matrix invariants). The check is a structural fence against the no-op stub shape the pass-3 architecture review surfaced.

### Adding a new extension bundle

Three file edits at minimum, plus optional contributions across the five registration kinds. Paralleling the "Adding a 9th Tool" and "Adding a new invariant" recipes:

1. **Create the bundle directory** at `assets/extensions/<name>/` (for SDK-shipped first-party bundles) or document the vault-local copy path. The directory name IS the bundle name.

2. **Write `manifest.yaml`** declaring `name: <name>` (must match directory) and `version: <semver>`. Optional `description:` and `deps:` (deps are informational in v0.5).

3. **Write `preamble.md`** explaining the bundle's conventions in agent-readable prose. This is the single most-important contribution — it's what teaches the agent how to write into the bundle's domain correctly. The fragment renders as a subsection of AGENTS.md's templated `## Extension conventions` section per [[wiki/invariants/AGENTS_MD_IS_ORIENTATION_SURFACE]] §"Extension-bundle preamble fragments".

The bundle then optionally contributes to any of the five registration kinds:

4. **Page types** — declare in `<bundle>/page-types.yaml extensions:` block per [[wiki/specs/page-schema]] §"Extension types". Each contributed type creates a `wiki/<plural>/` recognized directory and (optionally) a frontmatter schema.

5. **Workflows** — markdown prompts in `<bundle>/workflows/<name>.md` with workflow frontmatter per [[wiki/specs/prompts-and-workflows]]. The bundle's workflows are loaded by the per-Vault `PromptLoader` alongside vault-local prompts.

6. **Hooks** — declarative YAML in `<bundle>/hooks/<name>.yaml` (event-reactive or schedule-driven per [[wiki/specs/hooks]] §"Adding a new hook"). Hook IDs are bundle-namespaced as `<bundle>:<filename>` to prevent cross-bundle collision.

7. **CLI commands** — TypeScript in `<bundle>/cli/<command>.ts`, mirroring vault-local `<vault>/.dome/cli/*.ts` shape. Appear in `dome --help` when the bundle is loaded.

8. **Tools** (v0.5.1+) — TypeScript in `<bundle>/tools/<name>.ts`, registered into `TOOL_REGISTRY` at bundle load.

9. **Add a row to [[wiki/matrices/extension-bundle-shape]]** naming the bundle, its `Status` (`shipped` / `test-fixture` / `anticipated`), and which filename in the bundle provides each contribution kind. The matrix is the structural pin: a first-party bundle the SDK ships without a row in the matrix is a substrate violation (v0.5.1 lockstep test catches this). This step parallels the AC3 lockstep discipline for §"Adding a new invariant" (which iterates `Object.entries(INVARIANTS)`) — both recipes anchor their substrate to a structural fence that catches missed steps automatically.

The Phase 1 `dailies` bundle is the canonical example: contributes `daily` and `weekly` page types, a preamble explaining Obsidian-Tasks-plugin-syntax conventions and the carry-forward semantic, two creator workflows + their schedule-driven hooks, and the `migrate-dailies` CLI command.

## Consumer surfaces

Every consumer shell that builds against Dome (the v0.5-shipped CLI and MCP server today; v1+ mobile/desktop/voice/web later) aggregates four kinds of things from the SDK:

- **Tools** — the eight mutation primitives via the `BoundToolSurface` exposed at `vault.tools` (protocol-agnostic; one set per Vault).
- **Prompts** — Dome's shipped workflow prompts (and any plugin/vault-local additions), described as protocol-agnostic descriptors.
- **Resources** — read-only views of vault content (index, log, individual pages, vault info), described as protocol-agnostic descriptors.
- **Instructions** — cold-start orientation: invariants enabled in this vault, page types declared, the `AGENTS.md` user-tendable preamble; a single string.

The aggregation is split across two layers — **`AbstractSurface`** (protocol-agnostic; lives in `@dome/sdk` core) and **per-protocol renderers** (one per consumer protocol; live in their respective entrypoints). This is the structural shape that makes v1+ multi-surface work cheap: a new protocol adapter ships as one render function, not as a parallel aggregation.

### `AbstractSurface` (in `@dome/sdk` core)

```ts
interface AbstractSurface {
  readonly tools: BoundToolSurface;
  readonly prompts: ReadonlyArray<PromptDescriptor>;
  readonly resources: ReadonlyArray<ResourceDescriptor>;
  readonly instructions: string;
  readonly readDynamicResource: (uri: string) => Promise<string | null>;
}

function buildAbstractSurface(vault: Vault): Promise<AbstractSurface>;
```

`tools` is exactly `vault.tools` — the same `BoundToolSurface` reachable directly on the Vault. No protocol shaping happens at the abstract layer.

`prompts` is a list of `PromptDescriptor` records — each carries a bare name (`"ingest"`, `"lint"`, `"system-base"`; no protocol prefix), an optional description, a fully-resolved `body: string` (the system prompt text with includes resolved and template variables substituted), and an optional `tier` indicating the workflow's shipping status. Protocol-specific naming (`dome.workflow.<name>` for MCP, future REST paths for HTTP) and protocol-specific argument shape are applied by the per-protocol renderer. v0.5 PromptDescriptors are static-body shape; **parameterized prompts with Zod-validated `arguments` + a `getMessages(args)` callback are deferred to v0.5.1+** when a workflow first needs argument templating — the descriptor grows the optional fields; existing static-body consumers continue to read `body` directly.

`resources` is a list of `ResourceDescriptor` records — each carries a logical URI (e.g., `"index"`, `"log"`, `"vault/info"`), an optional MIME type, and a `read()` callback returning the content. Protocol-specific URI prefixing (`dome://` for MCP, REST routes for HTTP) is applied by the renderer.

`readDynamicResource(uri)` is the fifth field on `AbstractSurface` because page content is not enumerable. The `resources` list above is the static catalog (index, log, vault info — fixed-set URIs the renderer can declare at startup); `readDynamicResource` is the callback for *templated* resource URIs the protocol exposes as a parameterized lookup. MCP renders this as the `page/<path>` URI template (`dome://page/wiki/entities/danny`); a future HTTP renderer renders it as `/resources/page/{path}`. The split exists because MCP's `resources/list` payload only carries fixed URIs and shouldn't enumerate the vault; `readDynamicResource` handles the `resources/read` side. Returns `null` for unknown URIs.

`instructions` is the same opaque string every protocol surfaces — cold-start orientation text composed from `system-base.md`, the enabled invariants, the page types declared, and the vault-local `AGENTS.md`.

`buildAbstractSurface(vault)` returns `Promise<AbstractSurface>` because the prompt and instructions reads are async: scanning `<vault>/.dome/prompts/` for vault-local overrides and reading `AGENTS.md` at vault root are filesystem reads. The factory constructs one `PromptLoader` per Vault and threads it through prompt-descriptor production and instructions-builder both — see [[wiki/specs/prompts-and-workflows]] §"Prompt loading lifecycle" for the full one-PromptLoader-per-Vault contract that `WorkflowRegistry` and `runWorkflow` extend by accepting the loader as an optional parameter.

### `renderMcp` (in `@dome/sdk/mcp`)

```ts
interface McpSurface {
  readonly tools: ReadonlyArray<ToolAdapter>;
  readonly prompts: ReadonlyArray<McpPromptAdapter>;
  readonly resources: ResourceAdapter;
  readonly instructions: string;
}

function renderMcp(surface: AbstractSurface): McpSurface;
```

`renderMcp` is a synchronous projection: it wraps each Tool in `surface.tools` as an MCP `ToolAdapter` (`dome.*` snake_case name, the MCP handler signature, schema rendered to JSON Schema via `zod-to-json-schema`); wraps each `PromptDescriptor` as an `McpPromptAdapter` with the `dome.workflow.<name>` (or `dome.system_prompt`) prefix and the descriptor's resolved `body` as the prompt content (v0.5 PromptDescriptors are static-body; v0.5.1+'s parameterized shape will fill MCP's `arguments` array from the descriptor's then-future Zod schema); wraps the `ResourceDescriptor` list into a single `ResourceAdapter` that registers `dome://` URIs for the static catalog and dispatches `dome://page/<path>` reads to `surface.readDynamicResource(uri)` for the dynamic-page lookups; passes `instructions` through unchanged.

`DomeMcpServer` is a thin protocol adapter over `McpSurface`:

```ts
import { openVault, buildAbstractSurface } from "@dome/sdk";
import { renderMcp, DomeMcpServer } from "@dome/sdk/mcp";

const vaultR = await openVault(path);
if (!vaultR.ok) throw vaultR.error;
const surface = await buildAbstractSurface(vaultR.value);
const mcp = renderMcp(surface);
const server = new DomeMcpServer({ surface: mcp });
await server.serveStdio();
```

### Future renderers (`renderHttp`, `renderVoice`, …)

A v1+ HTTP shell ships `renderHttp(surface: AbstractSurface): HttpSurface` in `@dome/sdk/http` — wrapping `surface.tools` as REST route handlers, `surface.prompts` as `/prompts/<name>` GET endpoints, `surface.resources` as `/resources/<uri>` GET endpoints, `surface.readDynamicResource` as the `/resources/page/{path}` parameterized route, and `surface.instructions` in the `/initialize` response. The same aggregation logic that produces `surface` is reused; only the wire format changes.

The five-field shape (`tools`, `prompts`, `resources`, `instructions`, `readDynamicResource`) and the in-order convention hold across every render. The fixed four — `tools`, `prompts`, `resources`, `instructions` — match the MCP protocol's mental model and render in that order in catalog payloads; `readDynamicResource` is a parameterized lookup that renders alongside `resources` as a dispatcher for templated URIs.

### Normative pin

A new consumer shell that wants to bundle the four kinds for one consumer **constructs against `AbstractSurface`**; the protocol-specific shape is produced by `renderXxx(surface)`. Bypassing the abstract layer — composing `vault.tools` + custom prompt loading + custom resource serving in each new shell — fights the substrate the matrix at [[wiki/matrices/consumer-surface]] establishes. The substrate constraint is: if a consumer aggregates the four kinds, it does so through `AbstractSurface` and a protocol renderer, not through a per-protocol bespoke aggregator.

See [[wiki/matrices/consumer-surface]] for which entrypoint each consumer reaches `AbstractSurface` (and the relevant renderer) through.

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
- **Distribution**: `bun publish` to npm as `@dome/sdk` (placeholder name). Single package with **four entrypoints**:
  - `@dome/sdk` — **core**. Vault, Document, the eight Tools, Hook (registry + dispatcher + context), reconcile, watcher, privileged-writer seam (`vault.rebuildIndex`), types, the `INVARIANTS` const, and the protocol-agnostic **`AbstractSurface`** + `buildAbstractSurface(vault)` + `buildInstructions(vault)` + `PromptDescriptor` + `ResourceDescriptor`. (`buildInstructions(vault): Promise<string>` is the cold-start instructions composer the AbstractSurface threads through to its `instructions` field; it is also exported directly for consumers that need the composed string without the full surface — see [[wiki/specs/prompts-and-workflows]] §"Prompt loading lifecycle" and [[wiki/invariants/WORKFLOWS_KNOW_VAULT_CONTEXT]].) No LLM, no MCP, no Commander. Bundled deps: `isomorphic-git`, `chokidar`, `zod`, `gray-matter`, `p-queue`, `yaml`, `zod-to-json-schema`.
  - `@dome/sdk/workflows` — **LLM-driven surface**. `runWorkflow`, `WorkflowRegistry`, `PromptLoader`, `projectAiSdk(vault)`, the eval suite primitives. Bundled deps: `@ai-sdk/anthropic`, `ai`. A consumer importing nothing from this entrypoint pays for none of those deps.
  - `@dome/sdk/mcp` — **MCP server surface**. `DomeMcpServer`, `renderMcp(surface)`, `McpSurface` type, `ToolAdapter` / `McpPromptAdapter` / `ResourceAdapter` types, and the MCP-shaped request handlers. Bundled deps: `@modelcontextprotocol/sdk`. Consumes `AbstractSurface` from core.
  - `@dome/sdk/cli` — **CLI shell**. `runCli`, the nine `dome*` command functions (`domeInit`, `domeMigrate`, `domeServe`, `domeReconcile`, `domeLint`, `domeStats`, `domeDoctor`, `domeRunHook`, `domeExportContext`), `CliError`, `renderCliError`, `DoctorFlag`. The `bin/dome` script and any consumer that wants to embed the CLI in its own process imports from here. Bundled deps: `commander`. The CLI internally imports from `@dome/sdk/workflows` for the LLM-driven commands (`lint`, `migrate`, `export-context`) and from `@dome/sdk/mcp` for `dome serve`.

  The split is wired via `package.json` `exports`. The boundary is structurally enforced by [[wiki/invariants/CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY]] + the regression test at `tests/integration/bundle-deps.test.ts`. See [[wiki/matrices/consumer-surface]] for which entrypoint each consumer shell uses.

- **MCP server**: invoked via `dome serve` (CLI) or by importing `DomeMcpServer` from `@dome/sdk/mcp` directly. See [[wiki/specs/mcp-surface]].

### Dependencies (v0.5 baseline)

Dependencies are scoped to the entrypoint that imports them. A consumer that imports only from `@dome/sdk` core bundles only the **core** row's deps; importing from `@dome/sdk/workflows` adds the **workflows** row's deps; etc. [[wiki/invariants/CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY]] is the structural enforcement that the core column does not transitively pull the workflows or mcp deps.

| Library | Purpose | Why this one | Entrypoint scope |
|---|---|---|---|
| `isomorphic-git` | Git operations (reconciliation, init, status, diff) | Pure JS — no native git binary required; per [[wiki/invariants/VAULT_IS_GIT_REPO]] every vault is a git repo, and isomorphic-git lets us read/write `.git/` from Bun directly. See [[wiki/entities/isomorphic-git]]. | core |
| `chokidar` | Cross-platform filesystem watcher | Mature, Bun-compatible | core |
| `zod` | Runtime input validation | Single source for both AI-SDK `Tool<>` schemas and MCP-adapter input validation | core |
| `gray-matter` | YAML frontmatter parser | Standard for markdown frontmatter | core |
| `p-queue` | Async hook dispatch queue | In-process; durable state is the lockfile pattern, not the queue | core |
| `yaml` | YAML emit/parse for config and hook declarations | Standard; Bun-compatible | core |
| `zod-to-json-schema` | Renders Zod schemas to JSON Schema for the MCP tools/list response | Stable, single-purpose | core |
| `@ai-sdk/anthropic` | LLM client | Anthropic's official TS SDK | workflows |
| `ai` (Vercel AI SDK) | Generic agentic step loop (`generateText`, `Tool<>`) | First-class typed Tool support; agent loop owns the step counter | workflows |
| `@modelcontextprotocol/sdk` | MCP server protocol | First-class TS MCP support | mcp |
| `commander` | CLI argument parser | Mature, Bun-compatible, typed options | cli |

Bun built-ins used directly (no extra dependency): `Bun.write` (atomic file writes), `Bun.file` (file reads + existence checks), `Bun.hash` (xxhash, used for non-canonical caching where git history isn't appropriate), the built-in test runner, `Bun.spawn` (for tool subprocess work).

**Note on `remark` / `unified`:** previously listed; not actually imported anywhere. Wikilink parsing in `src/wikilinks.ts` uses regex; frontmatter parsing uses `gray-matter`. The dependency is dropped from `package.json` as part of Phase B.

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

**Invariants are enforced two ways, by scope.** A second brain that silently writes wrong claims corrupts the user's thinking. Per [[VISION]] §"Principles" #3, invariants are enforced two ways, by scope. *Internally* — within Dome's own dispatcher / hook / workflow chain — every mutation flows through a Tool, and the Tool enforces invariants at the moment of the call. Hooks observe events and call Tools; hooks cannot mutate directly (axiom: [[wiki/invariants/HOOKS_CANNOT_BYPASS_TOOLS]]). *Externally* — across the consumer-shell boundary — invariants are reconciled rather than gated. Consumer shells (Claude Code's native `Write`, vim, Obsidian, future mobile/desktop apps) write to the vault filesystem directly; the watcher catches those writes, `dome reconcile` catches up any events the daemon missed, and hooks reconcile to the same end state (axiom: [[wiki/invariants/VAULT_RECONCILES_AFTER_NATIVE_WRITE]]). The internal path is gateway-shaped; the external path is compiler-shaped. Both converge on a vault that's structurally consistent.

**Prompts are the contract.** Dome's behavior is encoded in *prompts* (markdown files), not in TypeScript code. Tools are mechanical (small, content-agnostic operations); the LLM, instructed by prompts, decides what to do with content. Behavior changes happen by editing prompts in `prompts/` (SDK default) or `<vault>/.dome/prompts/` (vault override), not by writing or modifying Tools. This is what makes Dome both *understandable* (prompts are user-readable) and *tunable* (prompts evolve at the speed of language, not at the speed of releases). The original LLM Wiki gist (line 50 of `raw/original-architecture.md`) names this: "the core product is the workflow encoded in prompts."

The three principles compose: small core (four concepts) + two-ways-by-scope invariant enforcement (Tool-mediated internally; watcher + reconcile externally) + behavior as readable prose (prompts as contract). Together they make Dome legible to a new contributor in an afternoon and stable as a substrate over years.

## Related

- [[wiki/specs/vault-layout]] — directory structure and category derivation.
- [[wiki/specs/page-schema]] — frontmatter contract.
- [[wiki/specs/hooks]] — hook registration forms, event projection, execution model, shipped defaults.
- [[wiki/specs/prompts-and-workflows]] — how prompts double as workflows via frontmatter.
- [[wiki/specs/harnesses]] — the compiler-boundary contract harnesses consume (AGENTS.md + CLI + daemon + reconcile; optional MCP).
- [[wiki/specs/mcp-surface]] — MCP tool catalog.
- [[wiki/specs/cli]] — CLI command surface.
- [[wiki/matrices/tool-invariant-enforcement]] — Tool × invariant matrix.
- [[wiki/concepts/brain-companion]] — product framing.
- [[wiki/concepts/llm-wiki-pattern]] — historical inspiration.
