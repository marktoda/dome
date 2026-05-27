# Rewrite Validation Review — Dome hooks Phase 0 + Phase 1 skeleton (Pass 2)

**Reviewer:** spec-cohesion-reviewer (fresh-eyes context)
**Date:** 2026-05-27
**Pass:** 2

**Verdict:** Approved

## Executive judgment

The rewrite is implementable. A future contributor reading these specs can stand up the extension-bundle loader, schedule-driven hooks, `upsertSection`, `dome run-hook`, the AGENTS.md preamble-fragment threading, and the first-party `dailies` bundle without re-deriving intent — the bundle directory shape, six-step load lifecycle, error taxonomy, hook-ID namespacing, catch-up clamp, and CLI signatures are all pinned by name with `path:line`-level concreteness. The bundle mechanism is correctly framed as a packaging convention over the existing 5-kind registration surface rather than a new primitive, which keeps the four-concept core sealed. The two new gotchas come with `enforced_at:` paths (deferred-status flagged honestly), and the new behavior matrix is the right substrate-shape pin. The biggest remaining gap is a count drift inside `sdk-surface.md` itself: §"Runtime" `@dome/sdk/cli` still says "**seven** `dome*` command functions" while every other surface says **nine**. None of the findings rises to a defect that would mis-implement the design, so the verdict is Approved with three Medium items to close in the same worktree.

## Delta at a glance

(Quoted verbatim from the ledger. Note: I3 below flags that the preamble itself diverges from the canonical 8-bullet shape; the fix is in scope for the same-worktree close.)

## Blocking issues

None.

## Important issues

### I1. SDK runtime entrypoint description still says "seven `dome*` command functions"

- **Severity:** Medium
- **Category:** Spec drift
- **Why it matters:** A future contributor reading `sdk-surface.md` §"Runtime" to learn what the `@dome/sdk/cli` entrypoint exports will think the CLI surface has seven commands. Every other surface in this rewrite says nine. The `cli-shell-shape` lockstep test catches this only after a wrong shape ships.
- **Evidence:** `sdk-surface.md:576` — `\`@dome/sdk/cli\` — **CLI shell**. \`runCli\`, the seven \`dome*\` command functions, ...`. Conflicts with `cli.md:12`, `:259`, `:283`, `:298`.
- **Recommended fix:** Edit `sdk-surface.md:576` to read `... the nine \`dome*\` command functions, ...`. Optionally enumerate: `(domeInit, domeMigrate, domeServe, domeReconcile, domeLint, domeStats, domeDoctor, domeRunHook, domeExportContext)`.
- **Substrate artifact to add or update:** spec (`sdk-surface.md`).

### I2. `hello-world` bundle row marked `Status: shipped` despite living at `tests/fixtures/extensions/`, not `assets/extensions/`

- **Severity:** Medium
- **Category:** Spec drift / Enforcement
- **Why it matters:** The matrix's lockstep iterates `shipped` rows looking up `assets/extensions/<bundle>/`. hello-world lives at `tests/fixtures/extensions/`. Lockstep silently drops coverage, crashes, or is special-cased — all worse than naming the distinction in the Status column.
- **Evidence:** `extension-bundle-shape.md:12` (lockstep cites `assets/extensions/`) vs `:35` (hello-world `Status: shipped`).
- **Recommended fix:** Introduce a distinct Status value `test-fixture` for hello-world (or add a sibling `Location` column). Update the lockstep-status paragraph to enumerate the Status values.
- **Substrate artifact to add or update:** behavior matrix (`extension-bundle-shape.md`).

### I3. Delta-at-a-glance preamble diverges from the canonical 8-category itemized authoring rule

- **Severity:** Low
- **Category:** Spec drift
- **Why it matters:** The canonical contract requires the preamble to render every bullet as a count-or-name list across exactly 8 categories. The ledger's preamble is one dense prose paragraph; "Tests proposed" and "Deferred" categories are omitted from the preamble. Future tooling that quotes the preamble verbatim will quote dense prose instead of 8 scannable lines.
- **Evidence:** `docs/cohesive/delta-ledgers/2026-05-26-dome-hooks-phase-0-1-skeleton.md:9-23` (preamble) vs the canonical contract at `references/templates/design-delta-ledger.md §"Authoring rules"`.
- **Recommended fix:** Rewrite the preamble as 8 bullets matching the contract. Keep Classification as a leading line or a 9th bullet. Add explicit `Tests proposed:` and `Deferred:` bullets.
- **Substrate artifact to add or update:** delta-ledger preamble.

## Substrate gaps

- No `upserted-section` Effect variant in the Effect union. `upsertSection` produces `wrote-document` Effects; section-key-aware projection deferred.
- No event-projection row for `hook.manual.invoked` in `event-types-and-payloads.md` (acknowledged by ledger as implementation-pass concern; correctly out of scope here).
- §"Adding a new extension bundle" recipe doesn't name "add a row to `extension-bundle-shape.md`" as an explicit step (the "Adding a new invariant" recipe has analogous matrix-row discipline).

## Locality concerns

The bundle mechanism keeps locality intact. The only edge: bundle-contributed CLI commands collide flat-namespace with shipped commands; the `cli-collision` taxonomy entry documents the fail-loud handling. Future pressure (e.g., `dome dailies migrate` instead of `dome migrate-dailies`) is acknowledged via the error taxonomy entry.

## Future-fit concerns

The rewrite cleanly separates "v0.5 ships" from "v0.5.1+ extends": programmatic-form bundle hooks, bundle-contributed Tools, `dome install-extension`, `manifest.yaml deps:` resolution, npm distribution, and the matrix lockstep itself are all flagged as deferred. The "anticipated" rows in the matrix are clearly tagged.

## Enforcement concerns

`AGENTS_MD_IS_ORIENTATION_SURFACE` extension is well-enforced (fourth invariant test, `dome doctor` drift report, `--repair` regeneration). The two new gotchas carry `enforced_at:` paths with `enforced_at_status: deferred` honestly. The bundle-loader error taxonomy is structurally fenced (single kind + discriminator).

## Behavior knowable outside implementation?

Mostly yes. Two minor corners require reading code:

- The dispatcher's matching priority when a hook subscribes to both `event:` and `schedule:` (dedupe? both fire?) is not specified.
- The "mutually exclusive in spirit, both allowed" phrasing at `hooks.md:69` resolves later in the spec but the inline YAML comment doesn't say so.

## Vague language to tighten

- `hooks.md:69` YAML comment — tighten "mutually exclusive in spirit, both allowed" to "can coexist with `event:` — hook fires on either trigger".
- Ledger stable ID `hooks-adding-a-new-hook-four-forms` is stale (spec body correctly says 5 forms). Rename to `hooks-adding-a-new-hook-five-forms` when the ledger preamble is rewritten per I3.

## Recommended repairs (ranked)

1. Fix I1 — one-line edit at `sdk-surface.md:576` ("seven" → "nine").
2. Fix I2 — split `Status: shipped` into `shipped` vs `test-fixture` in `extension-bundle-shape.md`.
3. Fix I3 — rewrite the delta-ledger preamble as 8 bullets per canonical contract.
4. Add `extension-bundle-shape.md` row addition as a 9th step in §"Adding a new extension bundle" recipe.

## What looked right

- Bundle-loader error taxonomy (one kind + discriminator) is a model future-extensibility pattern.
- Hook-ID namespacing is structural-by-construction.
- The four-concept core stays sealed; bundles are correctly framed as a packaging convention.
- `enforced_at_status: deferred` is honest; the gotchas point at planned-not-yet-shipped tests transparently.
- Scheduled-hook idempotency gotcha captures both failure directions (over-fire and under-fire) with concrete scenarios; the at-most-once-per-reconcile clamp is the right v0.5 default.

## Next

**Disposition:** Close in same worktree → merge.
