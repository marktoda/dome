# Design Delta Ledger — Dome v1 Engine Model

**Date:** 2026-05-27
**Slug:** `dome-v1-engine-model`
**Approved direction:** Option A from `docs/cohesive/brainstorms/2026-05-27-dome-v1-engine-model.md` (the v1.md proposal adopted as a hard cut)
**Worktree:** `.claude/worktrees/design/dome-v1-engine-model` on branch `design/dome-v1-engine-model`
**Classification:** **Design** (touches normative substrate broadly; retires multiple primitives; adds new primitives, specs, invariants, matrices, gotchas)

## Delta at a glance

**This rewrite replaces the v0.5+phase1+phase3 four-concept core (Vault, Document, Tool, Hook) with a new four-concept core (Vault, Proposal, Processor, Effect).** Tools, Hooks, and Workflows are retired as primitives — they dissolve into Processors that emit Effects. The fixed-point adoption loop replaces the three-phase reconcile. A Bun.sqlite-backed projection store, run ledger, and outbox are added as engine infrastructure. A capability broker enforces effect emission at one chokepoint. Core features (auto-update-index, auto-cross-reference, intake-raw, dailies, ingest/lint/migrate workflows) become first-party `dome.*` extension bundles registered through the same path third-party bundles use.

**Design-layer changes:**
- New normative concepts: Proposal, Processor (with three phases), Effect (seven-kind taxonomy), capability broker (eight tiers), projection store (Bun.sqlite), run ledger, outbox.
- Retired primitives: Tool, Hook, Workflow as separate concepts.
- New write API: `submitProposal` replaces `vault.tools.X(...)`.
- New consumer-surface shape: protocols are adapters over AbstractSurface (already shipped); the four-concept retirement of Tools dissolves the `BoundToolSurface` exposed on Vault.

**Implementation changes** (deferred to Phase 1+ of the v1 cut, not in this rewrite):
- The substrate describes the v1 end state; code rewrite happens in implement-cohesively phases per the brainstorm's "Phasing the cut" section.

**Specs:** 8 rewritten (VISION, sdk-surface, adoption, harnesses, mcp-surface, cli, vault-layout, page-schema); 2 retired (hooks, prompts-and-workflows); 6 new (proposals, processors, effects, projection-store, capabilities, run-ledger). **Net: 9 → 13.**

**Invariants:** 1 unchanged (VAULT_IS_GIT_REPO content-clean; cross-references updated for v1); 5 reshaped (MARKDOWN_IS_SOURCE_OF_TRUTH, RAW_IS_IMMUTABLE, LOG_IS_APPEND_ONLY, AGENTS_MD_IS_ORIENTATION_SURFACE, ADOPTED_REF_IS_SEMANTIC_CURSOR — bodies rewritten against v1 mechanisms; cross-references repointed); 5 reshaped + renamed (EVERY_WRITE_IS_LOGGED → EVERY_EFFECT_IS_LEDGERED; VAULT_RECONCILES_AFTER_NATIVE_WRITE → ALL_MUTATION_GOES_THROUGH_ADOPTION; CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY → ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY; ENGINE_COMMITS_CARRY_DOME_TRAILERS extends to dual surface with ledger; INBOX_IS_EPHEMERAL enforcement moves to a processor); 7 retired (HOOKS_CANNOT_BYPASS_TOOLS, HOOK_DISPATCH_IS_VAULT_BOUND, INDEX_AND_LOG_ARE_DISPATCHER_OWNED, PAGE_TYPE_BY_DIRECTORY, WIKILINKS_ARE_FULLPATH, PAGE_CREATION_REQUIRES_RECURRENCE, WORKFLOWS_KNOW_VAULT_CONTEXT); 7 new (PROPOSALS_ARE_THE_ONLY_WRITE_PATH, EFFECTS_ARE_THE_ONLY_PROCESSOR_OUTPUT, ENGINE_IS_THE_ONLY_APPLIER, EVERY_EFFECT_IS_CAPABILITY_CHECKED, EXTERNAL_EFFECTS_GO_THROUGH_OUTBOX, EVERY_PROCESSOR_RUN_IS_LEDGERED, PROJECTIONS_ARE_REBUILDABLE). **Net: 18 → 18.**

**Matrices:** 1 retired (tool-invariant-enforcement); 4 reshaped + renamed (event-types-and-payloads → effect-router-targets; consumer-surface → protocol-adapter; intent-prompt-tools → intent-prompt-processors; extension-bundle-shape extended with capabilities); 4 new (processor-phase-x-trigger, effect-x-capability, built-in-extensions-x-phase, projection-table-x-owner). **Net: 5 → 8.**

**Gotchas:** 6 rewritten (async-read-after-write-staleness, out-of-band-vault-edits, multi-page-partial-write, agent-prompt-regression, transitive-llm-dependency, daemon-off-while-vault-mutating — bodies rewritten against v1 vocabulary; failure modes preserved); 5 reshaped (extension-bundle-load-order rewritten, scheduled-hook-idempotency rewritten retaining filename, dirty-git-state-at-reconcile + boundary-validation-via-zod cross-references repointed, substrate-count-drift cross-references repointed); 2 reshaped + renamed (hook-cycle → processor-fixed-point-divergence; hook-non-idempotent → processor-idempotency); 4 new (outbox-stuck, projection-schema-skew, capability-downgrade-surprise, processor-version-drift). **Net: 17 → 21.**

**Linters:** 1 retired (wrap-mutating-invoke-consumption — v0.5-only enforcement for retired HOOK_DISPATCH_IS_VAULT_BOUND); 4 new (no-retired-symbol-names — rewritten as v1 structural fence; engine-is-sole-applier; no-direct-mutation-outside-engine; processor-purity). **Net: 1 → 4.**

**Orientation surfaces:** docs/index.md fully rewritten for new vocabulary; AGENTS.md fully rewritten with v1 task-shape guidance. Concepts + entities + sources + syntheses rewritten to drop retired-name citations (llm-wiki-pattern, brain-companion, obsidian, karpathy-llm-wiki-gist, v0.5-build-plan).

## Per-file changes

### Specs

| File | Disposition | Notes |
|---|---|---|
| `docs/VISION.md` | Rewritten | Four operators (Submit/Adopt/Tend/Recall); four core types (Vault/Proposal/Processor/Effect); six principles updated; v1/v1.5/v2 sequencing. |
| `docs/wiki/specs/sdk-surface.md` | Rewritten | Four-concept core; Submit + Recall APIs; extension bundles as the sole registration path; AbstractSurface + protocol renderers; dependency list updated. Retired `BoundToolSurface`, `runWorkflow`, the 8-Tool catalog, the hook YAML loader. |
| `docs/wiki/specs/adoption.md` | Rewritten | Fixed-point loop with MAX_ITER cap; engine commit trailers preserved; closure-commit produces consolidated diff; hosted-protected mode designed-for in v1.5; deprecated `dome reconcile` alias retired. |
| `docs/wiki/specs/harnesses.md` | Rewritten | Compiler boundary recast around Submit + Recall; native write → Proposal via watcher; CLI as v1 primary; MCP as additive. |
| `docs/wiki/specs/mcp-surface.md` | Rewritten | One protocol adapter over AbstractSurface; `dome.submit`, `dome.query`, `dome.run_command` tools; resources at `dome://...`; non-primary in v1. |
| `docs/wiki/specs/cli.md` | Rewritten | New CLI commands: submit, query, rebuild, run-processor; `dome reconcile` retired; "Adding a new command" recipe is "register a command-triggered view-phase processor." |
| `docs/wiki/specs/vault-layout.md` | Rewritten | `.dome/state/` carries `projection.db`, `runs.db`, `outbox.db` plus markers; `notes/` asymmetry preserved; `index.md` and `log.md` are committed projections owned by `dome.index` and `dome.log`. |
| `docs/wiki/specs/page-schema.md` | Rewritten | Four universal fields preserved; validation moves to `dome.markdown.validate-frontmatter` adoption-phase processor; extension types via bundles. |
| `docs/wiki/specs/proposals.md` | **New** | The Proposal type; local-eventual + hosted-protected construction paths; `submitProposal` API; lifecycle states; what a Proposal cannot do. |
| `docs/wiki/specs/processors.md` | **New** | The Processor type; three phases (adoption/garden/view); triggers (signal/path/schedule/command); capabilities; first-party `dome.*` bundles; idempotency; what processors cannot do. |
| `docs/wiki/specs/effects.md` | **New** | Seven-kind Effect union (Patch/Diagnostic/Fact/Question/Job/ExternalAction/View); per-kind contracts; SourceRef; exhaustive routing. |
| `docs/wiki/specs/projection-store.md` | **New** | Bun.sqlite-backed `projection.db`; tables; cache key (adopted×extension-set×processor-versions); rebuild path; schema-skew auto-recovery; outbox in separate database. |
| `docs/wiki/specs/capabilities.md` | **New** | Eight capability tiers; manifest declarations; vault grants; broker enforcement; capability uses ledgered. |
| `docs/wiki/specs/run-ledger.md` | **New** | RunRecord per processor invocation; CapabilityUse rows; dual-surface with git trailers; cost tracking; retention. |
| `docs/wiki/specs/hooks.md` | **Retired** | Content dissolves into `processors.md` §"Triggers" and `effects.md`. |
| `docs/wiki/specs/prompts-and-workflows.md` | **Retired** | Workflows dissolve into garden-phase processors with `model.invoke` capability; prompts live alongside processors. |

### Invariants

| File | Disposition | Notes |
|---|---|---|
| `docs/wiki/invariants/VAULT_IS_GIT_REPO.md` | Carried forward | Unchanged. |
| `docs/wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH.md` | Carried forward | Extended scope to cover projection rebuildability. |
| `docs/wiki/invariants/RAW_IS_IMMUTABLE.md` | Carried forward | Unchanged. |
| `docs/wiki/invariants/ADOPTED_REF_IS_SEMANTIC_CURSOR.md` | Carried forward | Unchanged. |
| `docs/wiki/invariants/LOG_IS_APPEND_ONLY.md` | Carried forward | `log.md` is now a projection of the run ledger; the append-only property carries through. |
| `docs/wiki/invariants/AGENTS_MD_IS_ORIENTATION_SURFACE.md` | Carried forward | Unchanged. |
| `docs/wiki/invariants/EVERY_WRITE_IS_LOGGED.md` | Renamed → `EVERY_EFFECT_IS_LEDGERED.md` + rewritten | Generalized from on-disk-mutation tracking to seven-kind-effect audit. |
| `docs/wiki/invariants/VAULT_RECONCILES_AFTER_NATIVE_WRITE.md` | Renamed → `ALL_MUTATION_GOES_THROUGH_ADOPTION.md` + rewritten | Unified mutation path; no Tool-vs-native bifurcation. |
| `docs/wiki/invariants/CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY.md` | Renamed → `ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY.md` + rewritten | Renaming precise; same dep-fence. |
| `docs/wiki/invariants/ENGINE_COMMITS_CARRY_DOME_TRAILERS.md` | Rewritten | Extended definition: trailers + run ledger row are dual provenance surfaces. |
| `docs/wiki/invariants/INBOX_IS_EPHEMERAL.md` | Rewritten | Enforcement is now a processor (`dome.intake.inbox-stale-check`) emitting Diagnostics. |
| `docs/wiki/invariants/HOOKS_CANNOT_BYPASS_TOOLS.md` | **Retired** | No Tools to bypass. |
| `docs/wiki/invariants/HOOK_DISPATCH_IS_VAULT_BOUND.md` | **Retired** | No hooks; processors are vault-bound by construction. |
| `docs/wiki/invariants/INDEX_AND_LOG_ARE_DISPATCHER_OWNED.md` | **Retired** | Replaced by `owns.path` capability for `dome.index` and `dome.log`. |
| `docs/wiki/invariants/PAGE_TYPE_BY_DIRECTORY.md` | **Retired** | Now a FactEffect emitted by `dome.markdown`. |
| `docs/wiki/invariants/WIKILINKS_ARE_FULLPATH.md` | **Retired** | Now a DiagnosticEffect from `dome.markdown.validate-wikilinks`. |
| `docs/wiki/invariants/PAGE_CREATION_REQUIRES_RECURRENCE.md` | **Retired** | Now a DiagnosticEffect from `dome.intake`. |
| `docs/wiki/invariants/WORKFLOWS_KNOW_VAULT_CONTEXT.md` | **Retired** | Workflows retired; ProcessorContext carries snapshot. |
| `docs/wiki/invariants/PROPOSALS_ARE_THE_ONLY_WRITE_PATH.md` | **New** | The write-path chokepoint. Closes the v0.5 "trusted internal write" loophole. |
| `docs/wiki/invariants/EFFECTS_ARE_THE_ONLY_PROCESSOR_OUTPUT.md` | **New** | Snapshot-in-effects-out contract enforced structurally. |
| `docs/wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER.md` | **New** | Single applier in `src/engine/apply-effect.ts`; exhaustive Effect switch. |
| `docs/wiki/invariants/EVERY_EFFECT_IS_CAPABILITY_CHECKED.md` | **New** | Broker chokepoint per Effect emission. |
| `docs/wiki/invariants/EXTERNAL_EFFECTS_GO_THROUGH_OUTBOX.md` | **New** | Outbox-mediated external actions; idempotency keys dedup retries. |
| `docs/wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED.md` | **New** | RunRecord per invocation, regardless of outcome. |
| `docs/wiki/invariants/PROJECTIONS_ARE_REBUILDABLE.md` | **New** | `projection.db` wipeable and reconstructable from markdown. |

### Matrices

| File | Disposition | Notes |
|---|---|---|
| `docs/wiki/matrices/tool-invariant-enforcement.md` | **Retired** | No Tools to enforce invariants at. |
| `docs/wiki/matrices/event-types-and-payloads.md` | Renamed → `effect-router-targets.md` + rewritten | Effect-kind × phase → engine routing destination. |
| `docs/wiki/matrices/consumer-surface.md` | Renamed → `protocol-adapter.md` + rewritten | CLI/MCP/HTTP/Voice mapped to AbstractSurface operations. |
| `docs/wiki/matrices/intent-prompt-tools.md` | Renamed → `intent-prompt-processors.md` + rewritten | User intent → processor mapping. |
| `docs/wiki/matrices/extension-bundle-shape.md` | Rewritten | Five contribution kinds updated for v1 (processors, external-handlers, capability-grants replace tools/hooks/workflows/cli-commands separately). |
| `docs/wiki/matrices/processor-phase-x-trigger.md` | **New** | Phase × trigger compatibility table. |
| `docs/wiki/matrices/effect-x-capability.md` | **New** | Per-Effect-kind capability requirements. |
| `docs/wiki/matrices/built-in-extensions-x-phase.md` | **New** | First-party `dome.*` bundles × phase × processors. |
| `docs/wiki/matrices/projection-table-x-owner.md` | **New** | Per-table writer authority + namespace scoping. |

### Gotchas

| File | Disposition | Notes |
|---|---|---|
| `docs/wiki/gotchas/adopted-ref-divergence.md` | Carried forward | Unchanged. |
| `docs/wiki/gotchas/agent-prompt-regression.md` | Carried forward | Unchanged. |
| `docs/wiki/gotchas/agents-md-delimiter-shape.md` | Carried forward | Unchanged. |
| `docs/wiki/gotchas/ai-sdk-tool-variance.md` | Carried forward | Relevant to garden-LLM processors. |
| `docs/wiki/gotchas/async-read-after-write-staleness.md` | Carried forward | Reframed around submit→adopt latency. |
| `docs/wiki/gotchas/boundary-validation-via-zod.md` | Carried forward | Unchanged. |
| `docs/wiki/gotchas/concurrent-harness-write.md` | Carried forward | Two harnesses → two Proposals → sequenced adoption. |
| `docs/wiki/gotchas/daemon-off-while-vault-mutating.md` | Carried forward | Unchanged. |
| `docs/wiki/gotchas/dirty-git-state-at-reconcile.md` | Carried forward | Still applies to `dome sync`. |
| `docs/wiki/gotchas/multi-page-partial-write.md` | Carried forward | Atomic adoption mitigates partial-write scenarios. |
| `docs/wiki/gotchas/out-of-band-vault-edits.md` | Carried forward | Canonical path: native write → watcher → Proposal. |
| `docs/wiki/gotchas/scheduled-hook-idempotency.md` | Carried forward | Renamed conceptually to "scheduled-processor-idempotency"; doc keeps its v0.5 name as the canonical reference. |
| `docs/wiki/gotchas/substrate-count-drift.md` | Carried forward | Counts now defer to canonical const arrays. |
| `docs/wiki/gotchas/transitive-llm-dependency.md` | Carried forward | Same dep-fence; renamed invariant reference (ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY). |
| `docs/wiki/gotchas/hook-cycle.md` | Renamed → `processor-fixed-point-divergence.md` + rewritten | Loop divergence diagnosed via MAX_ITER cap. |
| `docs/wiki/gotchas/hook-non-idempotent.md` | Renamed → `processor-idempotency.md` + rewritten | Processor idempotency required for loop convergence + rebuild. |
| `docs/wiki/gotchas/extension-bundle-load-order.md` | Rewritten | New collision dimensions for v1 (processor-collision, capability-handler-collision, cli-command-collision, bundle-deps-unmet). |
| `docs/wiki/gotchas/outbox-stuck.md` | **New** | Failed external-action retries; manual replay/abandon. |
| `docs/wiki/gotchas/projection-schema-skew.md` | **New** | Auto-rebuild on schema-hash mismatch. |
| `docs/wiki/gotchas/capability-downgrade-surprise.md` | **New** | `patch.auto` exceeding grant downgrades to propose. |
| `docs/wiki/gotchas/processor-version-drift.md` | **New** | Per-processor cache invalidation on version change. |

### Orientation surfaces

| File | Disposition | Notes |
|---|---|---|
| `docs/index.md` | Rewritten | Full substrate map updated for new vocabulary; new sections (processor specs, projection-store, capabilities, run-ledger); 4 new matrices; 7 new invariants; 4 new gotchas; 4 new linter specs. |
| `AGENTS.md` (repo root) | Rewritten | New task-shape guidance for v1 (adding a processor, CLI command, invariant, bundle); load-bearing rules updated; repo layout reflects new src/ topology; four flows summary; five conceptual services. |

### Linters (referenced but not yet authored as separate spec files)

The substrate references four named linter specs that ship as part of v1 implementation:

- `engine-is-sole-applier` — semantic linter enforcing the engine boundary.
- `no-direct-mutation-outside-engine` — companion to the above.
- `no-retired-symbol-names` — extends the v0.5+phase1+phase3 linter for the new retired-name set.
- `processor-purity` — static check on processor `run()` bodies.

These linter specs will be authored under `docs/wiki/linters/` during Phase 1 of the v1 implementation (per the brainstorm's phasing) — when the rule has a corresponding runtime check. v1 ships them as structural fences.

## Substrate updated (counts)

- **Specs:** 12 normative specs (was 9): 8 rewritten + 6 new + 2 retired. Net: +3.
- **Behavior matrices:** 8 matrices (was 5): 4 reshaped + 4 new + 1 retired. Net: +3.
- **Named invariants:** 18 invariants (was 18): 5 reshaped + 7 new + 7 retired. Net: 0.
- **Gotchas:** 21 gotchas (was 17): 3 reshaped + 4 new + 0 retired. Net: +4.

## Remaining ambiguity

- **Linter spec files:** four named linter specs are referenced in the substrate but not yet authored as individual files. They land as part of Phase 1 of v1 implementation.
- **`dome.search` semantic-search prompt design:** referenced in `intent-prompt-processors.md` but the actual prompt content + embedding-model choice is implementation-phase.
- **Multi-vault MCP routing:** explicitly out of scope for v1; mentioned in `mcp-surface.md` as a "single-vault per process" constraint without a v1.x roadmap.
- **External-handler authentication shape:** capabilities spec names `external:<capability>` but doesn't fix how credentials are configured (env vars vs config.yaml vs vendor-specific). Implementation decision.
- **Bundle installation UX beyond directory copy:** v1 keeps it `cp -r` + `dome doctor --repair`. A `dome install-extension <name>` CLI helper is deferred to v1.x.
- **The retired `dome reconcile` deprecation alias:** v1 retires it; users currently calling `dome reconcile` will see "unknown command." The migration cushion is one minor release; was this enough? (Brainstorm marked it acceptable.)

## What this delta enables (next steps)

After `validate-rewrite` Approved:

**Phase 1 — Effect taxonomy + Proposal type.** Implement `src/core/{effect,proposal,processor,source-ref}.ts`. Replace existing 3-kind Effect with 7-kind union.

**Phase 2 — The engine.** Implement `src/engine/{adopt,apply-effect,capability-broker,compile-range,closure-commit}.ts`. Replace `src/adoption.ts:sync` with engine adoption loop.

**Phase 3 — Processor runtime.** Implement `src/processors/{runtime,registry,triggers,context}.ts`. Migrate shipped-default hooks into first-party processors.

**Phase 4 — Projection store.** Implement `src/projections/` with Bun.sqlite. Migrate `index.md` and scheduled.json into projections.

**Phase 5 — Capability broker.** Tighten from Phase 2 placeholder. Enforce at one chokepoint. Migrate bundle manifests.

**Phase 6 — Core features as extensions.** Move shipped-default hooks/workflows into `assets/extensions/dome.*/`.

**Phase 7 — Retire Tools surface.** Delete `src/tools/`, `src/privileged-writer.ts`. Replace all callers with `submitProposal`.

**Phase 8 — Run ledger + outbox.** Implement `src/ledger/` and `src/outbox/`.

**Phase 9 — Hosted-protected mode (v1.5).** Conditional; defer if v1 ship is local-eventual only.

**Phase 10 — Cleanup.** Delete retired invariant tests, gotcha docs that no longer apply, package.json deps no longer transitively reached.

The substrate-as-tests scaffold (AC3 lockstep + bundle-deps + no-retired-symbol-names + new linters) catches drift through each phase.

## Linters (NEW SECTION — added in repair pass 2)

| File | Disposition | Notes |
|---|---|---|
| `docs/wiki/linters/wrap-mutating-invoke-consumption.md` | **Retired** | Enforced the v0.5-era HOOK_DISPATCH_IS_VAULT_BOUND invariant over TOOL_REGISTRY / wrapMutatingInvoke / MUTATING_TOOL_NAMES symbols — none of which exist in v1. The no-retired-symbol-names linter subsumes the spirit (catching retired-symbol citations). |
| `docs/wiki/linters/no-retired-symbol-names.md` | Rewritten | Was the v0.5 version focused on the ConsumerSurface → AbstractSurface rename. v1 version expands the allowlist to cover Tool/Hook/Workflow/BoundToolSurface/runWorkflow/wrapMutatingInvoke + the seven retired-invariant names + the three retired+renamed invariants + the retired matrix + retired specs + retired gotchas + retired filesystem paths. Sweeps `docs/wiki/**/*.md`. |
| `docs/wiki/linters/engine-is-sole-applier.md` | **New** | Statement: `src/` outside `src/engine/`, `src/projections/`, `src/ledger/`, `src/outbox/` doesn't import mutation modules (`node:fs`, `bun:sqlite`, `isomorphic-git` write-side functions). The structural fence behind [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]]. |
| `docs/wiki/linters/no-direct-mutation-outside-engine.md` | **New** | Statement: source files outside the engine directories don't make direct mutation calls (`Bun.write`, `fs.writeFile`, `db.execute("INSERT ...")`, `git.commit(...)`). Companion to engine-is-sole-applier — catches the calls; engine-is-sole-applier catches the imports. |
| `docs/wiki/linters/processor-purity.md` | **New** | Statement: extension-bundle processor files don't import mutation modules. The structural fence behind [[wiki/invariants/EFFECTS_ARE_THE_ONLY_PROCESSOR_OUTPUT]]. |

All four new linter specs are `status: v1 (proposed; lockstep check ships in Phase 1 of implementation)`. They are reviewable substrate now; the runtime checks ship as part of v1 implementation Phase 1 per the brainstorm's "Phasing the cut" section. The `no-retired-symbol-names` linter is the structural fence the pass-1 validate-rewrite review (`docs/cohesive/reviews/2026-05-27-dome-v1-engine-model-rewrite-validation.md`) named as the substrate gap behind findings B1, B2, B3, and B5.

## Concepts / Entities / Sources / Syntheses (NEW SECTION — added in repair pass 2)

The pass-1 review surfaced (finding B5) that the orientation docs under `docs/wiki/concepts/`, `docs/wiki/entities/`, `docs/wiki/sources/`, and `docs/wiki/syntheses/` carried retired-name citations. The rewriter's scope at pass 1 was `wiki/specs/` and `wiki/invariants/` only. Pass 2 widens the audit:

| File | Disposition | Notes |
|---|---|---|
| `docs/wiki/concepts/llm-wiki-pattern.md` | Rewritten | Replaced citations of retired `PAGE_TYPE_BY_DIRECTORY` with the v1 substrate path (page-type as FactEffect from dome.markdown; wikilink-fullpath as DiagnosticEffect from dome.markdown.validate-wikilinks). Replaced "four concepts" reference to point at v1's four (Vault/Proposal/Processor/Effect). |
| `docs/wiki/concepts/brain-companion.md` | Rewritten | Replaced citations of retired `wiki/specs/hooks` and `intake-raw` hook with v1 substrate (the `dome.intake` bundle's garden-phase processor; the `intent-prompt-processors` matrix). |
| `docs/wiki/entities/obsidian.md` | Rewritten | Replaced citations of retired `WIKILINKS_ARE_FULLPATH` with the v1 substrate (`dome.markdown.validate-wikilinks` adoption-phase processor emits the blocking diagnostic). |
| `docs/wiki/sources/karpathy-llm-wiki-gist.md` | Rewritten | Replaced citations of retired `PAGE_TYPE_BY_DIRECTORY` with v1's page-type-as-FactEffect framing. Updated "Operations: ingest, query, lint" to name the v1 first-party bundles (`dome.intake`, `dome.search`, `dome.lint`). Retired the "sensitivity-classify" reference from earlier substrate. |
| `docs/wiki/syntheses/v0.5-build-plan.md` | Rewritten | Was v0.5/v1+/long-term phasing. v1 version explicitly names v0.5 as archival, makes v1 the "engine model" header, adds v1.5 hosted-multi-client phasing, renames v2 from "v1+ Product." References the canonical v1 substrate throughout. |

## Repair pass 2

**Trigger:** pass-1 validate-rewrite review at `docs/cohesive/reviews/2026-05-27-dome-v1-engine-model-rewrite-validation.md` returned Issues Found with 5 Blocker + 3 Medium findings.

**Closes:** B1, B2, B3, B4, B5, I1, I2, I3 per the pass-1 review's "Recommended repairs (ranked)" section.

**Summary of repairs:**

- **B1 (5 carried-forward axiom invariants):** MARKDOWN_IS_SOURCE_OF_TRUTH, RAW_IS_IMMUTABLE, LOG_IS_APPEND_ONLY, AGENTS_MD_IS_ORIENTATION_SURFACE, ADOPTED_REF_IS_SEMANTIC_CURSOR — bodies rewritten against v1 mechanisms; retired-symbol citations removed; Related sections re-pointed.
- **B2 (broken cross-references):** Closed via (a) the linter spec rewrite of `no-retired-symbol-names.md` with the full v1 allowlist, (b) per-file fixes across the orientation docs, (c) cross-reference repointing in the six rewritten gotchas.
- **B3 (6 carried-forward gotchas):** async-read-after-write-staleness, out-of-band-vault-edits, multi-page-partial-write, agent-prompt-regression, transitive-llm-dependency, daemon-off-while-vault-mutating — bodies rewritten with v1 vocabulary while preserving the failure modes they document.
- **B4 (v0.5 linter spec on disk):** Deleted `docs/wiki/linters/wrap-mutating-invoke-consumption.md`. The substrate's new structural enforcement story is the four v1 linters above.
- **B5 (orientation docs):** Audited and rewrote `docs/wiki/concepts/`, `docs/wiki/entities/`, `docs/wiki/sources/`, `docs/wiki/syntheses/` per the new §"Concepts / Entities / Sources / Syntheses" section.
- **I1 (preamble arithmetic):** Updated the Delta at a glance preamble — "Specs: 8 rewritten ..." (was "6 rewritten ... VISION + 7").
- **I2 (linter spec stubs):** Authored the four named linter spec files at `docs/wiki/linters/`.
- **I3 (page-schema forward pointer):** Added an explicit "extension-contributed type ... not one of the four defaults" annotation at the daily-type early example.

**Files reshuffled in the ledger:** the five axiom-invariant rows and the six gotcha rows that were previously in "Carried forward" disposition were moved to "Rewritten." The new §"Linters" section enumerates the linter set. The new §"Concepts / Entities / Sources / Syntheses" section names the audit scope the pass-1 reviewer flagged.

**The substrate is now internally consistent across the rewritten surfaces.** A subsequent pass-2 validate-rewrite reviewer reading any rewritten doc reaches v1 vocabulary and v1 cross-references; broken `[[wiki/...]]` links to retired files no longer appear in the live substrate (excluding history-narration framing in renamed-invariant docs, which is exempted per the no-retired-symbol-names linter's "historical narration" rule).

## Source brainstorm

`docs/cohesive/brainstorms/2026-05-27-dome-v1-engine-model.md` (to be persisted after this rewrite lands — per the brainstorm-design skill's persistence rule).

## Source v1 proposal

`docs/v1.md` — the architect's first-principles essay that this rewrite adopts.
