# Rewrite Validation Review — dome-v1-engine-model (pass 2)

**Pass:** 2
**Verdict:** Approved
**Disposition:** Close in same worktree → merge (Approved + Medium; M1 closed inline)

## Executive judgment

Pass-2 closes all eight pass-1 findings cleanly. The five axiom invariants now describe v1 mechanisms in detail (`projection.db`, capability broker grants, Proposal/Effect flow, run ledger dual-provenance, AGENTS.md preamble fragments). The six rewritten gotchas use v1 vocabulary; the one `vault.tools.X` hit in `out-of-band-vault-edits.md` is the historical-narration form the linter explicitly exempts ("There is no `vault.tools.X(...)` API to compete with"). The four linter specs land with concrete RETIRED_NAMES arrays, AST/grep sketches, and per-file exempt-context rules. Counts in §"Delta at a glance" match disk state. Concepts/entities/sources/syntheses no longer cite retired symbols. One residual at pass-2 review time (M1: dangling `[[wiki/linters/no-engine-internal-llm-import]]` wikilink in ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY:26) was closed inline per the Approved + Medium disposition. The repair did not introduce new defects. The substrate is implementable.

## Delta at a glance

> This rewrite replaces the v0.5+phase1+phase3 four-concept core (Vault, Document, Tool, Hook) with a new four-concept core (Vault, Proposal, Processor, Effect). Tools, Hooks, and Workflows are retired as primitives — they dissolve into Processors that emit Effects. The fixed-point adoption loop replaces the three-phase reconcile. A Bun.sqlite-backed projection store, run ledger, and outbox are added as engine infrastructure. A capability broker enforces effect emission at one chokepoint. Core features (auto-update-index, auto-cross-reference, intake-raw, dailies, ingest/lint/migrate workflows) become first-party `dome.*` extension bundles registered through the same path third-party bundles use.
>
> **Specs:** 8 rewritten; 2 retired; 6 new. Net: 9 → 13. **Invariants:** 1 unchanged content + cross-refs updated; 5 reshaped; 5 reshaped + renamed; 7 retired; 7 new. Net: 18 → 18. **Matrices:** 1 retired; 4 reshaped + renamed; 4 new. Net: 5 → 8. **Gotchas:** 6 rewritten; 5 reshaped; 2 reshaped + renamed; 4 new. Net: 17 → 21. **Linters:** 1 retired; 3 new; 1 rewritten. Net: 1 → 4.

## Important issues

### M1. Dangling `no-engine-internal-llm-import` linter forward-reference (CLOSED inline)

- **Severity:** Medium
- **Category:** Spec drift
- **Closed:** ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY.md:26 — dropped the dangling wikilink; kept the v1.x-future-linter prose so the roadmap signal survives without promising a file that isn't there.

## Architectural reflection

The v1 substrate is now coherent enough to implement. Reading the rewrite as a whole, three structural properties are doing most of the load-bearing work:

**The seven-kind Effect taxonomy is the central organizing concept.** Per-effect kind, there is a routing destination (`effect-router-targets`), a capability requirement (`effect-x-capability`), an applier branch (in `src/engine/apply-effect.ts`), and an audit-sink (in `every-effect-is-ledgered`). A future contributor adding an eighth Effect kind has four files to touch and the lockstep test catches any one they miss. That's the cohesion property the v0.5 substrate didn't have — the three-kind Effect union was small enough to keep in your head; seven kinds need the structural support and the substrate now provides it.

**The capability broker is the v1 trust property.** Every invariant about who-can-write-what reduces to "the broker rejects the effect." RAW_IS_IMMUTABLE, LOG_IS_APPEND_ONLY, EFFECTS_ARE_THE_ONLY_PROCESSOR_OUTPUT, EXTERNAL_EFFECTS_GO_THROUGH_OUTBOX, the eight-tier capability set in `wiki/specs/capabilities.md` — the broker chokepoint is doing the work that v0.5's per-Tool implementation was doing in eight scattered files. The substrate names this concentration via EVERY_EFFECT_IS_CAPABILITY_CHECKED and the four supporting linters.

**The dual-provenance audit surface (git trailers + run ledger SQLite + log.md projection) is now justified.** The §"Why not just `git log`?" rationale in LOG_IS_APPEND_ONLY.md is the linchpin: three distinct jobs (durable-in-markdown narrative, structured-queryable audit, in-git provenance) map to three surfaces, none of which is sufficient alone. The cost is intentional duplication maintained by one processor (`dome.log.append-log`); the alignment is structural, not best-effort.

**Easier downstream:** adding a processor is one file edit (in the bundle's `processors/` directory) plus a manifest entry + grant + test. The substrate's structural fences (AC3 lockstep, bundle-deps, four new linter specs) catch missed steps automatically. Multi-surface v2 work (HTTP/voice/web adapters) ships as one renderer per protocol over AbstractSurface — the engine never needs to know.

**Harder downstream:** the Tools-retirement migration (Phase 7 per the brainstorm's "Phasing the cut") will be the longest implementation phase. Every existing consumer + the SDK's public API uses `vault.tools.X(...)` as the directly-invokable primitive. The hard cut shape means a deprecation-flag-free single PR per file, which is correct discipline but high-effort. Also: adding an eighth Effect kind requires touching four files (effects.md, the union type, effect-router-targets, effect-x-capability) plus the broker — closed taxonomies should cost something to extend, which is the right tradeoff but worth naming.

**Load-bearing on memory:** until the four linter spec files ship as runnable CI checks (Phase 1 of implementation), the structural enforcement of retired-name discipline, engine-boundary discipline, and processor-purity discipline is reviewer attention. The substrate provides the spec text; the runtime check is implementation work. Until Phase 1 lands, contributors must hand-enforce.

**Proceed to Build.** Phase 1 implementation (Effect taxonomy + Proposal type per the ledger's "What this delta enables" section) has the substrate it needs.

## What looked right

- The §"Why not just `git log`?" section in LOG_IS_APPEND_ONLY.md is the strongest rewrite move. Anticipates the reader's "isn't this redundant with git commit trailers?" objection and answers it with three concrete jobs.
- The four-tier linter set carries an explicit "imports vs calls" partitioning rationale in no-direct-mutation-outside-engine.md §"Why a companion?".
- The RAW_IS_IMMUTABLE two-layer enforcement (broker grant denial + adoption-phase blocking diagnostic) names each adversary explicitly.
- The "Note on filename" preamble in scheduled-hook-idempotency.md preserves a v0.5-era filename for stable wiki-link backwards-compatibility while teaching the v1 reader that the concept is "scheduled-trigger processor."

## History

- Pass 1 (2026-05-27): Issues Found. 5 Blockers + 3 Mediums. The substrate carried the new core well but five carried-forward axiom invariants and six carried-forward gotchas still described v0.5 mechanisms; broken cross-references littered the substrate; the no-retired-symbol-names linter wasn't yet structured as a v1 check.
- Pass 2 (2026-05-27): Approved + Medium. All eight pass-1 findings closed. M1 closed inline per the Approved + Medium disposition.

## Closes

Pass-1 findings closed: B1, B2, B3, B4, B5, I1, I2, I3.
Pass-2 finding closed inline: M1.
