# Substrate Discovery — whole repo (abstraction layers, types, encapsulation, OOP framing)

Discovery in service of a full architecture review (`cohesive:review-codebase`, 2026-06-10). Scope: the entire Dome SDK at repo root, with the review lens biased toward abstraction layers, type design, and encapsulation points.

## Substrate discovered

### Target change surface

- Subsystem: (repo-wide), with emphasis on the layering between `src/core/`, `src/engine/`, `src/processors/`, `src/projections/`, `src/cli/`, `src/extensions/`, `src/mcp/`
- Main files likely involved: `src/index.ts` (public surface), `src/core/{processor,effect,proposal,source-ref}.ts`, `src/engine/{adopt,apply-effect,capability-broker,vault-runtime,compiler-host,health}.ts`, `src/processors/runtime.ts`, `src/projections/db.ts`, `src/extensions/loader.ts`, `src/outbox/dispatch.ts`, `src/cli/index.ts` + `src/cli/commands/*`, `src/mcp/server.ts`
- Size signal: 136 TS files, ~47,210 lines under `src/`. `src/engine/` holds 42 modules. Six files exceed 1,000 lines: `engine/health.ts` (1548), `processors/runtime.ts` (1532), `engine/adopt.ts` (1328), `engine/compiler-host.ts` (1166), `cli/commands/inspect.ts` (1128), `outbox/dispatch.ts` (1051)
- Neighboring subsystems: `assets/extensions/dome.*` (7 first-party bundles), `tests/` (invariants / integration / processors)

### Relevant specs/docs

- `AGENTS.md` — repo orientation; four-concept sealed core (Vault, Proposal, Processor, Effect); five conceptual services; load-bearing rules; the four flows (Submit/Adopt/Tend/Recall)
- `architecture.md` — shim pointing at the substrate; seven-point high-level contract
- `docs/index.md` — canonical substrate map (all specs/invariants/matrices/gotchas/linters linked)
- `docs/VISION.md`, `docs/v1.md`, `docs/wedge.md`, `docs/memory.md`, `docs/daily.md` — product direction (wedge plan of record 2026-06-09: five surface-in phases, evolve-don't-rebuild)
- `docs/wiki/specs/sdk-surface.md` — the normative type/abstraction contract: four-concept core, tiered features, `AbstractSurface` consumer surfaces, "Outputs the SDK does not have"
- `docs/wiki/specs/effects.md` — eleven-kind Effect taxonomy + exhaustive routing
- `docs/wiki/specs/processors.md`, `docs/wiki/specs/processor-execution.md` — Processor type, three phases, run state machine
- `docs/wiki/specs/adoption.md`, `docs/wiki/specs/proposals.md` — fixed-point loop, write path
- `docs/wiki/specs/capabilities.md` — seventeen capability tiers, single broker chokepoint
- `docs/wiki/specs/projection-store.md`, `docs/wiki/specs/run-ledger.md` — derived state + audit
- `docs/wiki/specs/cli.md`, `docs/wiki/specs/mcp-surface.md`, `docs/wiki/specs/harnesses.md` — protocol adapters
- `docs/wiki/specs/{capture,daily-surface,task-lifecycle,claims,sweep,autonomous-agents,preferences,sources,page-schema,vault-layout,foreground-compiler-workflow,embeddings}.md` — feature-level specs

### Behavior matrices

- Existing: `docs/wiki/matrices/{processor-phase-x-trigger,effect-x-capability,built-in-extensions-x-phase,intent-prompt-processors,extension-bundle-shape,projection-table-x-owner,effect-router-targets,protocol-adapter}.md` (8)
- Missing but likely needed: an engine-internal module map (what owns what inside `src/engine/`'s 42 files); a type-construction matrix (which layer constructs/validates which core type)

### Named invariants

- Existing: 20 under `docs/wiki/invariants/` (tiered: axiom / shipped default / opt-in / deferred). Directly architecture-shaped: `ENGINE_IS_THE_ONLY_APPLIER`, `EFFECTS_ARE_THE_ONLY_PROCESSOR_OUTPUT`, `EVERY_EFFECT_IS_CAPABILITY_CHECKED`, `PROPOSALS_ARE_THE_ONLY_WRITE_PATH`, `ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY`
- Candidate invariants: none surfaced yet by discovery; the review may surface encapsulation-shaped candidates (e.g. module-boundary import rules between engine submodules)

### Existing enforcement

- Tests: `tests/invariants/*.test.ts` — one per shipped invariant, pinned by AC3 lockstep (`tests/integration/invariant-coverage.test.ts`); `tests/processors/` per-processor units; `tests/integration/` cross-cutting fences
- Types: `src/core/` carries the four-concept types; `tests/integration/public-surface-shape.test.ts` pins the `src/index.ts` export surface
- Constraints: Bun.sqlite schemas in `src/projections/db.ts`, `src/ledger/runs.ts`, `src/outbox/`
- CI checks: **none found** — no `.github/workflows/`; all enforcement is local `bun test`
- Semantic linters: enforced as grep-shaped integration tests — `processor-purity`, `no-direct-mutation-outside-boundaries`, `no-console-in-engine`, `deterministic-sort`, `generated-block-splice-guard`, `processor-clock`, plus doc-side linter specs under `docs/wiki/linters/`

### Known gotchas / scars

23 under `docs/wiki/gotchas/` — most relevant to this review: `transitive-llm-dependency` (core re-export scar), `boundary-validation-via-zod` (persistence-boundary validation convention), `substrate-count-drift` (inline counts vs canonical const arrays), `processor-idempotency`, `garden-cascade-cap`

### Locality boundaries

- Public seam at `src/index.ts` (pinned by `public-surface-shape.test.ts`)
- Core-type seam at `src/core/` (10 files; `processor.ts` 980 lines, `effect.ts` 974 lines — types + validators + helpers co-resident)
- Applier chokepoint at `src/engine/apply-effect.ts` (pinned by invariant + linter)
- Suspicious locality: `src/engine/` is a 42-file flat directory mixing the adoption loop, capability machinery, compiler host/daemon, garden routing (4 `garden-*` files), question lifecycle (3 `question-*` files), model-provider machinery (3 files), locks (3 `*-lock.ts` files), and health; no documented internal layering
- Suspected duplication-that-wants-abstraction: sqlite store modules (`projections/db.ts`, `ledger/runs.ts`, `outbox/`, `answers/`, `engine/quarantine-store.ts`) each hand-roll store lifecycle; `src/sqlite/` exists but its ownership is undocumented in the repo layout (absent from AGENTS.md layout block)

### Package files (for library-native review)

- `package.json` — Bun runtime; Commander CLI; isomorphic-git; zod; ai-sdk confined to extension bundles
- `tsconfig.json`

### Missing memory

- **Engine-internal layering has no spec** — `src/engine/` (42 files) is named as one line in `AGENTS.md:66` ("engine/ # adoption loop + effect application (the single applier)") while actually carrying six distinguishable roles (adoption, capability, daemon/host, garden routing, question lifecycle, model provider, health). The substrate that would close this: a spec or matrix mapping engine submodule → role → allowed dependencies, analogous to `extension-bundle-shape`.
- **No CI gate** — no `.github/workflows/` exists; every structural fence (invariant lockstep, purity linters, public-surface pin) runs only via local `bun test`. The substrate that would close this: a CI workflow file plus a gotcha documenting the local-only enforcement window.
- **Type-construction/encapsulation convention is implicit** — `src/core/processor.ts` (980 lines) and `src/core/effect.ts` (974 lines) carry types, Zod validators, and helpers in single files; no doc states who may construct core types, where validation must happen (`boundary-validation-via-zod` gotcha covers persistence only), or why the codebase is function-module-shaped rather than class-shaped. The substrate that would close this: an sdk-surface section ("Type ownership and construction") or a `projection-table-x-owner`-style matrix for type constructors.
- **`src/sqlite/` ownership undocumented** — directory exists but is absent from the `AGENTS.md:58-92` repo-layout block; five store modules hand-roll lifecycle against it or around it. The substrate that would close this: layout-block update + a one-page store-module convention spec.

### Next

- Judge whether the implementation's abstraction layers, type seams, and encapsulation points match the documented four-concept model, and where the structure resists extension. *(`cohesive:review-codebase`.)* **Scope:** whole repo, lens on `src/` layering vs the substrate above.
