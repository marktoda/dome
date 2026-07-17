# AGENTS.md — Dome SDK repository

Orientation for agents and human contributors landing on `dome/`. This is the **repository-root** AGENTS.md, distinct from the *vault-root* AGENTS.md that every Dome-managed vault carries (see [[wiki/invariants/AGENTS_MD_IS_ORIENTATION_SURFACE]] for the per-vault contract).

## What this repo is

A TypeScript SDK on Bun — the four-concept Dome core (**Vault, Proposal, Processor, Effect**), the fixed-point adoption engine, the Bun.sqlite-backed projection store + run ledger + outbox, the capability broker, the first-party `dome.*` extension bundles, and a Commander-based CLI. The `docs/` directory is itself a Dome vault dogfooding the SDK against its own design substrate. Two protocol adapters ship as companion entrypoints outside the core import graph: the MCP stdio adapter (`dome mcp`, `src/mcp/`) and the HTTP read+capture adapter (`dome http`, `src/http/`); mobile/voice shells remain planned consumer surfaces.

The canonical substrate map is `docs/index.md`. Every spec, invariant, matrix, and gotcha is linked from there. **Read the substrate before changing code.**

## Where to start

By task shape:

- **Adding a processor** — [[docs/wiki/specs/sdk-surface]] §"Adding a processor" (four file edits: processor file + manifest entry + grant + test).
- **Adding a CLI command** — [[docs/wiki/specs/cli]] §"Adding a new command" (command-triggered view-phase processor + Commander binding + test).
- **Adding a named invariant** — [[docs/wiki/specs/sdk-surface]] §"Adding a new invariant" (three file edits + AC3 lockstep).
- **Adding an extension bundle** — [[docs/wiki/specs/sdk-surface]] §"Extension bundles" + [[docs/wiki/matrices/extension-bundle-shape]] (manifest + processors + capability grants + matrix row).
- **Understanding the engine** — [[docs/wiki/specs/adoption]] (fixed-point loop) + [[docs/wiki/specs/effects]] (the eleven kinds) + [[docs/wiki/specs/capabilities]] (broker enforcement).
- **Understanding the projection store** — [[docs/wiki/specs/projection-store]] (Bun.sqlite tables) + [[docs/wiki/specs/run-ledger]] (RunRecord) + [[docs/wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]].
- **Adding a new consumer surface** (HTTP, voice, future shells) — [[docs/wiki/specs/sdk-surface]] §"Consumer surfaces" (wrap the `src/surface/` collectors as `src/mcp/server.ts` does; `AbstractSurface` + `renderXxx` is future direction).
- **Anything else** — start at `docs/index.md`.

By substrate type:

- **Specs** — `docs/wiki/specs/`. The normative contract for each subsystem.
- **Named invariants** — `docs/wiki/invariants/`. One file per invariant; the directory is the canonical inventory.
- **Behavior matrices** — `docs/wiki/matrices/`. The cross-references between concepts.
- **Gotchas** — `docs/wiki/gotchas/`. Failure modes the design anticipates.
- **Linters** — `docs/wiki/linters/`. Convention-as-substrate rules.

## Load-bearing rules

- **The named invariants are pinned by AC3 lockstep.** `tests/integration/invariant-coverage.test.ts` iterates `docs/wiki/invariants/*.md` and requires `tests/invariants/<slug>.test.ts` per shipped invariant unless the doc frontmatter says `tier: deferred`.
- **The four-concept core is sealed.** Vault, Proposal, Processor, Effect. There is no Tool, no Hook, no Workflow as a separate primitive — those concepts dissolve into processors emitting effects. See [[docs/wiki/specs/sdk-surface]] §"Outputs the SDK does not have."
- **Proposals are the only engine write path.** No `vault.tools.X(...)`, no privileged-writer escape hatch, and no public `submitProposal` API. Human/agent writes are ordinary git commits; the daemon constructs Proposals from branch drift, and garden PatchEffects construct internal sub-Proposals. Pinned by [[docs/wiki/invariants/PROPOSALS_ARE_THE_ONLY_WRITE_PATH]] and [[docs/wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]].
- **Effects are the only processor output.** A processor returns `Promise<Effect[]>` from its `run(ctx)` body. No direct mutation surface. Pinned by [[docs/wiki/invariants/EFFECTS_ARE_THE_ONLY_PROCESSOR_OUTPUT]].
- **Every effect is capability-checked.** The broker (`src/engine/core/capability-broker.ts`) gates every effect before the engine routing layer applies it. Pinned by [[docs/wiki/invariants/EVERY_EFFECT_IS_CAPABILITY_CHECKED]].
- **`@marktoda/dome` core has no LLM or MCP dependency.** `tests/integration/bundle-deps.test.ts` is the structural fence. Re-exporting `model.invoke` or MCP machinery from `src/index.ts` fails CI. Pinned by [[docs/wiki/invariants/ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY]].
- **Markdown is the source of truth.** Knowledge projections in `projection.db`
  can be rebuilt from adopted markdown plus deterministic processors. Durable
  operational state (`answers.db`, `runs.db`, `outbox.db`, quarantine state) is
  gitignored but not fully rebuildable; preserve it unless intentionally
  discarding human answers, audit history, retry state, or processor recovery
  state.
- **Every vault is a git repo.** Axiom; enforced by `dome init`, the git
  boundary, and runtime open paths before adoption work runs.
- **The compiler boundary** (AGENTS.md + CLI + daemon + git-native writes) is the contract every agentic harness interacts with — see [[docs/wiki/specs/harnesses]].
- **`openVault` is the standard entry point.** New surfaces and CLI verbs consume the public wrapper (`src/vault.ts`); direct `openVaultRuntime` is reserved for the daemon and operator internals (serve, the status/check collectors, doctor, inspect) that report on runtime guts the wrapper hides. See [[docs/wiki/specs/sdk-surface]] §"Implementation status".

## How to run

- `bun run test` — complete root SDK and product-runtime suite. The typed runner discovers every `tests/**/*.test.ts` file, groups the sorted inventory into ordered scripts, harness, product, and runtime areas, and executes each file in its own fresh Bun process.
- `bun run check:pwa` — PWA tests, typecheck, and production build. Run this and `bun run test` for the full repository test surface.
- `bun test tests/invariants` — invariant lockstep only.
- `bun test tests/engine/apply-effect.test.ts tests/engine/capability-broker.test.ts` — broker enforcement coverage.
- `bun test tests/integration/processor-purity.test.ts` — processor-side-effect-free check.
- `bin/dome <command>` — local CLI invocation.

## Repo layout

```
src/
  index.ts              # public surface re-exports
  vault.ts              # openVault — THE standard entry point for every surface
  adopted-ref.ts        # adopted-ref read/write helpers
  core/                 # the four core types (Proposal, Effect, Processor, SourceRef)
  engine/               # the engine service — four layers, strict downward-only imports
    core/               #   adoption loop + effect application + capability machinery
    garden/             #   garden-phase patch routing + sub-Proposal construction
    operational/        #   jobs, scheduler, answers/question lifecycle, quarantine
    host/               #   compiler host, locks, vault-runtime, rebuild, health
  processors/           # processor runtime + registry
  projections/          # Bun.sqlite-backed projection store
  ledger/               # run ledger (Bun.sqlite)
  outbox/               # external-action outbox (Bun.sqlite)
  answers/              # answers store (Bun.sqlite; durable human answers)
  sqlite/               # shared Bun.sqlite connection + row helpers
  surface/              # protocol-neutral collectors (dome.<verb>/v1 documents) shared by adapters
  cli/                  # CLI command adapters
  mcp/                  # MCP stdio adapter (companion entrypoint, outside core import graph)
  http/                 # HTTP read+capture adapter (companion entrypoint; dome http)
  extensions/           # bundle loader
  git.ts                # isomorphic-git boundary
  engine-commit.ts      # pure Dome trailer/commit-message helper

assets/extensions/      # first-party dome.* bundles
  dome.agent/
  dome.claims/
  dome.daily/
  dome.graph/
  dome.health/
  dome.lint/
  dome.markdown/
  dome.search/
  dome.sources/
  dome.warden/

tests/                  # bun test files
  invariants/           # AC3 lockstep surface
  integration/          # cross-cutting structural fences
  processors/           # per-processor unit tests

docs/                   # the dogfood vault (substrate + reviews + delta ledgers + brainstorms)

bin/dome                # the CLI entrypoint script
```

## The four flows (read these before touching the engine)

**Submit** — a write becomes a Proposal:

```
git commit on the active branch / garden PatchEffect
  → Proposal { base = adopted, head, source }
  → engine.adoptionLoop(proposal)
```

**Adopt** — the fixed-point loop:

```
candidate = merge(adopted, P.head)
for iteration in 1..MAX_ITER:
  effects = run_adoption_processors(candidate)
  if blocking_diagnostics: return blocked
  patches = capability_check(effects)
  if no_patches: break (fixed point)
  candidate = apply(candidate, patches)
closure_commit(candidate, runContext)
setAdoptedRef(branch, candidate)
```

**Tend** — garden processors run after adoption:

```
for each garden_processor whose triggers match adopted-state signals:
  effects = processor.run(ctx)
  engine.routeEffects(effects)  // patches → new Proposal; facts → projection; external → outbox
```

**Recall** — queries read adopted state:

```
query.text → projection.fts_documents
query.facts → projection.facts
query.read(path) → adopted commit's blob
return matches with SourceRefs
```

## The five conceptual services (in one Bun process)

Engine (`src/engine/`) — adoption loop + applier; four internal layers (core / garden / operational / host) per [[docs/wiki/matrices/engine-module-map]]
Processor Runtime (`src/processors/`) — processor registry + invocation runtime (cron scheduling lives in `src/engine/operational/scheduler.ts`)
Projection Store (`src/projections/`) — derived state
Run Ledger (`src/ledger/`) — audit history
Query/View (`src/projections/query-view.ts` + `src/cli/commands/query.ts`) — Recall

Plus: Outbox (`src/outbox/`) — external side effects
Plus: Capability Broker (`src/engine/core/capability-broker.ts`) — effect gating

Per [[docs/wiki/matrices/protocol-adapter]], CLI / planned MCP / future HTTP / Voice are protocol adapters over the same runtime/view boundary, not separate engines. The engine doesn't know which surface is calling.

## Where this file came from

Rewritten from the v0.5 / v0.5+phase1+phase3 version on 2026-05-27 to reflect the v1 engine model adoption. Prior versions named Tools, Hooks, Workflows as separate primitives; v1 unifies them under Processor + Effect. The vocabulary shift is reflected throughout the substrate; the four-concept core is now Vault, Proposal, Processor, Effect.
