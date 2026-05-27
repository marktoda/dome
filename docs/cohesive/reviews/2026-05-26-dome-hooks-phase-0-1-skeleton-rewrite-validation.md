# Rewrite Validation Review — Dome hooks Phase 0 + Phase 1 skeleton

**Reviewer:** spec-cohesion-reviewer (fresh-eyes context)
**Date:** 2026-05-27
**Pass:** 1
**Subject:** rewritten specs at `docs/wiki/specs/{sdk-surface,hooks,cli,vault-layout,page-schema}.md`, the invariant `AGENTS_MD_IS_ORIENTATION_SURFACE.md`, `docs/index.md`, the new gotchas `extension-bundle-load-order.md` + `scheduled-hook-idempotency.md`, and the new matrix `extension-bundle-shape.md`. Delta ledger at `docs/cohesive/delta-ledgers/2026-05-26-dome-hooks-phase-0-1-skeleton.md`.

**Verdict:** Issues Found

## Executive judgment

The bundle mechanism is well-conceived and the load-order/idempotency gotchas anchor the dangerous corners. The brand-new substrate (extension-bundle-shape matrix, the two gotchas, the AGENTS.md preamble-fragment extension) is internally coherent and tied to its enforcement story via `enforced_at:` anchors. The rewrite breaks on three execution-level cohesion failures that a future contributor cannot reconcile from the docs alone: a Tool-count drift across `sdk-surface.md` where the catalog grew to 8 but five surrounding prose sites still read "seven", an event-name disagreement inside `hooks.md` (`clock.tick.<hook-id>` vs `clock.tick.<interval>`) that the dispatcher matcher would need pinned, and a "Four forms" / five-bulleted-forms count divergence in the §"Adding a new hook" recipe. The Delta-at-a-glance preamble file count also diverges from the ledger's own body. These are not design failures — the direction is sound — they are rewrite-pass completeness failures that block implementation because the ledger's claims are the contract the implementer codes against.

## Delta at a glance

**Classification:** **Mixed.** Design-layer changes: (a) the **extension-bundle mechanism** lands as a new packaging convention over the existing 5-kind registration surface; (b) the **`upsertSection` Tool** bumps the canonical catalog from seven Tools to eight; (c) **schedule-driven hooks** land as an extension to declarative-hook YAML; (d) **AGENTS.md preamble fragments** extends the `AGENTS_MD_IS_ORIENTATION_SURFACE` invariant; (e) the **`dome run-hook` CLI command** lands as the 9th shipped command; (f) the **`daily` and `weekly` page types** land as bundle-contributed types; (g) **`.dome/extensions/<bundle>/` directory** lands in `vault-layout.md`; (h) two new gotchas — `extension-bundle-load-order.md` and `scheduled-hook-idempotency.md`; (i) one new behavior matrix — `extension-bundle-shape.md`.

**Files:** preamble says 7 substrate rewritten + 3 added; body header line 67 says `### Substrate rewritten (9 files)` (the body enumerates 7 actual files — header is wrong).

**Conceptual changes:** extension bundles as a packaging convention over the 5-kind registration surface; schedule-driven hooks; manual hook invocation (`dome run-hook`); idempotent marker-delimited section updates (`upsertSection`); first-party `dailies` bundle as proof case.

## Blocking issues

### B1. Delta-ledger preamble file count diverges from the ledger body

- **Severity:** Blocker
- **Category:** Spec drift
- **Why it matters:** This preamble is what `validate-rewrite` quotes verbatim to the user at decision time. The preamble claims "7 substrate files rewritten" but the body's heading at line 67 reads `### Substrate rewritten (9 files)`. A reader can't tell which is canonical.
- **Evidence:** `docs/cohesive/delta-ledgers/2026-05-26-dome-hooks-phase-0-1-skeleton.md:12` (preamble "7 substrate files rewritten ... 3 substrate files added") vs `:67` (`### Substrate rewritten (9 files)`). The body actually enumerates 7 files — the body header itself is the wrong number.
- **Recommended fix:** Edit the body header at line 67 from `### Substrate rewritten (9 files)` to `### Substrate rewritten (7 files)`.
- **Substrate artifact to add or update:** ledger body (`design-delta-ledger §Files rewritten`).

### B2. `sdk-surface.md` Tool count: catalog says 8, surrounding prose still says 7

- **Severity:** High
- **Category:** Spec drift
- **Why it matters:** A reader cannot tell whether the SDK ships 7 or 8 Tools. Five sites still say "seven" or "the seven Tools" after the rewrite, against the 8-row catalog table. This isn't surface polish — the count is the contract the registry, MCP_TOOL_NAMES tuple, AI-SDK ToolSet projection, and frontmatter-validator Zod enum derive from.
- **Evidence:**
  - `sdk-surface.md:32` — `tools: BoundToolSurface — the seven Tools curried with this Vault and the privileged writer.`
  - `sdk-surface.md:190` — `Canonical input/output shapes for the seven Tools.` (followed by eight signature blocks including `upsertSection`)
  - `sdk-surface.md:392` — Tiered model `Axioms` row: `The 7 Tools.`
  - `sdk-surface.md:466` — `**Tools** — the seven mutation primitives via the `BoundToolSurface`...`
  - `sdk-surface.md:557` — Distribution: `core. Vault, Document, the seven Tools, Hook ...`
- **Recommended fix:** Replace "the seven Tools" / "the 7 Tools" / "seven mutation primitives" with the corresponding "eight" forms at each of the five sites.
- **Substrate artifact to add or update:** spec (`sdk-surface.md`).

### B3. Recipe label "Adding an 8th Tool" stale; catalog now ships 8, next is 9th

- **Severity:** High
- **Category:** Spec drift
- **Why it matters:** Two sibling recipes (§"Adding a new invariant", §"Adding a new extension bundle") say they parallel "the 'Adding an 8th Tool' recipe." After this rewrite, the recipe in §"Tool catalog is one declarative array" correctly reads "Adding a 9th Tool" — but the cross-references point at the *prior* recipe name. `cli.md:259` also references "Adding an 8th Tool is two file edits".
- **Evidence:**
  - `sdk-surface.md:184` — `Adding a 9th Tool in v0.5.1 / v1+ is two file edits` (correct)
  - `sdk-surface.md:404` — `Three file edits, paralleling the "Adding an 8th Tool" recipe in §"Tool catalog is one declarative array"` (stale)
  - `sdk-surface.md:438` — `Three file edits at minimum, ... Paralleling the "Adding an 8th Tool" and "Adding a new invariant" recipes` (stale)
  - `cli.md:259` — `paralleling the "Adding an 8th Tool is two file edits" recipe at [[wiki/specs/sdk-surface]] §"Tool catalog is one declarative array"` (stale)
- **Recommended fix:** Rename all three cross-references to "Adding a 9th Tool" to match the canonical recipe label.
- **Substrate artifact to add or update:** specs (`sdk-surface.md`, `cli.md`).

### B4. `hooks.md` §"Adding a new hook" stated count vs enumerated forms diverges

- **Severity:** High
- **Category:** Spec drift
- **Why it matters:** Line 110 says "Four forms by mechanism; one rule by shape." Five form-headings follow.
- **Evidence:** `hooks.md:110` ("Four forms by mechanism") vs `:112,:119,:125,:127,:129` (five `**…form**` paragraphs: Declarative event-reactive, Declarative schedule-driven, Programmatic v0.5.1+, Bundle-contributed, Shipped-default).
- **Recommended fix:** Change the preamble line from "Four forms by mechanism" to "Five forms by mechanism".
- **Substrate artifact to add or update:** spec (`hooks.md`).

### B5. Schedule-driven hook event-name disagreement: `clock.tick.<hook-id>` vs `clock.tick.<interval>`

- **Severity:** High
- **Category:** Domain model
- **Why it matters:** The dispatcher matcher dispatches by event name. Two sites in `hooks.md` name the schedule-fire event differently. The dispatcher's match-by-ID logic in `phase-0e-dispatch-by-hook-id` (from the ledger) explicitly relies on the event payload's `hookId`; the `<interval>` form has no such field.
- **Evidence:**
  - `hooks.md:83` — `synthesizes \`clock.tick.<hook-id>\` events when intervals elapse`
  - `hooks.md:208` — `The scheduler synthesizes \`clock.tick.<hook-id>\` events`
  - `hooks.md:275` — Phase 3 pseudocode: `fire clock.tick.<interval>` and `scheduled.json[handler].last_fire = now` (using `<interval>`)
- **Recommended fix:** Reconcile to `clock.tick.<hook-id>` consistently. Update Phase 3 pseudocode.
- **Substrate artifact to add or update:** spec (`hooks.md`).

## Important issues

### I1. `scheduled-hook-idempotency.md` references undefined `dome backfill-daily <range>` command

- **Severity:** Medium
- **Category:** Spec drift
- **Why it matters:** Line 36 references a command that exists nowhere else in the substrate. A reader following the gotcha's reassurance finds no such command.
- **Evidence:** `scheduled-hook-idempotency.md:36`.
- **Recommended fix:** Either add `backfill-daily` as a bundle-contributed CLI command, or replace the sentence with the `dome run-hook dailies:create-daily --event.path=...` v0.5 path, or mark as deferred.
- **Substrate artifact to add or update:** gotcha (`scheduled-hook-idempotency.md`).

### I2. `extension-bundle-shape.md` mixes shipped + Phase 3/4 anticipated rows without lockstep-safe distinction

- **Severity:** Medium
- **Category:** Future-fit
- **Why it matters:** The §"Lockstep status" says v0.5.1 parses the matrix and asserts each named filename corresponds to an actual file. When the lockstep ships, `aggregation` and `recall` rows fail it. The matrix encodes future pressure as if normative.
- **Evidence:** `extension-bundle-shape.md:35-36` (concrete filenames for `aggregation` and `recall`) vs `:12` (lockstep parses the matrix).
- **Recommended fix:** Add a `Status` column (shipped/anticipated) with lockstep skipping anticipated rows; or split into two tables.
- **Substrate artifact to add or update:** matrix (`extension-bundle-shape.md`).

### I3. Bundle-loader error taxonomy split across three names without a canonical home

- **Severity:** Medium
- **Category:** Domain model
- **Why it matters:** Three distinct error kinds appear (`bundle-load-failure`, `bundle-name-mismatch`, `bundle-page-type-collision`); no single spec enumerates the bundle-loader error vocabulary.
- **Evidence:** `sdk-surface.md:354` (`bundle-name-mismatch`), `:367` (`bundle-load-failure`); `extension-bundle-load-order.md:30` (`bundle-page-type-collision` mentioned as the alternative, `bundle-load-failure` chosen).
- **Recommended fix:** Consolidate to one `bundle-load-failure` kind with a `detail:` discriminator; rewrite cross-references.
- **Substrate artifact to add or update:** spec (`sdk-surface.md` §"Extension bundles").

### I4. MCP `instructions` channel parity with AGENTS.md preamble fragments unaddressed

- **Severity:** Medium
- **Category:** Future-fit
- **Why it matters:** AGENTS_MD extends to include preamble fragments. `cli.md:30` says MCP `instructions` mirrors AGENTS.md. The rewrite doesn't say whether `instructions` also mirrors preamble fragments.
- **Evidence:** `AGENTS_MD_IS_ORIENTATION_SURFACE.md:17` (preamble fragments threaded) vs `cli.md:30` (MCP mirrors AGENTS.md) with no explicit propagation statement.
- **Recommended fix:** Add a line to AGENTS_MD §"Operational notes" stating MCP `instructions` is regenerated alongside AGENTS.md and carries the same bundle-fragment threading.
- **Substrate artifact to add or update:** invariant (`AGENTS_MD_IS_ORIENTATION_SURFACE.md`).

### I5. `extension-bundle-shape.md` mentions a nonexistent `dome install-extension` workflow

- **Severity:** Low
- **Category:** Vague language
- **Why it matters:** Line 26 references `dome install-extension` as if normative; `sdk-surface.md` correctly marks it as deferred-to-v0.5.1.
- **Evidence:** `extension-bundle-shape.md:26` vs `sdk-surface.md:380`.
- **Recommended fix:** Remove the sentence or rephrase as future-pressure annotation.
- **Substrate artifact to add or update:** matrix (`extension-bundle-shape.md`).

## Recommended repairs (ranked)

1. **B1 + B2 + B3.** One pass through `sdk-surface.md` updating Tool count from 7 to 8 at five sites and renaming "Adding an 8th Tool" cross-references to "Adding a 9th Tool" at three sites; fix the ledger body header from 9 to 7; fix `cli.md:259` recipe-cross-reference.
2. **B4.** One-character fix in `hooks.md:110` ("Four" → "Five").
3. **B5.** Reconcile the scheduled-hook event name to `clock.tick.<hook-id>` in Phase 3 pseudocode.
4. **I1.** Replace the `backfill-daily` reference with the v0.5 `run-hook` escape hatch.
5. **I2 + I5.** Tighten the matrix (Status column with shipped/anticipated; remove install-extension mention).
6. **I3.** Enumerate the bundle-loader error vocabulary in one place.
7. **I4.** One-line addition to invariant §"Operational notes".

## What looked right

- `extension-bundle-shape.md` is the right substrate pin — a matrix that names which file in each bundle contributes which kind is exactly the right structural surface.
- The two new gotchas are scoped tightly to their structural mitigations; each carries `enforced_at:` + `enforced_at_status: deferred`.
- Hook-ID namespacing as a structural fence (rather than soft convention) — cross-bundle collision is impossible by construction.
- AGENTS.md preamble fragment threading is well-anchored — fourth test in the invariant's §"Test guarantee" covers the full install/render/removal cycle.
- Bundle mechanism correctly framed as not-a-new-primitive — preserves the four-concept core.

## Next

**Disposition:** Repair → re-validate.
