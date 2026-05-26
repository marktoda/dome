# Design Delta Ledger — `dome lint --apply <id>` mode

**Date:** 2026-05-26
**Worktree / branch:** `.claude/worktrees/design+lint-apply-mode` on `design/lint-apply-mode`
**Approved direction:** Add `--apply <id>` mode to `dome lint`, mirroring the `dome migrate --apply` plan-then-apply pattern already spec'd at `wiki/specs/cli.md:46-53` and `wiki/specs/prompts-and-workflows.md:62`. Propose mode (default) writes a structured report under `inbox/review/lint-report-YYYY-MM-DD.md`; apply mode executes a single named recommendation against the most recent report.

This rewrite closes a spec/implementation gap. The migrate workflow already commits to "Plan first; apply on `--apply`"; the lint workflow promises the same shape ("applying proposed fixes is safe") but never named a confirmation mechanism. The CLI's `dome lint` command passed an empty user message to the workflow with no way to convey "apply X," and the workflow's prompt told the agent "Do not apply fixes without user confirmation" without naming what confirmation looks like. The agent filled the gap by hallucinating a `--apply` flag in its own report's closing recommendation. This rewrite makes the flag real, names the protocol, and aligns the lint tool surface with what apply-mode requires.

## Delta at a glance

This rewrite is **Mixed**. Design-layer changes: `cli.md` lint section, `prompts-and-workflows.md` lint row, `intent-prompt-tools.md` lint row. Implementation changes: `src/prompts/builtin/lint.md` (the workflow's executable behavior; SDK code remains untouched in this pass per the Build-gate scope).

- **Files:** 4 rewritten, 1 added (this ledger), 0 removed/deprecated
- **Conceptual changes:** Two-mode `lint` workflow (propose / apply); stable finding-id contract (`<severity-letter><index>`); apply-time annotation contract (`Applied:` / `Apply-failed:`); report filename standardized to `lint-report-YYYY-MM-DD.md` (matches ship reality; replaces the spec's aspirational `lint-pass-YYYY-MM-DD.md`); expanded lint tool surface to include `moveDocument` and `deleteDocument` (matches what apply-mode requires; matches `sdk-surface.md:131`'s commitment to "lint proposes deleting orphan pages")
- **Named invariants:** none added, none changed (existing `EVERY_WRITE_IS_LOGGED` already covers apply-mode mutations; existing `MARKDOWN_IS_SOURCE_OF_TRUTH` already covers report-as-truth)
- **Behavior matrices:** `intent-prompt-tools.md` (lint row's Tools and Effects cells updated)
- **Gotchas:** none added (apply-mode mid-merge guard reuses the `dirty-git-state-at-reconcile` gotcha by reference)
- **Semantic linters:** none
- **Tests proposed:** CLI surface tests under `tests/cli/lint.test.ts` — (a) propose-mode invocation passes empty user message to runWorkflowAtPath, (b) apply-mode `--apply H1` passes `apply H1`, (c) multi-id `--apply H1 --apply H2` passes `apply H1 H2`, (d) `--apply ""` rejected with a usage error before workflow dispatch, (e) mid-merge refusal — `domeLint(target, opts, ["H1"])` against a vault with `.git/MERGE_HEAD` returns a validation error.
- **Deferred (out of scope this pass):** (1) Whether `dome doctor` gains a corresponding `--repair` mode for re-templating `AGENTS.md` is hinted at `cli.md:30` but is a separate piece of work. (2) Whether the `clock` event source is wired today (so `clock:weekly` triggers the lint workflow under a running `dome serve`) is a separate audit; this rewrite assumes the trigger surface from `prompts-and-workflows.md:61` is honored or will be. (3) An `--apply --all` shorthand to apply every non-advisory finding from the latest report is a natural extension but adds a "trust the propose pass entirely" UX that's heavier than this pass should commit to. (4) **Workflow-prompt fixture tests** under `tests/prompts/lint/` — the 7 fixtures originally listed (no-findings propose, apply-H1 success + Applied annotation, already-applied refusal, advisory refusal, non-existent-id refusal, no-report refusal, cross-pass idempotency walk per the I2 repair). Deferred because `tests/prompts/` today contains only frontmatter / loader / registry tests; no fixture-driven workflow-execution harness exists. The harness is a separate piece of work. Until it lands, the prompt-side contracts (idempotency walk across passes, advisory refusal, report-locate by lexical filename) live as prose in `src/prompts/builtin/lint.md` without a structural backstop — known gap. (5) **Outcome-interpretation regression test** for the multi-id exit-code derivation in `cli.ts` — exercises whether a workflow summary containing `apply-failed`/`refused` correctly drives the CLI to a nonzero exit. The current TC suite covers user-message construction; this would cover summary-text interpretation. Requires either a mock model that returns a constructed failure summary plus the ability to invoke the full action callback (not just `domeLint`), or a refactor that lifts outcome derivation into `domeLint`'s return value (the locality recommendation from the structure review). Deferred as a follow-up alongside the workflow-prompt fixture harness.

## Files rewritten

- `docs/wiki/specs/cli.md` (lines 98-113 → expanded)
  - **Before:** Single-section `dome lint` description — propose-only, no named confirmation mechanism, "applying proposed fixes is safe" without naming who applies them.
  - **After:** Two-subsection structure (`### Propose mode (default)` and `### Apply mode (--apply <id>)`) parallel to `dome migrate`'s plan-then-apply shape. Each mode has a numbered sequence; apply mode names the most-recent-report locator (`inbox/review/lint-report-*.md`, lexically newest), the finding-id contract, the annotation contract (`Applied:` / `Apply-failed:`), the multi-id syntax (`--apply H1 --apply H2`), the mid-merge refusal guard, and the idempotency rule. A `### Periodic operation` paragraph closes by naming the propose/cron pair and explicitly excluding scheduled apply from v0.5 ("fixes that mutate the vault should pass through a human").
  - **Reason:** Closes the spec/implementation gap — the workflow now has a named confirmation mechanism instead of relying on agent freelancing.

- `docs/wiki/specs/prompts-and-workflows.md` (line 61, the `lint` row)
  - **Before:** Tools cell: `readDocument, searchIndex, wikilinkResolve, writeDocument (proposals to inbox/review or returned report), appendLog`. Purpose cell: "Detect drift: orphans, missing cross-refs, contradictions, schema violations. Propose fixes."
  - **After:** Tools cell: `readDocument, searchIndex, wikilinkResolve, writeDocument, moveDocument, deleteDocument, appendLog`. Purpose cell: "Detect drift: orphans, missing cross-refs, contradictions, schema violations. Propose first; apply on `--apply <id>` from the most recent report."
  - **Reason:** Apply mode may rename entities (`moveDocument`) or retire orphans (`deleteDocument`); `sdk-surface.md:131` already commits to "lint proposes deleting orphan pages," so this expands the tool list to match what apply-mode actually does. Mirrors the migrate row's Tool surface.

- `docs/wiki/matrices/intent-prompt-tools.md` (line 23, the `lint` row)
  - **Before:** Tools cell: `readDocument, searchIndex, wikilinkResolve, writeDocument (proposing fixes to inbox/review if sensitivity is enabled, or returning a structured report otherwise), appendLog`. Effects cell: "Proposed fixes; nothing applied without user confirmation."
  - **After:** Tools cell: `readDocument, searchIndex, wikilinkResolve, writeDocument, moveDocument, deleteDocument, appendLog`. Effects cell: "Proposed fixes by default (report under `inbox/review/lint-report-YYYY-MM-DD.md` if sensitivity routing is enabled, or structured report otherwise); named findings applied on `--apply <id>` from the most recent report."
  - **Reason:** Keep the matrix consistent with the prompts-and-workflows row. The Effects cell now describes both modes so a reader following the matrix as an audit surface sees what apply mode does without cross-referencing.

- `src/prompts/builtin/lint.md` (full rewrite)
  - **Before:** 24 lines. Single-mode prompt. Frontmatter tools list: `[readDocument, searchIndex, wikilinkResolve, writeDocument, appendLog]`. Body described propose-mode walking + the report write; ended with "Do not apply fixes without user confirmation" without naming what confirmation looks like — which is the freelancing seam.
  - **After:** ~75 lines. Two-mode prompt with explicit user-message dispatch (empty → propose; `apply <id> [<id>...]` → apply). Frontmatter tools list expanded to match the spec: `[readDocument, searchIndex, wikilinkResolve, writeDocument, moveDocument, deleteDocument, appendLog]`. Propose mode names the finding-entry shape (id + title + Evidence + Recommendation) and adds an `(advisory)` tag for findings that require human judgment (apply mode refuses these). Apply mode names the report-locate step, the id-find step, the applicability check (idempotency + advisory refusal), the execute step, the annotation step, and the per-id-summary step. Closes with a "Apply mode treats the report as the source of truth" paragraph naming why the workflow does NOT re-derive intent at apply time.
  - **Reason:** The prompt is the only place where the workflow's behavior is normatively defined; the rewrite makes the two-mode contract executable from the prompt alone without the CLI needing to teach the agent what to do.

## Files added

- `docs/cohesive/delta-ledgers/2026-05-26-lint-apply-mode.md` — this ledger.

## Files removed or deprecated

none

## Conceptual changes

| Old concept | New concept | Status |
|---|---|---|
| `lint` is single-mode (propose only); applying fixes is an unspecified user-side activity | `lint` is two-mode; apply mode (`--apply <id>`) is the named confirmation path | Tightened — names a contract that was promised but undefined |
| Report filename `lint-pass-YYYY-MM-DD.md` (spec aspiration) | Report filename `lint-report-YYYY-MM-DD.md` (ship reality, now spec'd) | Renamed |
| Lint workflow tool surface = `{read, search, wikilink, write, log}` | Lint workflow tool surface = `{read, search, wikilink, write, move, delete, log}` (matches migrate; matches sdk-surface.md:131's commitment to "lint proposes deleting orphan pages") | Tightened |
| Findings have informal labels in reports | Findings have stable `<severity-letter><index>` ids that survive same-day re-runs (Pass N) so apply mode can reliably target one | Added |
| Findings may be applied or not — opaque to the report | Applied findings carry an `Applied: <iso8601>` annotation in the report itself; failed applies carry `Apply-failed: <reason>`; advisory findings carry an `(advisory)` tag that apply mode refuses | Added |

## New or updated substrate

### Specs

- `docs/wiki/specs/cli.md` — `dome lint` section now describes propose and apply modes explicitly, mirroring `dome migrate`'s plan-then-apply shape; names the most-recent-report locator, the finding-id contract, the annotation contract, the multi-id syntax, the mid-merge refusal, and the idempotency rule.
- `docs/wiki/specs/prompts-and-workflows.md` — lint row in the shipped-workflows table reflects the expanded tool surface and the propose/apply purpose.

### Behavior matrices

- `docs/wiki/matrices/intent-prompt-tools.md` — lint row's Tools and Effects cells updated to the two-mode shape; no row added/removed.

### Named invariants

none — existing `EVERY_WRITE_IS_LOGGED`, `MARKDOWN_IS_SOURCE_OF_TRUTH`, and `VAULT_IS_GIT_REPO` already cover apply-mode mutations, report-as-truth, and revert-as-undo respectively.

### Gotchas

none added. Apply mode's mid-merge refusal reuses `wiki/gotchas/dirty-git-state-at-reconcile` by reference (same guard as `dome reconcile`).

### Semantic linter specs

none

### Tests / checks proposed (not yet implemented)

- **CLI surface tests** under `tests/cli/lint.test.ts`:
  - Propose-mode invocation: `dome lint` with no flag dispatches the workflow with empty user message.
  - Apply-mode invocation: `dome lint --apply H1` dispatches with user message `apply H1`.
  - Multiple-id invocation: `dome lint --apply H1 --apply H2` dispatches with user message `apply H1 H2`.
  - Malformed apply: `dome lint --apply ""` is rejected at the CLI boundary.
- **Workflow-prompt fixture tests** under `tests/prompts/lint/`:
  - Propose mode against an empty vault returns a no-findings report.
  - Apply mode against a fixture report with an `H1` finding writes the recommended change, annotates the report `Applied:`, exits 0.
  - Apply mode against a fixture report whose `H1` is already `Applied:` refuses with the prior timestamp.
  - Apply mode against a fixture report whose `H1` is `(advisory)` refuses with the advisory reason.
  - Apply mode with a non-existent id (`H99`) refuses with a clear error naming the report path.
  - Apply mode with no report file present refuses with a clear error naming the expected path pattern.
  - Apply mode against a fixture report where `H1` was `Applied:` in Pass 1 and re-promoted (without an `Applied:` annotation) in Pass 2 refuses, citing Pass 1's timestamp — exercises the cross-pass idempotency walk per the I2 repair from pass-1 validation review.

## What this rewrite *did not* do

- Implementation code (`src/cli/commands/lint.ts`): not changed. The CLI extension lands in the Build gate after `validate-rewrite` returns Approved.
- Tests: specifications proposed in the section above; no test files added.
- CI: not changed.
- `dome doctor` apply or `--repair`: not changed. The narrow `--repair` flag hinted at `cli.md:30` for re-templating `AGENTS.md` is a separate piece of work.
- The `clock:weekly` trigger wiring: not changed. Whether the clock source under `dome serve` actually fires `manual:lint` weekly is an adjacent audit; this rewrite assumes the trigger surface from `prompts-and-workflows.md:61` is honored or will be.
- The existing on-disk report `inbox/review/lint-report-2026-05-26.md` in the author's work vault: not migrated. The filename happens to match the new spec'd convention, so no rename is required.

## Remaining ambiguity

- **Per-finding apply order across passes:** When the same finding id appears in multiple `Pass N` sections of the same date's report (because Pass 2 promoted a Pass 1 finding), the prompt says "most recent `Pass N` section's entry wins." This is the right default but worth pressure-testing: a Pass 1 entry that recorded `Applied: ...` and a Pass 2 entry without that annotation produces ambiguous truth. The idempotency check on `Applied:` should walk all `Pass N` sections, not just the most recent one. The prompt's current language ("most recent Pass N section's entry") is slightly weaker than this — `spec-cohesion-reviewer` should pressure-test it.
- **Apply mode against an `Applied:` finding:** Decision in this rewrite is "refuse with prior timestamp" (idempotency). An alternative — "refuse only if the target's current state already matches the recommendation; otherwise apply (a possibly-modified) version" — is more powerful but introduces re-derivation that contradicts the "report is source of truth" principle. Locked to the simpler refusal; flagging as a design choice the reviewer may push back on.
- **Stable id continuity across dates:** Ids are stable within a date (Pass N preserves Pass 1's ids). The prompt is silent on whether a `H1` from Tuesday's report is "the same finding" as a `H1` from Wednesday's report. They are not — ids are per-report, not per-vault. Apply mode targets the most recent report, so this is unambiguous in practice, but a reader might assume cross-report id continuity. Worth tightening if `spec-cohesion-reviewer` flags it.

## Repair pass 1 (closed inline)

After pass-1 fresh-eyes review (Approved verdict; see `docs/cohesive/reviews/2026-05-26-lint-apply-mode-rewrite-validation.md`), the disposition "Close in same worktree → merge" applied. Four small repairs landed in-worktree:

- **Closes I1** — `docs/wiki/specs/cli.md` propose-mode finding shape now names the optional `(advisory)` tag; apply-mode failure list adds clause (d) for advisory refusal.
- **Closes I2** — `src/prompts/builtin/lint.md` apply-mode applicability check now walks every `## Pass N` section for the id (not just the most recent), so a finding promoted across passes whose Pass 1 entry was `Applied:` correctly refuses re-application from a Pass 2 entry that lacks the annotation.
- **Closes I3** — `docs/wiki/specs/cli.md` apply-mode section now specifies multi-id semantics: per-id failures don't abort the remaining ids; the CLI exits nonzero if any id failed; per-id summary lands on stderr.
- **Closes I4** — this ledger's preamble Conceptual changes bullet now enumerates the tool-surface expansion (`moveDocument` + `deleteDocument`) that was previously only in the body table.
- **Closes substrate gap** — Tests proposed list now includes the 7th fixture (cross-pass idempotency walk) matching the I2 repair.

## Ready for fresh-eyes review?

**Yes.** All four files are rewritten in end-state language. The ledger's `## Delta at a glance` preamble matches the body. No remaining "we will" / "should consider" phrasings in normative sections.

## How to read this ledger

1. Read the "Approved direction" line — the destination is "lint mirrors migrate's two-mode shape."
2. Skim "Delta at a glance" — four files changed; report filename standardized to ship reality; tool surface expanded to match what apply-mode requires; finding-id and annotation contracts added.
3. Skim "Conceptual changes" — five tightenings and additions, no removals.
4. Read "Files rewritten" with before/after deltas to verify each rewrite.
5. Use "Remaining ambiguity" as the focused review punch list — the three open design choices the reviewer should pressure-test.
