---
type: spec
created: 2026-05-27
updated: 2026-06-01
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
  - "[[v1]]"
---

# SDK surface

This spec is normative for the Dome SDK's target public API. The SDK is a TypeScript package implemented for Bun (`bun` runtime) whose stable conceptual surface is **four core types** — Vault, Proposal, Processor, Effect — plus the registration mechanism for extension bundles. Everything beyond these is a pattern built on top.

Implementation status: the current package root (`src/index.ts`) exports core
types, effect constructors, processor authoring helpers, adopted-ref read
helpers, the bundle loader, first-party maintenance-loop metadata, and pure
commit-trailer helpers. The runtime `Vault` / `openVault` object described
below is the intended public SDK wrapper, not a shipped export yet. The
shipped v1 operational surface is the Commander CLI over the internal
`openVaultRuntime` boundary.

## The four concepts

### Vault (target public wrapper)

A Vault is a directory plus the engine that maintains it. One `Vault` instance per process per vault path. Constructed by `openVault(path: string): Promise<Result<Vault, ToolError>>` — the factory returns a `Result` so failure modes (non-git directory; missing `.dome/`; corrupted config) surface as typed errors at the boundary rather than throwing.

A Vault, once unwrapped:

- Knows its `path` (absolute directory).
- Loads `.dome/page-types.yaml` and `.dome/config.yaml`.
- Loads extension bundles from configured bundle roots and registers their processors. CLI commands default to the SDK-shipped `assets/extensions/` root plus an existing vault-local `.dome/extensions/` root; tests and ad-hoc development can still replace the root set with `--bundles-root`.
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
   ├─→ drainProcessors()              (planned public API; internal close drain shipped)
   │
   └─→ close()                         (drains processor runtime, then releases resources)
```

`drainProcessors()` is the planned v1.x public drain surface. The internal
processor-runtime close path already stops new runner invocations, cancels
in-flight garden/view dispatch, waits for active runner promises to settle, and
then lets `VaultRuntime.close()` release operational handles. The future public
method will expose that operation before full close and extend it to in-flight
outbox dispatch attempts.

`close()` drains the processor runtime first, then releases the SQLite handles
for the projection store, answers store, run ledger, and outbox. The remaining
public-surface hardening is a closed-state guard so subsequent `query` / `sync`
/ `rebuild` calls return `Result.err({ kind: "vault-closed" })`.

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

An **extension bundle** is a directory under a configured bundles root: `assets/extensions/<bundle-name>/` for SDK-shipped bundles, or `<vault>/.dome/extensions/<bundle-name>/` for vault-local bundles. Normal CLI/runtime use composes both roots when the vault-local root exists; `--bundles-root <path>` is an exact override for tests and ad-hoc development. The bundle contains a `manifest.yaml` plus contributions across five kinds: page-types, preamble, processors, capabilities, external-handlers.

### Bundle directory shape

```
<vault>/.dome/extensions/<bundle-name>/
  manifest.yaml             # bundle identity + processor declarations + capability requests
  page-types.yaml           # optional — extension page types
  preamble.md               # optional — fragment threaded into AGENTS.md
  processors/               # TypeScript files exporting defineProcessorImplementation(...)
    *.ts
  external-handlers/        # optional — TypeScript files registering ExternalActionEffect handlers
    *.ts
```

The five contribution kinds replace v0.5's five (tool / hook / prompt / page-type / CLI command). Tools dissolve into adoption-phase processors emitting PatchEffect; hooks dissolve into adoption-phase or garden-phase processors with signal triggers; workflows dissolve into garden-phase processors with `model.invoke` capability; CLI commands are now command-triggered view-phase processors registered via `processors/` with `triggers: [{ kind: "command", name: "..." }]`. See [[wiki/matrices/built-in-extensions-x-phase]] for the canonical map.

### `manifest.yaml` schema

```yaml
id: dome.agent
version: 1.0.0
description: "Autonomous-agent processors for vault-wide ingest and maintenance."

processors:
  - id: dome.agent.ingest
    version: 1.0.0
    phase: garden
    triggers:
      - kind: signal
        name: file.created
        pathPattern: "inbox/raw/*.md"
    capabilities:
      - kind: read
        paths:
          - "wiki/**/*.md"
          - "notes/**/*.md"
          - "inbox/**/*.md"
          - "index.md"
          - "log.md"
      - kind: patch.auto
        paths:
          - "wiki/**/*.md"
          - "notes/**/*.md"
          - "index.md"
          - "log.md"
          - "inbox/processed/*.md"
          - "inbox/raw/*.md"
      - kind: model.invoke
        maxDailyCostUsd: 5
      - kind: question.ask
    execution:
      class: llm
      timeoutMs: 600000
      modelCallTimeoutMs: 180000
    module: processors/ingest.ts

  - id: dome.agent.inbox-stale-check
    version: 0.1.0
    phase: garden
    triggers:
      - kind: schedule
        cron: "0 * * * *"
      - kind: signal
        name: file.created
        pathPattern: "inbox/**/*.md"
      - kind: signal
        name: document.changed
        pathPattern: "inbox/**/*.md"
      - kind: signal
        name: file.deleted
        pathPattern: "inbox/**/*.md"
    capabilities:
      - kind: read
        paths: ["inbox/**/*.md"]
    module: processors/inbox-stale-check.ts
```

The schema is validated by Zod at bundle load. Invalid manifests fail the load with `bundle-load-failed` (see §"Bundle-loader error taxonomy" below). The manifest is the reviewable source of truth for static processor metadata: id, version, phase, triggers, capabilities, execution policy, and inspection scope are bound from the manifest onto the loaded processor. New modules supply only the `run` implementation via `defineProcessorImplementation({ run })`; implementation exports with stray manifest-owned metadata fail the load. Legacy modules that export full `Processor` objects are still accepted for migration compatibility, but manifest values win for triggers, capabilities, execution, and inspection, and the legacy id/version/phase must agree with the manifest.

`inspection` is optional and defaults to `{ kind: "changed-paths" }`. It tells
projection cleanup which source set the processor really inspected when
resolving stale diagnostics, questions, and page facts. Use
`{ kind: "all-readable-markdown" }` only for processors that actually walk
every readable markdown file during the run.

#### Bundle-loader error taxonomy

| `detail:` discriminator | When it fires |
|---|---|
| `root-not-found` | The configured bundles root does not exist or is not a directory. |
| `bundle-not-found` | `extensions.<bundle>.enabled: true` or an exact-root activation filter names a bundle that is absent from the selected root set. In normal CLI/runtime composition, SDK-shipped and vault-local roots are considered together before this fires. |
| `manifest-read-failed` | A bundle has neither readable `manifest.yaml` nor `manifest.json`, or the manifest cannot be parsed. |
| `manifest-invalid` | Zod validation fails (missing `id:`, malformed `version:`, etc.) or a phase × trigger / phase × execution / phase × capability matrix check rejects the declaration. |
| `processor-module-path-invalid` | A manifest `module:` path is absolute, escapes the bundle root, bypasses `<bundle>/processors/`, or does not point at a `.ts` file. |
| `processor-module-load-failed` | A `<bundle>/processors/<name>.ts` fails to import, default-exports an object without a `run` function, carries partial manifest-owned metadata, or has legacy identity drift against the manifest. |
| `processor-missing-default-export` | A processor module imports but does not default-export an object. |
| `registry-build-failed` | The loaded processor set fails registry checks such as duplicate processor ids, duplicate command triggers, empty triggers, or invalid phases. |
| `page-type-collision` | Two bundles declare the same page-type name; the loader fails before opening the runtime. Vault-local collisions with bundle/default page types are surfaced by `dome.markdown.lint-frontmatter` from the candidate snapshot. |
| `external-handler-read-failed` | A bundle's `external-handlers/` directory exists but cannot be read. A missing directory is valid and means the bundle contributes no handlers. |
| `external-handler-module-load-failed` | A handler module under `external-handlers/*.ts` fails to import. |
| `external-handler-missing-default-export` | A handler module imports but does not default-export a function. |
| `external-handler-collision` | Two loaded bundles register handlers for the same external capability. |

### Bundle load lifecycle

The current runtime composes bundle roots in deterministic order. CLI commands use the SDK-shipped first-party root by default (`assets/extensions/`, resolved at runtime via `resolveShippedBundlesRoot()`) and append `<vault>/.dome/extensions/` when that directory exists. Later roots override earlier roots by bundle id, so a vault-local bundle can intentionally replace a shipped bundle without a second extension mechanism. `--bundles-root <path>` replaces the composed default with one exact root for tests or ad-hoc development. With `.dome/config.yaml` present, every `extensions.<bundle>.enabled: true` id must resolve in the selected root set; typos fail startup with `bundle-not-found` instead of silently degrading automation. The composed bundle set is sorted by bundle id before registry construction. Each bundle:

1. **Manifest parses + validates.** Processor declarations are bound to imported processor objects.
2. **Page-types merge.** Entries in `<bundle>/page-types.yaml` are parsed into the runtime `PageTypeRegistry` and threaded to processors as `ctx.pageTypes`; vault-local `.dome/page-types.yaml` remains candidate-bound and is read through `ctx.snapshot`. When the vault-local file changes, adoption invalidates the full projection store because schema diagnostics may change for pages outside the commit's changed-path set.
3. **Preamble fragment** loading is planned. Bundle-local `preamble.md` files are part of the intended extension shape, but the current loader does not yet merge them into `AGENTS.md`.
4. **Processors register** into the engine's processor registry under their fully qualified manifest ids.
5. **Capabilities register** with the broker.
6. **External handlers register** by scanning immediate `<bundle>/external-handlers/*.ts` files. The filename stem is the external capability (`calendar.write.ts` registers `calendar.write`), and the module must default-export an async-compatible handler function. Loaded-bundle handler collisions fail before runtime open. Runtime-injected handlers remain available for tests and hosts and override discovered handlers for the same capability.

The bundle loader is **fail-loud**: any bundle-load failure aborts `openVault` with a structured `bundle-load-failed` error. Registry validation failures abort startup with `registry-build-failed`.

V1 does not support cross-bundle dependency declarations in `manifest.yaml`.
If a behavior depends on another bundle, model that as first-party loop
metadata, optional processors, or explicit documentation. Future dependency
support must preserve the same fail-loud activation behavior.

### First-party bundles

The SDK ships the current v1 `dome.*` bundles under `assets/extensions/`. Some product-pressure bundles remain planned and are marked in the matrices, not in this shipped list:

| Bundle | Phase × processors | Purpose |
|---|---|---|
| `dome.markdown` | adoption: validate-wikilinks, normalize-frontmatter, lint-frontmatter, broken-images, duplicate-detection, stale-dates, raw-immutable; garden: ambiguous-wikilink-answer, repair-wikilinks, simplify-indexes, duplicate-detection-answer, refresh-updated; view: orphan-pages | Keeps markdown pages well-formed; normalizes frontmatter, refreshes managed `updated:` dates during adoption, schedules source-preserving refreshes for stale adopted-state `updated:` drift, repairs high-confidence typoed wikilinks to existing pages during adoption and scheduled historical maintenance, treats pathful aliases with a unique basename match as resolved, canonicalizes those alias targets during scheduled repair, creates source-backed stubs for explicit missing `wiki/concepts/...` and `wiki/entities/...` links only when no plausible existing page candidate exists, emits warning diagnostics on ambiguous broken curated-page references/frontmatter, asks agent-safe questions when a broken managed wikilink has multiple plausible existing repair targets, applies answered ambiguous-link repairs through normal garden patches, emits informational diagnostics for broken note-draft links, imported-source body links, optional-root unknown page types, and remaining adopted-date drift, treats wikilink validation as a full-readable-markdown inspection so new target pages can resolve stale broken-link diagnostics in unchanged source notes, blocks raw-file mutations, asks about high-confidence duplicate canonical content pages, records answered merge decisions as source-preserving duplicate review syntheses, maintains small generated child-page blocks in existing wiki index pages, and provides the orphan-pages view. |
| `dome.graph` | adoption: links, tag-index | Emits graph facts for wikilinks and tags under the `dome.graph` namespace. |
| `dome.health` | garden: recovery question emitters and answer handlers | Surfaces and recovers failed outbox rows, quarantined processors, and orphaned runs through metadata-annotated questions. |
| `dome.daily` | adoption: task-index; garden: create-daily (cron), carry-forward; view: today, prep | Creates daily notes in the V1 work-surface shape, seeds and refreshes a source-backed `## Start Here` context block from yesterday's daily note, seeds and refreshes a filtered source-backed open-loop surface in today's daily note, targets scheduled/current daily surfaces rather than changed historical daily notes, ranks daily-note source loops by the configured daily date instead of the file's maintenance commit timestamp, folds repeated and near-duplicate open-loop rows in rendered daily surfaces while retaining representative source refs, renders compact evidence labels that show both daily surface rows and backing source locations, preserves settled generated rows as resolved (`[x]`) or dismissed (`[-]`) daily evidence so source-backed loops stop resurfacing without hidden state, indexes user-authored task/followup facts while ignoring Dome-generated daily blocks, frontmatter metadata, and blockquoted evidence, gives extracted open loops stable SourceRef identities across line moves, marks ambiguous follow-up questions as agent-safe, and renders daily action/planning surfaces. The daily path defaults to `wiki/dailies/{date}.md` and can be configured per vault with `extensions.dome.daily.config.daily_path`. |
| `dome.lint` | view: report | Adopted-state lint report over diagnostics and deterministic checks; future apply flow remains planned. |
| `dome.agent` | garden: ingest, inbox-stale-check | Runs autonomous-agent processors via a tool-use loop backed by `ctx.modelInvoke.step`; `dome.agent.ingest` handles `inbox/raw/*.md` — integrates raw captures into wiki (source page + entity/concept pages + bidirectional wikilinks + index/log updates + task routing + archive), all as one `PatchEffect` within the capability grant boundary; `dome.agent.inbox-stale-check` emits `inbox.stale` warnings for captures lingering past 168 hours. See [[wiki/specs/autonomous-agents]]. |
| `dome.search` | adoption: index-text; view: query, export-context | Maintains FTS5 adopted-state search; answers `dome query` and source-backed `dome export-context` requests with read-first packet overviews that surface topic-relevant open loops, decisions, questions, diagnostics, source refs, and projection recall signals for topic-matched memory that FTS alone would miss. Daily-intent packets also recall date-named daily surfaces from the adopted snapshot and parse their current hand-authored and generated source-backed open-loop rows into the packet overview, keeping daily surface refs and generated-row backing refs intact. Embeddings remain future work. |

The full shipped/planned map is at [[wiki/matrices/built-in-extensions-x-phase]] and [[wiki/matrices/extension-bundle-shape]].

Per the Phase 11f hotfix, `dome init` no longer copies the first-party bundles into the vault — they live with the SDK at `<SDK>/assets/extensions/` and are resolved at runtime via `resolveShippedBundlesRoot()`. A vault can add third-party bundles under `.dome/extensions/<bundle-id>/` and enable them in `.dome/config.yaml`; a vault-local bundle with the same id as a shipped bundle overrides the shipped bundle in that runtime.

### Maintenance loop metadata

The package root also exports `FIRST_PARTY_MAINTENANCE_LOOPS` and
`validateMaintenanceLoops`. This registry is not a dispatcher and does not add
a fifth executable primitive to the SDK surface. It groups existing first-party
processors into V1 maintenance loops so status/check surfaces, tests, and
future extension authors can talk about the desired conditions those processors
maintain.

Loop metadata must name a stable loop id, goal, evidence, required processor
ids, surfaces, and a settlement rule. It may also name optional processor ids
from opt-in bundles; inactive optional contributors are visible in status but
do not make a loop partial. It may also set `questionScope: "all"` for a
cross-cutting loop that should summarize every open question instead of only
questions emitted by its own processor set. `validateMaintenanceLoops` checks
that the registry references shipped processor ids and supported command
surfaces. See [[wiki/specs/processors]] §"Maintenance loops" for the loop
contract.

## Adding a processor

Four file edits, paralleling the v0.5 "Adding a Tool" recipe:

1. **The processor file** at `assets/extensions/<bundle>/processors/<name>.ts` (or `<vault>/.dome/extensions/<bundle>/processors/<name>.ts` for vault-local). Exports `defineProcessorImplementation({ run })`.
2. **The manifest entry** in `assets/extensions/<bundle>/manifest.yaml`'s `processors:` block, declaring id / version / phase / triggers / capabilities / execution / inspection.
3. **The shipped default grants** in `src/cli/default-vault-config.ts` (if a first-party processor needs capabilities not on the shipped-default grant set). Vault-local bundles grant capabilities in `<vault>/.dome/config.yaml`; if one processor in a bundle needs a narrower or broader scope than the rest of the bundle, use `extensions.<bundle>.processors.<processor-id>.grant` as a replacement grant.
4. **The test** at `tests/processors/<bundle-id>-<processor-id>.test.ts` asserting the processor runs against a representative input and emits the expected effects.

For an **external handler**, add a default-exported function at
`assets/extensions/<bundle>/external-handlers/<capability>.ts` or
`<vault>/.dome/extensions/<bundle>/external-handlers/<capability>.ts`. The
capability name is the filename stem. Handler modules are intentionally outside
`processors/`: they are allowed to touch external systems, while processors
remain effect-only.

The substrate scaffold catches the missing pieces:
- `tests/extensions/loader.test.ts` loads shipped and fixture bundles, rejects manifest/code drift, and asserts duplicate command triggers fail registry construction.
- `tests/integration/processor-purity.test.ts` typechecks that no processor's `run` body reaches a mutation surface.
- `tests/engine/capability-broker.test.ts`, `tests/engine/apply-effect.test.ts`, and `tests/engine/garden-patch-router.test.ts` exercise capability checks at the broker and routing boundaries.

## Adding a maintenance loop

Maintenance loops are descriptive metadata over processors, not a new runtime
primitive. Adding one is a substrate change because it changes how `status` and
`check` explain Dome's desired-state automation.

Five file edits:

1. **The processors** that actually implement the behavior, each added through
   the normal "Adding a processor" path above.
2. **The loop registry row** in `src/extensions/maintenance-loops.ts`, with a
   stable id, goal, evidence, required processors, optional processors when
   relevant, surfaces, settlement rule, and risks.
3. **The loop validation test** in `tests/extensions/maintenance-loops.test.ts`.
   The validator catches malformed ids, empty required metadata, duplicate
   processor references, unsupported projection/status names, invalid path
   patterns, stale processor ids, and stale command surfaces.
4. **The processor spec** in `docs/wiki/specs/processors.md`, updating the
   shipped V1 loop list or the future-loop guidance as appropriate.
5. **Any status/check expectation** if the new loop changes the operator-facing
   maintenance summary.

Do not add a new top-level CLI command just because a loop exists. If the loop
needs a human or agent surface, add a command-triggered view processor and use
the existing `dome run <name>` / dedicated-wrapper pattern.

## Adding a new invariant

Two file edits, plus the behavioral enforcement test where needed:

1. **Create the doc** at `docs/wiki/invariants/<NAME>.md` from the invariant template.
2. **Create the lockstep marker test** at `tests/invariants/<slug>.test.ts`.

The AC3 lockstep test at `tests/integration/invariant-coverage.test.ts` iterates `docs/wiki/invariants/*.md` and asserts each non-deferred invariant has a corresponding test file.

For an **off-matrix invariant** (one not enforced at a processor's capability boundary — e.g., `ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY` enforced at the bundling layer, `EVERY_EFFECT_IS_CAPABILITY_CHECKED` enforced at the engine boundary), keep the lockstep marker small and point the invariant doc at the concrete engine/integration tests that enforce the behavior.

## Registration matrix

Five kinds; one registration path (extension bundle):

| Kind | Where defaults live | Where vault-local overrides live |
|---|---|---|
| Processor | `assets/extensions/dome.*/processors/` | `<vault>/.dome/extensions/<bundle>/processors/*.ts` |
| Page type | `assets/extensions/dome.*/page-types.yaml` and SDK shipped-defaults | `<vault>/.dome/page-types.yaml` extensions block |
| Preamble fragment | `assets/extensions/dome.*/preamble.md` | `<vault>/.dome/extensions/<bundle>/preamble.md` |
| External handler | `assets/extensions/dome.*/external-handlers/` | `<vault>/.dome/extensions/<bundle>/external-handlers/*.ts` |
| Capability grant | `src/cli/default-vault-config.ts` shipped-defaults | `<vault>/.dome/config.yaml` |

There is no "Tool," "Hook," "Workflow," or "CLI command" as separate registration kinds. CLI commands are processors with `triggers: [{ kind: "command", name: "..." }]` — the bundle's `processors/` directory is the single registration surface.

## Tiered feature model

The SDK ships features across three tiers:

| Tier | Description | Examples |
|---|---|---|
| **Axioms** | Cannot be disabled. Disabling them changes what Dome is. | The axiom-tier invariants. The four core types. The fixed-point adoption loop. The capability broker. The projection store + run ledger + outbox. |
| **Shipped defaults** | Enabled by default; can opt out in `.dome/config.yaml`. | First-party `dome.*` bundles, the shipped-default-tier invariants under `wiki/invariants/`, the four default page types. |
| **Opt-in** | Shipped, not active by default. Activated by config or by installing an additional bundle. | Voice-intake (`inbox/voice/` bucket + ingest workflow inside `dome.intake`), research-intake, third-party bundles. |

`dome init <path>` produces a minimal general-purpose vault — the axioms plus shipped defaults. Activation of opt-in features is `extensions.<name>.enabled: true` in `<vault>/.dome/config.yaml`.

The shipped default config lives in `src/cli/default-vault-config.ts`, and `dome init` renders / refreshes `.dome/config.yaml` from that typed source. Integration coverage checks that enabled shipped-default bundles grant every declared capability kind.

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
