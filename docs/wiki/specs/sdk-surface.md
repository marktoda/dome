---
type: spec
created: 2026-05-27
updated: 2026-05-29
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]", "[[v1]]"]
---

# SDK surface

This spec is normative for the Dome SDK's target public API. The SDK is a TypeScript package implemented for Bun (`bun` runtime) whose stable conceptual surface is **four core types** — Vault, Proposal, Processor, Effect — plus the registration mechanism for extension bundles. Everything beyond these is a pattern built on top.

Implementation status: the current package root (`src/index.ts`) exports core
types, effect constructors, processor authoring helpers, adopted-ref read
helpers, the bundle loader, and pure commit-trailer helpers. The runtime
`Vault` / `openVault` object described below is the intended public SDK
wrapper, not a shipped export yet. The shipped v1 operational surface is the
Commander CLI over the internal `openVaultRuntime` boundary.

## The four concepts

### Vault (target public wrapper)

A Vault is a directory plus the engine that maintains it. One `Vault` instance per process per vault path. Constructed by `openVault(path: string): Promise<Result<Vault, ToolError>>` — the factory returns a `Result` so failure modes (non-git directory; missing `.dome/`; corrupted config) surface as typed errors at the boundary rather than throwing.

A Vault, once unwrapped:

- Knows its `path` (absolute directory).
- Loads `.dome/page-types.yaml` and `.dome/config.yaml`.
- Loads extension bundles from one configured bundles root and registers their processors. CLI commands default that root to the SDK-shipped `assets/extensions/`; tests and vault-local installs can override it with `--bundles-root`.
- Holds the engine, processor runtime, projection store, run ledger, and outbox.
- Exposes read/Recall APIs plus engine-control operations such as `sync`, `rebuild`, and adoption status.

A Vault is opened, used, and closed in one process lifetime. Drain semantics
for queued/running garden and view work are staged below; the current runtime
close path releases SQLite handles but does not yet expose a full
`drainProcessors()` API.

#### Vault surface

```ts
interface Vault {
  readonly path: string;
  readonly config: VaultConfig;
  readonly pageTypes: PageTypesConfig;
  readonly bundles: readonly ExtensionBundle[];

  // Recall — read-only queries
  query(input: QueryInput): Promise<QueryResult>;
  readDocument(path: string): Promise<Result<Document, ToolError>>;
  resolveWikilink(link: string): Promise<Document | null>;

  // Engine control
  sync(opts?: SyncOpts): Promise<Result<SyncResult, ToolError>>;
  rebuild(): Promise<Result<RebuildResult, ToolError>>;
  getAdoptionStatus(): Promise<AdoptionStatus>;

  // Lifecycle
  drainProcessors(): Promise<void>; // planned v1.x drain surface
  close(): Promise<void>;
}
```

The public surface is **read or engine control** — there is no `vault.tools.writeDocument(...)`, `vault.write(...)`, or public `vault.submitProposal(...)`. To change vault state in v1.0, external callers write markdown and create normal git commits. The compiler host (`dome serve`) or one-shot catch-up command (`dome sync`) compares `refs/dome/adopted/<branch>` to `refs/heads/<branch>`, constructs the Proposal internally, and runs the adoption loop.

Garden processors that emit PatchEffects also do not call a public write method. The engine converts the patch into an internal garden-source Proposal and routes it through the same adoption loop. This is the structural enforcement of [[wiki/invariants/PROPOSALS_ARE_THE_ONLY_WRITE_PATH]].

#### Vault lifecycle

```text
openVault(path) → Result<Vault, ToolError>   (unwrap to Vault)
   │
   │   in-process use:
   │     vault.query(...)             — read path
   │     vault.sync(...)              — engine adoption loop
   │
   ├─→ drainProcessors()              (planned; idempotent; settles async garden/view work)
   │
   └─→ close()                         (current: releases resources; future: drains first)
```

`drainProcessors()` is the planned v1.x drain surface. When implemented, it is idempotent — re-callable any number of times — and awaits the engine's garden/view processor work plus any in-flight outbox dispatch attempts.

`close()` currently releases the SQLite handles for the projection store,
answers store, run ledger, and outbox. The future drain-integrated close path
calls `drainProcessors()` first, then releases handles, then sets a `closed`
flag so subsequent `query` / `sync` / `rebuild` calls return
`Result.err({ kind: "vault-closed" })`.

#### Composable construction

`openVault(path)` is the canonical entry point. For v1+ consumer surfaces (desktop, voice, HTTP) that want a custom subset of the built-in Vault behavior — say a mobile-app shell that ships its own processor set, or a test fixture with only a few `dome.*` bundles mounted — three named helpers compose openVault:

```ts
// internal helpers exposed for advanced consumers
function loadVaultConfig(root: string): Promise<{ config: VaultConfig; pageTypes: PageTypesConfig; bundles: ExtensionBundle[] }>;
function buildEngine(opts: EngineOpts): Engine;
function bindVault(opts: BindOpts): Vault;
```

The pattern lets a future Dome-native shell construct a `Vault` with a custom processor set, a different storage location, or a synthetic config — without forking `openVault`.

### Proposal

A Proposal is a commit range proposed for adoption. The only write path. See [[wiki/specs/proposals]] for the full spec.

### Processor

A Processor is code that reads a vault snapshot and returns effects. The only behavior unit. See [[wiki/specs/processors]] for the full spec.

### Effect

An Effect is what a processor returns. Eleven kinds; closed taxonomy. See [[wiki/specs/effects]] for the full spec.

## Submission API

There is no public submission API in v1.0. The Proposal type remains one of the four core concepts, but Proposal construction is engine-internal:

- `dome serve` and `dome sync` synthesize manual-source Proposals from the git range `refs/dome/adopted/<branch>..refs/heads/<branch>`.
- Garden-phase PatchEffects synthesize garden-source Proposals inside the engine.
- Hosted-protected mode (v1.5) will synthesize Proposals from PR webhook payloads.

```ts
interface AdoptionResult {
  readonly proposalId: string;
  readonly adopted: boolean;
  readonly adoptedRef: CommitOid;
  readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
  readonly closureCommitOid: CommitOid | null;
  readonly iterations: number;
}
```

The SDK does not export `SubmitInput`, Proposal constructors, or `submitProposal` from `src/index.ts`. External callers participate by writing/committing markdown and invoking `sync` when they need to block on adoption. See [[wiki/specs/proposals]] §"Submission API".

## Recall API

Read-only queries against adopted state and projections.

```ts
interface QueryInput {
  readonly text?: string;                       // FTS query
  readonly filters?: SearchFilters;
  readonly revision?: CommitOid;                // default: adopted ref
  readonly includeFacts?: boolean;              // attach FactEffects matching the query
  readonly includeDiagnostics?: boolean;
  readonly includeQuestions?: boolean;
  readonly includeSourceSnippets?: boolean;
  readonly requireEvidence?: boolean;           // when true, filter to results carrying SourceRefs
}

interface QueryResult {
  readonly matches: ReadonlyArray<SearchMatch>;
  readonly facts: ReadonlyArray<FactEffect>;
  readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
  readonly questions: ReadonlyArray<QuestionEffect>;
}
```

Queries default to the adopted ref — never HEAD. The "draft state" between adopted and HEAD is intentionally not visible to Recall; the user must `dome sync` to make it visible.

`vault.readDocument(path)` and `vault.resolveWikilink(link)` are convenience reads against the adopted ref. Both return synchronously from the engine's in-memory snapshot index.

## Engine control

Three engine APIs are exposed on the Vault surface:

- `sync(opts?)` — explicitly run the adoption loop against the current `adopted..HEAD` range. See [[wiki/specs/adoption]] §"`dome sync`".
- `rebuild()` — wipe and rebuild `projection.db` from the adopted commit. See [[wiki/specs/projection-store]] §"Rebuild path".
- `getAdoptionStatus()` — read-only snapshot of adoption state (current branch, HEAD, adopted ref, pending commits, dirty status, divergence flag). See [[wiki/specs/adoption]] §"`dome status`".

## Extension bundles

An **extension bundle** is a directory under a configured bundles root: `assets/extensions/<bundle-name>/` for SDK-shipped bundles by default, or `<vault>/.dome/extensions/<bundle-name>/` when a command is explicitly run with `--bundles-root <vault>/.dome/extensions`. The bundle contains a `manifest.yaml` plus contributions across five kinds: page-types, preamble, processors, capabilities, external-handlers.

### Bundle directory shape

```
<vault>/.dome/extensions/<bundle-name>/
  manifest.yaml             # bundle identity + processor declarations + capability requests
  page-types.yaml           # optional — extension page types
  preamble.md               # optional — fragment threaded into AGENTS.md
  processors/               # TypeScript files exporting defineProcessor(...)
    *.ts
  external-handlers/        # optional — TypeScript files registering ExternalActionEffect handlers
    *.ts
```

The five contribution kinds replace v0.5's five (tool / hook / prompt / page-type / CLI command). Tools dissolve into adoption-phase processors emitting PatchEffect; hooks dissolve into adoption-phase or garden-phase processors with signal triggers; workflows dissolve into garden-phase processors with `model.invoke` capability; CLI commands are now command-triggered view-phase processors registered via `processors/` with `triggers: [{ kind: "command", name: "..." }]`. See [[wiki/matrices/built-in-extensions-x-phase]] for the canonical map.

### `manifest.yaml` schema

```yaml
id: dome.intake
version: 1.0.0
description: "Compile raw captures into wiki updates."
deps: []                    # optional; future for cross-bundle dependencies

processors:
  - id: extract-capture
    version: 1.0.0
    phase: garden
    triggers:
      - kind: signal
        name: file.created
        pathPattern: "inbox/raw/**"
    capabilities:
      - kind: read
        paths: ["inbox/raw/**", "wiki/**"]
      - kind: patch.propose
        paths: ["wiki/**"]
      - kind: patch.auto
        paths: ["wiki/generated/intake/**", "inbox/processed/**"]
      - kind: graph.write
        namespaces: ["dome.tasks", "dome.people"]
      - kind: model.invoke
        maxDailyCostUsd: 5.00
    execution:
      class: llm
      timeoutMs: 600000
      modelCallTimeoutMs: 180000
```

The schema is validated by Zod at bundle load. Invalid manifests fail the load with `bundle-load-failed` (see §"Bundle-loader error taxonomy" below). The manifest is the reviewable source of truth for static processor metadata: triggers, capabilities, and execution policy are bound from the manifest onto the loaded processor; the module supplies the `run` function and must agree on id / version / phase.

#### Bundle-loader error taxonomy

| `detail:` discriminator | When it fires |
|---|---|
| `root-not-found` | The configured bundles root does not exist or is not a directory. |
| `manifest-read-failed` | A bundle has neither readable `manifest.yaml` nor `manifest.json`, or the manifest cannot be parsed. |
| `manifest-invalid` | Zod validation fails (missing `id:`, malformed `version:`, etc.) or a phase × trigger / phase × execution / phase × capability matrix check rejects the declaration. |
| `processor-module-path-invalid` | A manifest `module:` path is absolute, escapes the bundle root, bypasses `<bundle>/processors/`, or does not point at a `.ts` file. |
| `processor-module-load-failed` | A `<bundle>/processors/<name>.ts` fails to import, has identity drift against the manifest, or default-exports an object without a `run` function. |
| `processor-missing-default-export` | A processor module imports but does not default-export an object. |
| `registry-build-failed` | The loaded processor set fails registry checks such as duplicate processor ids, duplicate command triggers, empty triggers, or invalid phases. |
| `page-type-collision` | Two bundles declare the same page-type name; the loader fails before opening the runtime. Vault-local collisions with bundle/default page types are surfaced by `dome.markdown.lint-frontmatter` from the candidate snapshot. |
| `capability-handler-collision` | Two bundles register handlers for the same external capability. |
| `bundle-deps-unmet` | A `deps:` entry names a bundle not present in the selected bundles root. |

### Bundle load lifecycle

The current runtime loads bundles from a single root per process. CLI commands use the SDK-shipped first-party root by default (`assets/extensions/`, resolved at runtime via `resolveShippedBundlesRoot()`); `--bundles-root` replaces that root for tests or vault-local third-party installs. Multi-root composition of shipped plus vault-local bundles in one runtime remains v1.x polish. Within the selected root, bundles load alphabetically by directory name. Each bundle:

1. **Manifest parses + validates.** Processor declarations are bound to imported processor objects.
2. **Page-types merge.** Entries in `<bundle>/page-types.yaml` are parsed into the runtime `PageTypeRegistry` and threaded to processors as `ctx.pageTypes`; vault-local `.dome/page-types.yaml` remains candidate-bound and is read through `ctx.snapshot`.
3. **Preamble fragment** loading is planned. Bundle-local `preamble.md` files are part of the intended extension shape, but the current loader does not yet merge them into `AGENTS.md`.
4. **Processors register** into the engine's processor registry under their fully qualified manifest ids.
5. **Capabilities register** with the broker.
6. **External-handler discovery** is planned. The outbox dispatcher supports injected handler registries today; scanning bundle `external-handlers/` directories is a future loader extension.

The bundle loader is **fail-loud**: any bundle-load failure aborts `openVault` with a structured `bundle-load-failed` error. Registry validation failures abort startup with `registry-build-failed`.

### First-party bundles

The SDK ships the current v1 `dome.*` bundles under `assets/extensions/`. Some product-pressure bundles remain planned and are marked in the matrices, not in this shipped list:

| Bundle | Phase × processors | Purpose |
|---|---|---|
| `dome.markdown` | adoption: validate-wikilinks, normalize-frontmatter, lint-frontmatter, broken-images, duplicate-detection, stale-dates; view: orphan-pages | Keeps markdown pages well-formed; emits diagnostics on broken references/frontmatter/date issues, asks about suspected duplicates, and provides the orphan-pages view. |
| `dome.graph` | adoption: links, tag-index | Emits graph facts for wikilinks and tags under the `dome.graph` namespace. |
| `dome.health` | garden: recovery question emitters and answer handlers | Surfaces and recovers failed outbox rows, quarantined processors, and orphaned runs through questions. |
| `dome.daily` | adoption: task-index; garden: create-daily (cron), carry-forward; view: today | Creates daily notes, carries open markdown checkbox tasks forward, indexes source-ref-backed wiki-page task/followup facts, and renders today's action surface. |
| `dome.lint` | view: markdown-format | Minimal lint command surface; fuller report/apply flow remains planned. |
| `dome.search` | adoption: index-text; view: query | Maintains FTS5 adopted-state search; answers `dome query` requests. Embeddings/export-context remain future work. |

The full shipped/planned map is at [[wiki/matrices/built-in-extensions-x-phase]] and [[wiki/matrices/extension-bundle-shape]].

Per the Phase 11f hotfix, `dome init` no longer copies the first-party bundles into the vault — they live with the SDK at `<SDK>/assets/extensions/` and are resolved at runtime via `resolveShippedBundlesRoot()` (the default `--bundles-root` for every CLI command). A vault that wants to override a first-party bundle does so by enabling/disabling activations in `<vault>/.dome/config.yaml`, not by editing copied files.

## Adding a processor

Four file edits, paralleling the v0.5 "Adding a Tool" recipe:

1. **The processor file** at `assets/extensions/<bundle>/processors/<name>.ts` (or `<vault>/.dome/extensions/<bundle>/processors/<name>.ts` for vault-local). Exports `defineProcessor({ id, version, phase, triggers, capabilities, run })`.
2. **The manifest entry** in `assets/extensions/<bundle>/manifest.yaml`'s `processors:` block, declaring id / version / phase / triggers / capabilities.
3. **The shipped default grants** in `src/cli/commands/init.ts`'s `DEFAULT_CONFIG_YAML` block (if a first-party processor needs capabilities not on the shipped-default grant set). Vault-local bundles grant capabilities in `<vault>/.dome/config.yaml`.
4. **The test** at `tests/processors/<bundle-id>-<processor-id>.test.ts` asserting the processor runs against a representative input and emits the expected effects.

The substrate scaffold catches the missing pieces:
- `tests/integration/processor-registration.test.ts` iterates the manifest entries and asserts each bound to an importable processor.
- `tests/integration/processor-purity.test.ts` typechecks that no processor's `run` body reaches a mutation surface.
- `tests/integration/capability-enforcement.test.ts` exercises capability check per effect × capability pair.

## Adding a new invariant

Three file edits, paralleling the v0.5 recipe:

1. **Add a `NAME: "NAME"` entry** to `src/types.ts` `INVARIANTS`.
2. **Create the doc** at `docs/wiki/invariants/<NAME>.md` from the invariant template.
3. **Create the test** at `tests/invariants/<slug>.test.ts`.

The AC3 lockstep test at `tests/integration/invariant-coverage.test.ts` iterates `Object.entries(INVARIANTS)` and asserts each named invariant has a corresponding test file.

For an **off-matrix invariant** (one not enforced at a processor's capability boundary — e.g., `ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY` enforced at the bundling layer, `EVERY_EFFECT_IS_CAPABILITY_CHECKED` enforced at the engine boundary), the lockstep test file imports from the canonical enforcement test — see §"Off-matrix lockstep convention" in [[wiki/invariants/EVERY_EFFECT_IS_CAPABILITY_CHECKED]] for the delegating-stub shape.

## Registration matrix

Five kinds; one registration path (extension bundle):

| Kind | Where defaults live | Where vault-local overrides live |
|---|---|---|
| Processor | `assets/extensions/dome.*/processors/` | `<vault>/.dome/extensions/<bundle>/processors/*.ts` |
| Page type | `assets/extensions/dome.*/page-types.yaml` and SDK shipped-defaults | `<vault>/.dome/page-types.yaml` extensions block |
| Preamble fragment | `assets/extensions/dome.*/preamble.md` | `<vault>/.dome/extensions/<bundle>/preamble.md` |
| External handler | `assets/extensions/dome.*/external-handlers/` | `<vault>/.dome/extensions/<bundle>/external-handlers/*.ts` |
| Capability grant | `src/cli/commands/init.ts` `DEFAULT_CONFIG_YAML` shipped-defaults | `<vault>/.dome/config.yaml` |

There is no "Tool," "Hook," "Workflow," or "CLI command" as separate registration kinds. CLI commands are processors with `triggers: [{ kind: "command", name: "..." }]` — the bundle's `processors/` directory is the single registration surface.

## Tiered feature model

The SDK ships features across three tiers:

| Tier | Description | Examples |
|---|---|---|
| **Axioms** | Cannot be disabled. Disabling them changes what Dome is. | The axiom-tier invariants. The four core types. The fixed-point adoption loop. The capability broker. The projection store + run ledger + outbox. |
| **Shipped defaults** | Enabled by default; can opt out in `.dome/config.yaml`. | First-party `dome.*` bundles, the shipped-default-tier invariants per [[wiki/invariants/]], the four default page types. |
| **Opt-in** | Shipped, not active by default. Activated by config or by installing an additional bundle. | Voice-intake (`inbox/voice/` bucket + ingest workflow inside `dome.intake`), research-intake, third-party bundles. |

`dome init <path>` produces a minimal general-purpose vault — the axioms plus shipped defaults. Activation of opt-in features is `extensions.<name>.enabled: true` in `<vault>/.dome/config.yaml`.

The shipped default config currently lives in the `dome init` scaffold and must stay reconciled with the shipped bundle assets and matrices. A future cleanup should extract this to a typed `shipped-defaults` module once migrations need a shared source of truth.

## Consumer surfaces

Every consumer shell that builds against Dome should aggregate four kinds of
things from the SDK. The CLI is the shipped v1 surface today; `AbstractSurface`,
MCP, HTTP, mobile, desktop, and voice adapters are target shapes for the
multi-surface roadmap and are not v1 acceptance gates.

- **Recall access** — the `query` + `readDocument` + `resolveWikilink` APIs for read paths.
- **Processors** — the catalog of view-phase processors that respond to commands (`dome lint`, `dome query`, etc.).
- **Instructions** — cold-start orientation: invariants enabled in this vault, page types declared, the `AGENTS.md` user-tendable preamble; a single string.
- **Engine status/control where appropriate** — CLI-only operations such as `sync`, `rebuild`, `serve`, and `status` that are not generic protocol tools in v1.

The intended aggregation splits across two layers — **`AbstractSurface`**
(protocol-agnostic) and **per-protocol renderers** (one per consumer protocol;
living in their respective entrypoints). This is the structural shape that
will make multi-surface work cheap: a new protocol adapter ships as one render
function, not as a parallel aggregation. The current v1 implementation routes
CLI commands directly through the runtime while this abstraction is still
planned.

### `AbstractSurface` (planned)

```ts
interface AbstractSurface {
  readonly query: (input: QueryInput) => Promise<QueryResult>;
  readonly read: (path: string) => Promise<Result<Document, ToolError>>;
  readonly commands: ReadonlyArray<CommandDescriptor>;  // view-phase command processors
  readonly instructions: string;
  readonly readResource: (uri: string) => Promise<string | null>;
}

function buildAbstractSurface(vault: Vault): Promise<AbstractSurface>;
```

`commands` is a list of `CommandDescriptor` records — each carries a name (`"lint"`, `"stats"`, `"query"`), an optional description, a Zod-validated input schema, and a callback that invokes the corresponding view-phase processor.

`readResource(uri)` exposes individual vault contents (pages, log, index, the projection-store search) under URI schemes like `dome://page/<path>`, `dome://log`, `dome://index`, `dome://search?q=...`. Protocol renderers (MCP, future HTTP) map their resource conventions onto this.

### Per-protocol renderers

Each future consumer protocol adapts `AbstractSurface` to its wire format:

| Adapter | Entry point | Wire format |
|---|---|---|
| MCP (planned) | `renderMcp(surface): McpSurface` in planned `@dome/sdk/mcp` | MCP protocol — read/query tools, resources, prompts |
| CLI (shipped, direct runtime today) | `runCli(argv)` in `@dome/sdk/cli` | argv → engine control or command processor invocation |
| HTTP (v2) | `renderHttp(surface): HttpHandler` in `@dome/sdk/http` | REST routes over Recall + future native-surface write controls |
| Voice (v2) | `renderVoice(surface): VoiceHandler` in `@dome/sdk/voice` | Speech-to-text → command processor |

The protocol renderers should consume `AbstractSurface`, never `Vault`
directly. This is the intended structure behind
[[wiki/invariants/ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY]]: `@dome/sdk` core
stays free of MCP / LLM transitive dependencies, while planned
protocol/provider packages lift the core surface into their own wire formats.

## Outputs the SDK does not have

To keep the core small, the SDK explicitly does not ship:

- **A direct-mutation API.** No `vault.tools.writeDocument(...)`, no `vault.write(path, content)`, no public `vault.submitProposal(...)`. External writes are normal git commits adopted by `dome serve` / `dome sync`; garden writes are internal Proposals. Pinned by [[wiki/invariants/PROPOSALS_ARE_THE_ONLY_WRITE_PATH]].
- **A Hook concept.** Behavior that observes events is a processor with a `signal:` trigger.
- **A Workflow concept.** Prompts + tool-binding loops are garden-phase processors with `model.invoke` capability.
- **A Tool concept.** Mutation primitives are PatchEffects emitted by processors.
- **An events queue.** Effects are routed by the engine; there is no `fireEvent` or subscribe API.
- **A privileged-writer escape hatch.** The engine is the only applier; no code outside `src/engine/` reaches mutation primitives.

## Dependency list

`@dome/sdk` core depends on:

```
bun (runtime; ships sqlite, glob, file, watcher built-in)
isomorphic-git (the git boundary)
gray-matter (frontmatter parsing)
yaml (config + manifest loading)
zod (schema validation)
```

Planned provider adapters add:
```
ai (Vercel AI SDK; for model.invoke in garden-LLM processors)
@ai-sdk/anthropic
```

The planned MCP adapter adds:
```
@modelcontextprotocol/sdk
```

The `@dome/sdk` core has no transitive dependency on `ai`, `@ai-sdk/anthropic`, or `@modelcontextprotocol/sdk`. Pinned by [[wiki/invariants/ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY]] and enforced by `tests/integration/bundle-deps.test.ts`.

## Related

- [[wiki/specs/proposals]] — the write path
- [[wiki/specs/processors]] — the behavior unit
- [[wiki/specs/effects]] — the closed taxonomy
- [[wiki/specs/adoption]] — the fixed-point loop
- [[wiki/specs/projection-store]] — derived state
- [[wiki/specs/capabilities]] — effect gating
- [[wiki/specs/run-ledger]] — audit history
- [[wiki/specs/harnesses]] — agentic harness contract
- [[wiki/specs/cli]] — the shipped CLI commands
- [[wiki/specs/mcp-surface]] — the MCP protocol adapter
- [[wiki/specs/vault-layout]] — directory structure
- [[wiki/matrices/protocol-adapter]] — per-protocol adapter map
- [[wiki/matrices/built-in-extensions-x-phase]] — first-party bundle map
