# Rewrite Validation Review — Dome compiler reframe + sensitivity retirement

**Reviewer:** spec-cohesion-reviewer (fresh-eyes context)
**Date:** 2026-05-26
**Pass:** 4
**Subject:** Pass-4 review after pass-3 repair commit `5d259f8`. Convergence trajectory: 4+3 → 4+3 → 1+3 → 0+2+2.

**Verdict:** Approved

## Executive judgment

The rewrite is implementable. A future contributor reading these specs cold can reproduce the system's intended behavior: the compiler-boundary contract is named clearly across VISION, harnesses.md, and the new `VAULT_RECONCILES_AFTER_NATIVE_WRITE` axiom; `AGENTS.md` has a structural-enforcement story (init writes, `--repair` regenerates, doctor flags drift); the sensitivity retirement is complete in normative sections; MCP's non-primary status is consistently named at every surface. The Pass-3 fix of placing MCP outside the enablement-tier model is load-bearing — it removes the contradiction a future reader would otherwise find between "non-primary" and "axiom-tier code surface." The remaining issues are small textual stragglers from the sensitivity / two-shipped-defaults eras, not architectural gaps.

## Architectural reflection

The compiler reframe ships honest substrate. The system that's described in the post-pass-4 specs is a markdown vault wrapped by a daemon-shaped compiler (`dome serve`), a CLI surface for explicit operations, and a per-vault `AGENTS.md` for chat-harness orientation. Each surface is independently understandable; their interactions are named in one place each (the compiler-boundary contract in `harnesses.md`); the failure modes have documented gotchas. A new contributor reading the substrate could write a new shell (mobile, web, voice) without re-deriving architectural intent — they'd import the SDK, choose their ConsumerSurface adapter, and target either the compiler daemon's events or the CLI's named ops.

- **Easier downstream:** Adding a new agentic-harness adopter (Cursor support, an OpenCode setup doc, a future Claude Desktop) is a vault-author-contributed `docs/wiki/sources/<harness>-setup.md` plus reading the compiler-boundary contract. No SDK change needed. Same for a v1+ native mobile surface — the SDK's portable core + ConsumerSurface model is the contract; the surface chooses its motion.
- **Harder downstream:** Re-introducing structural invariants that gate at write-time (sensitivity routing's original shape, or any future "block-on-write" policy) is harder under the post-hoc reconciliation model — adding one means re-introducing a synchronous-tool-call enforcement path that competes with the watcher. The two-ways-by-scope split makes this clear (internal gates; external reconciles), so the future implementer would have to pick which side they're adding to and document the choice; that's deliberate friction against ungrounded synchronous-gate proliferation, not an obstacle to legitimate ones.
- **Load-bearing on memory:** Three substrate-noted items in the ledger §"Remaining ambiguity" are loaded onto reviewer attention until they land in code: the `--mcp` / `--no-mcp` flag form for `dome serve`, the exact AGENTS.md content template the implementer chooses, and the future HTTP-transport mcp-surface question. None has a structural backstop yet; each is reviewer-attention-enforced.

## Delta at a glance

This rewrite is **Design** (touches normative substrate broadly + retires one feature; no implementation work in this pass — implementation lands in a follow-on `cohesive:implement-cohesively` after `validate-rewrite` returns Approved).

- **Files:** 18 rewritten, 4 added (2 invariants, 1 gotcha, 1 ledger), 3 removed (sensitivity feature substrate)
- **Conceptual changes:** Dome's value-prop reframed around the *compiler* model rather than the gateway model; two-surface-pattern framing (native Dome shells vs agentic harnesses) introduced as the architectural commitment; `AGENTS.md` named as the canonical agent-orientation surface across chat-shaped harnesses; the MCP surface preserved in code but explicitly flagged as non-primary in v0.5; the sensitivity-classification feature retired entirely; `inbox/review/` simplified to single-purpose lint-report destination; the "invariants are enforced two ways, by scope" principle made explicit.
- **Named invariants:** `SENSITIVE_GOES_TO_INBOX` (deleted); `EVERY_WRITE_IS_LOGGED` (clarified: two enforcement paths); `VAULT_RECONCILES_AFTER_NATIVE_WRITE` (added, axiom); `AGENTS_MD_IS_ORIENTATION_SURFACE` (added, shipped-default).
- **Behavior matrices:** `consumer-surface.md` annotated; `intent-prompt-tools.md` sensitivity row deleted; `tool-invariant-enforcement.md` SENSITIVE column removed.
- **Gotchas:** `out-of-band-vault-edits.md` upgraded to canonical-path framing; `daemon-off-while-vault-mutating.md` added.
- **Semantic linters:** none new.
- **Tests proposed:** AGENTS.md generation; `--repair` regeneration; out-of-band-write end-to-end; reconcile catchup; `--time-since-reconcile`; sensitivity tests deleted.
- **Deferred:** Implementation (next pass); native client surfaces (v1+).

## Important issues

### I1. sdk-surface.md still claims "Two shipped default hooks" — `intake-raw` is the third

- **Severity:** Medium
- **Category:** Spec drift
- **Why it matters:** A reader landing on sdk-surface.md (the canonical SDK reference) is told only two hooks ship by default. But hooks.md §"Shipped default hooks" names three, the sdk-surface tier table at line 271 lists `intake-raw` as shipped-default, and `dome init` writes `intake-raw.yaml` per cli.md:27. Same inventory-count drift pattern as the pass-1 B3 closure across cli.md / index.md.
- **Evidence:** `sdk-surface.md:235` — `**Two shipped default hooks** ride in the SDK as enabled-by-default` followed by `auto-update-index` and `auto-cross-reference` only.
- **Recommended fix:** Update to `**Three shipped default hooks**` and add a third bullet for `intake-raw` with forward-pointer to hooks.md §"Intake patterns — shipped-default and opt-in".

### I2. prompts-and-workflows.md `ingest` row hedges its intake trigger as "(when activated)" — but intake-raw is shipped-default

- **Severity:** Medium
- **Category:** Spec drift
- **Why it matters:** The `ingest` workflow's intake trigger `intake:inbox/raw/*` is annotated `(when activated)`. But `intake-raw` ships enabled by default. The hedge tells a future contributor that `inbox/raw/` capture is opt-in. Pass-3 closed an analogous hedge in `brain-companion.md:27`; this is the same residue on the workflow table.
- **Evidence:** `prompts-and-workflows.md:59` — `| ingest | shipped default | intake:inbox/raw/* (when activated), intent:capture-thought | ...`.
- **Recommended fix:** Drop `(when activated)` from the `ingest` row's trigger cell.

### I3. prompts-and-workflows.md "CLI commands map 1:1 to workflows" overstates the mapping

- **Severity:** Low
- **Category:** Vague language
- **Why it matters:** Only the three workflow-driven CLI commands map 1:1 to workflows: `migrate`, `lint`, `export-context`. The other five (`init`, `serve`, `reconcile`, `doctor`, `stats`) are deterministic. cli.md:231 names the actual split correctly.
- **Evidence:** `prompts-and-workflows.md:165` — `CLI commands map 1:1 to workflows.`
- **Recommended fix:** Reword to `Workflow-driven CLI commands map 1:1 to workflows — dome lint invokes lint, dome migrate invokes migrate, dome export-context invokes export-context. Other CLI commands (init, serve, reconcile, doctor, stats) are deterministic Tool sequences with no workflow.`

### I4. intent-prompt-tools.md `ingest` row missing "intake-triggered" annotation

- **Severity:** Low
- **Category:** Domain model
- **Why it matters:** The matrix's `voice-ingest` and `clip-integrate` rows are annotated `(intake-triggered)`. `ingest` is the only other intake-triggered workflow (via shipped-default `intake-raw`), but its row carries only the conversational-intent phrasing — asymmetric signal to readers.
- **Evidence:** `intent-prompt-tools.md:20` (`ingest` row — no annotation) vs `:27` (`voice-ingest (intake-triggered)`) and `:28` (`clip-integrate (intake-triggered)`).
- **Recommended fix:** Add an `(also intake-triggered via shipped-default inbox/raw/)` annotation to the `ingest` row's intent column.

## Recommended repairs (ranked)

1. I1 — sdk-surface.md:235 "Two" → "Three" + intake-raw bullet.
2. I2 — drop "(when activated)" from prompts-and-workflows.md:59 ingest row.
3. I3 — tighten prompts-and-workflows.md:165 CLI-to-workflow mapping claim.
4. I4 — annotate intent-prompt-tools.md:20 ingest row.

## What looked right

- The MCP-outside-the-tier-table fix from Pass-3 (sdk-surface.md:274) cleanly removes the framing contradiction between "MCP is non-primary" and "MCP appears in an axiom-shaped enablement model" — the `consumer-shell entrypoint choice` framing is the right substrate distinction.
- `VAULT_RECONCILES_AFTER_NATIVE_WRITE` and `EVERY_WRITE_IS_LOGGED` together cleanly encode the "two ways by scope" principle from VISION §"Principles" #3 — the external scope has structural backing, not just rhetorical framing.
- `out-of-band-vault-edits.md`'s status-note framing turns what would have been a contradiction (gotcha-titled-"out-of-band" describing canonical behavior) into an explicit upgrade narrative.
- `AGENTS_MD_IS_ORIENTATION_SURFACE`'s template-vs-user-prose split with HTML-comment delimiters is the right structural shape.
- Convergence trajectory pass-over-pass (4+3 → 4+3 → 1+3 → 0+2+2) shows the repair loop working as designed: each pass surfaced different residue from a different era of the spec lineage, and each repair commit was tightly scoped.
