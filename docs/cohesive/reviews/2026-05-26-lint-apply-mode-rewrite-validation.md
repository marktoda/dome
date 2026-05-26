# Rewrite Validation Review — `dome lint --apply <id>` mode

**Reviewer:** spec-cohesion-reviewer (fresh-eyes context)
**Date:** 2026-05-26
**Subject:** Four rewritten files (`docs/wiki/specs/cli.md`, `docs/wiki/specs/prompts-and-workflows.md`, `docs/wiki/matrices/intent-prompt-tools.md`, `src/prompts/builtin/lint.md`) per `docs/cohesive/delta-ledgers/2026-05-26-lint-apply-mode.md`.

**Verdict:** Approved

## Executive judgment

A future contributor could read these four files and implement `dome lint --apply` without consulting the original architect. The two-mode contract is named on every surface that touches it: tool list (3 files agree byte-for-byte), filename convention (`lint-report-YYYY-MM-DD.md`, 4 files agree), id shape (`<severity-letter><index>`), and annotation shape (`Applied:` / `Apply-failed:`) are all consistent across `cli.md`, the workflow row in `prompts-and-workflows.md`, the matrix row, and the executable prompt. The single biggest gap: the `(advisory)` tag is normative behavior — apply mode refuses advisory findings — but `cli.md` never mentions it, so a CLI user can hit a refusal whose mechanism is invisible from the user-facing spec.

## Architectural reflection

The lock holds. The two-mode lint shape sits cleanly on top of the existing migrate parallel — the spec doesn't grow a new pattern; it ratifies one that was already in the system. The substrate's prompt-as-contract principle is reinforced: the executable behavior (the workflow prompt) and the user-facing surface (cli.md) describe the same modes in the same vocabulary, with the matrix row tying them. A future contributor reading any one of the four files can navigate to the others.

- **Easier downstream:** Future workflows that need a propose-then-apply shape (e.g., a hypothetical `dome health --repair`) inherit a worked parallel — migrate first, lint second; the third instance has two precedents to lean on rather than one. Finding-id + annotation contract is reusable.
- **Harder downstream:** The lint tool surface now includes `moveDocument` and `deleteDocument`. Any future invariant that restricts which workflows can delete content has to enumerate lint alongside migrate. The two-mode dispatch lives in the workflow prompt (user-message shape selects mode), not in a typed CLI contract — a future second-mode workflow has to repeat that pattern in its own prompt.
- **Load-bearing on memory:** The same-id-across-passes idempotency rule (I2) lives in the prompt body, not in a structural enforcement; a prompt regression silently breaks it. Recommended repair adds the explicit "walk all `Pass N` sections" language, but the enforcement remains prompt-shape, not type/test/lint-shape.

## Delta at a glance

*Quoted verbatim from ledger §"Delta at a glance":*

> This rewrite is **Mixed**. Design-layer changes: `cli.md` lint section, `prompts-and-workflows.md` lint row, `intent-prompt-tools.md` lint row. Implementation changes: `src/prompts/builtin/lint.md` (the workflow's executable behavior; SDK code remains untouched in this pass per the Build-gate scope).
>
> - **Files:** 4 rewritten, 1 added (this ledger), 0 removed/deprecated
> - **Conceptual changes:** Two-mode `lint` workflow (propose / apply); stable finding-id contract (`<severity-letter><index>`); apply-time annotation contract (`Applied:` / `Apply-failed:`); report filename standardized to `lint-report-YYYY-MM-DD.md` (matches ship reality; replaces the spec's aspirational `lint-pass-YYYY-MM-DD.md`)
> - **Named invariants:** none added, none changed (existing `EVERY_WRITE_IS_LOGGED` already covers apply-mode mutations; existing `MARKDOWN_IS_SOURCE_OF_TRUTH` already covers report-as-truth)
> - **Behavior matrices:** `intent-prompt-tools.md` (lint row's Tools and Effects cells updated)
> - **Gotchas:** none added (apply-mode mid-merge guard reuses the `dirty-git-state-at-reconcile` gotcha by reference)
> - **Semantic linters:** none
> - **Tests proposed:** CLI surface tests under `tests/cli/lint.test.ts` covering (a) propose-mode invocation with empty user message, (b) apply-mode `--apply H1` plumbing the user message correctly, (c) apply-mode `--apply H1 --apply H2` collecting multiple ids, (d) refusal when no report exists. Workflow-prompt tests via the existing `tests/prompts/` fixture pattern: a fixture lint report + a `apply H1` user message exercises the report-locate / id-find / annotation flow without full vault setup.
> - **Deferred (out of scope this pass):** (1) Whether `dome doctor` gains a corresponding `--repair` mode for re-templating `AGENTS.md` is hinted at `cli.md:30` but is a separate piece of work. (2) Whether the `clock` event source is wired today (so `clock:weekly` triggers the lint workflow under a running `dome serve`) is a separate audit; this rewrite assumes the trigger surface from `prompts-and-workflows.md:61` is honored or will be. (3) An `--apply --all` shorthand to apply every non-advisory finding from the latest report is a natural extension but adds a "trust the propose pass entirely" UX that's heavier than this pass should commit to.

## Blocking issues

None. Highest severity is Medium; verdict is Approved per the rubric.

## Important issues

### I1. `(advisory)` tag is normative but invisible from `cli.md`

- **Severity:** Medium
- **Category:** Spec drift
- **Why it matters:** `lint.md:48,58` makes the advisory tag a load-bearing apply-mode refusal: apply mode refuses any finding carrying `(advisory)`. A CLI user who runs `dome lint --apply M3` against an advisory finding will hit a refusal whose mechanism is undocumented in the user-facing spec. The CLI surface fully describes failure modes (a), (b), (c) at `cli.md:131` but omits this fourth: advisory refusal. A reader of `cli.md` alone cannot predict it.
- **Evidence:** `src/prompts/builtin/lint.md:48` ("mark the finding `(advisory)` in the severity tag — apply mode will refuse to execute advisory findings"); `src/prompts/builtin/lint.md:58` ("If the finding is annotated `(advisory)`, refuse"); `docs/wiki/specs/cli.md:111-114` (propose-mode finding shape — no mention of `(advisory)`); `docs/wiki/specs/cli.md:131` (apply-mode failure list — three reasons, advisory absent).
- **Recommended fix:** Add `(advisory)` to the propose-mode finding shape at `cli.md:112` ("...a stable id, a one-line title, an optional `(advisory)` tag for findings that require human judgment..."), and add an "(d) the finding is marked `(advisory)`" clause to the apply-mode failure list at `cli.md:131`.
- **Substrate artifact to add or update:** spec (`cli.md`)

### I2. Same-id-across-passes idempotency walks only the most recent pass

- **Severity:** Medium
- **Category:** Invariant
- **Why it matters:** Ledger §"Remaining ambiguity" line 111 flags this directly: if Pass 1's `H1` recorded `Applied: 2026-05-26T10:00:00Z` and Pass 2 (same date) promoted a new finding to `H1` without that annotation, the apply-mode prompt at `lint.md:57` says "use the most recent `Pass N` section's entry" — and the idempotency check at `lint.md:58` runs against that entry only. Result: the same finding-shape can be applied twice on the same date, breaking the idempotency contract that `cli.md:130` promises ("a re-apply against an already-applied finding refuses with exit nonzero rather than mutating twice"). The promotion-across-passes case is rare but the contract has to hold for it because `EVERY_WRITE_IS_LOGGED` will produce duplicate audit entries the user cannot reconcile.
- **Evidence:** `src/prompts/builtin/lint.md:57-58` (resolution uses most-recent pass only); `docs/wiki/specs/cli.md:130` (idempotency contract is unconditional); `docs/cohesive/delta-ledgers/2026-05-26-lint-apply-mode.md:111` (self-flagged).
- **Recommended fix:** Tighten `lint.md:58` to walk ALL `Pass N` sections for the id when checking idempotency: "If any `Pass N` entry for this id is annotated `Applied:`, refuse — apply is per-finding-shape, not per-pass." Keep recommendation-resolution scoped to the most recent pass.
- **Substrate artifact to add or update:** prompt (`src/prompts/builtin/lint.md`)

### I3. Multi-id failure semantics inconsistent between `cli.md` and `lint.md`

- **Severity:** Medium
- **Category:** Spec drift
- **Why it matters:** `lint.md:65` is explicit: "A failed apply does not abort the remaining ids." `cli.md:131` describes single-apply exit code semantics ("Exits 0 on success; nonzero if...") but is silent on what happens when one id in a `--apply H1 --apply H2` invocation fails. Does the CLI exit 0 because H2 succeeded? Nonzero because H1 failed? A reader implementing the CLI surface from `cli.md` alone cannot tell, and the workflow prompt's contract may not survive the CLI's exit-code handling.
- **Evidence:** `src/prompts/builtin/lint.md:65`; `docs/wiki/specs/cli.md:131` (single-apply only).
- **Recommended fix:** Add one sentence to `cli.md` apply-mode section: "When multiple ids are passed, apply proceeds through the list independently; the CLI exits nonzero if any id failed, with a per-id summary on stderr."
- **Substrate artifact to add or update:** spec (`cli.md`)

### I4. Preamble omits tool-surface expansion from conceptual changes

- **Severity:** Low
- **Category:** Spec drift
- **Why it matters:** The ledger preamble enumerates 4 conceptual changes (two-mode workflow; stable id; annotation contract; filename). The body's "Conceptual changes" table at lines 54-60 carries 5 rows — the 5th being the tool-surface expansion from `{read,search,wikilink,write,log}` to `{read,search,wikilink,write,move,delete,log}`. The expansion is a real conceptual change (it commits the workflow to mutations it previously couldn't perform). Reader of the preamble alone would underrate the change's scope.
- **Evidence:** `docs/cohesive/delta-ledgers/2026-05-26-lint-apply-mode.md:14` (preamble — 4 items); lines 54-60 (body table — 5 rows).
- **Recommended fix:** Add "expanded lint tool surface to include `moveDocument` and `deleteDocument` (matches what apply-mode requires; matches `sdk-surface.md:131`)" to the preamble's Conceptual changes bullet.
- **Substrate artifact to add or update:** ledger preamble

## Substrate gaps

- **No regression test pinned for the same-id-across-passes idempotency case.** Ledger §"Tests proposed" enumerates 6 workflow-prompt fixtures — none covers the Pass 1 `Applied:` + Pass 2 same-id scenario. Add a 7th: apply mode against a fixture report where `H1` was Applied in Pass 1 and re-promoted in Pass 2 refuses.

## Locality concerns

None added. The change keeps the lint workflow's behavior in the prompt (where it belongs per the prompts-as-contract principle in `prompts-and-workflows.md:122`); the CLI stays a thin dispatcher. The mid-merge guard lives in the CLI layer (parallel to `dome reconcile`), not duplicated in the prompt — correct locality choice.

## Future-fit concerns

None. The `--apply --all` extension is correctly deferred (ledger §"Deferred" item 3) with a stated reason ("trust the propose pass entirely" is heavier UX). Scheduled apply is explicitly excluded for v0.5 with rationale (`cli.md:137`).

## Enforcement concerns

- **`EVERY_WRITE_IS_LOGGED` covers apply-mode mutations** — auto-enforced by `writeDocument` / `moveDocument` / `deleteDocument` per `sdk-surface.md:124,128,129`. Solid.
- **Idempotency contract has no structural enforcement** beyond the prompt's check at `lint.md:58`. A prompt regression would silently break it. The ledger §"Tests proposed" workflow-prompt fixtures cover the basic case, which is the right enforcement for a prompt-shaped behavior. The Pass-N walk per I2 needs a fixture to match.

## Behavior knowable outside implementation?

Yes. The two-mode finding-id + annotation contract is reproducible from `cli.md` + `lint.md` alone. The minor advisory-tag gap (I1) is the one place where a CLI-only reader would miss normative behavior.

## Vague language to tighten

None in normative sections. `cli.md:137` carries "should" but in a v0.5-policy declarative context ("fixes that mutate the vault should pass through a human") — acceptable as a policy statement, not a TODO.

## Recommended repairs (ranked)

1. Add `(advisory)` to `cli.md` propose-mode finding shape and apply-mode failure list (I1).
2. Tighten `lint.md:58` idempotency check to walk all `Pass N` sections (I2); add fixture per substrate gap.
3. Specify multi-id exit-code semantics in `cli.md` apply-mode (I3).
4. Patch the ledger preamble to enumerate the tool-surface expansion (I4).

## What looked right

- **Three-surface tool-list agreement byte-for-byte** — `prompts-and-workflows.md:61`, `intent-prompt-tools.md:23`, and `lint.md` frontmatter line 4 all carry `[readDocument, searchIndex, wikilinkResolve, writeDocument, moveDocument, deleteDocument, appendLog]` in identical order. Easy to miss; consequential when a reviewer reads the matrix as the audit surface.
- **Filename rename is honest** — the ledger explicitly calls out that `lint-report-YYYY-MM-DD.md` matches ship reality and replaces the spec's aspirational `lint-pass-YYYY-MM-DD.md`. Naming the prior aspiration in the conceptual-changes table prevents the next reader from thinking the rename was arbitrary.
- **Self-flagged ambiguities in the ledger §"Remaining ambiguity"** — the rewriter pre-identified the same-id-across-passes case (I2) and the cross-date id continuity case as worth pressure-testing. That's exactly the contract `Remaining ambiguity` exists for; the reviewer's job is easier when the punch list is pre-seeded.

---

**File paths referenced in this review:**
- `/Users/mark.toda/dev/dome/.claude/worktrees/design+lint-apply-mode/docs/cohesive/delta-ledgers/2026-05-26-lint-apply-mode.md`
- `/Users/mark.toda/dev/dome/.claude/worktrees/design+lint-apply-mode/docs/wiki/specs/cli.md`
- `/Users/mark.toda/dev/dome/.claude/worktrees/design+lint-apply-mode/docs/wiki/specs/prompts-and-workflows.md`
- `/Users/mark.toda/dev/dome/.claude/worktrees/design+lint-apply-mode/docs/wiki/matrices/intent-prompt-tools.md`
- `/Users/mark.toda/dev/dome/.claude/worktrees/design+lint-apply-mode/src/prompts/builtin/lint.md`
- `/Users/mark.toda/dev/dome/.claude/worktrees/design+lint-apply-mode/docs/wiki/specs/sdk-surface.md` (cross-reference verified at line 131)
