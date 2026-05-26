---
type: gotcha
created: 2026-05-25
updated: 2026-05-25
severity: high
coverage: off-matrix
first_observed: 2026-05-25
sources: ["[[cohesive/brainstorms/2026-05-25-dome-vision]]"]
---

# Agent prompt regression

**Symptom:** After an Anthropic model upgrade or a prompt edit, Dome's agent starts behaving differently — extracting different atomic ideas, routing different content to inbox, creating pages with different criteria. Sometimes subtly wrong: the right kind of content lands on the wrong page; cross-references shift; content gets classified or summarized differently.

**Root cause:** The agent owns the page-write flow (see [[wiki/specs/sdk-surface]] §"The four concepts"). Tools enforce *structural* invariants but cannot enforce *semantic* correctness. "This update went to the right page" is a semantic claim that no invariant catches.

**Why all the existing structural mitigations don't catch it:**

- `RAW_IS_IMMUTABLE` doesn't help — the wrong wiki page was modified, not a raw file.
- `PAGE_TYPE_BY_DIRECTORY` doesn't help — the right *kind* of page was modified, just the wrong instance.
- `EVERY_WRITE_IS_LOGGED` catches the change in `log.md` but doesn't say it was wrong.

**Structural mitigation:** The eval suite. Specifically:

1. Maintain a fixture vault separate from any real vault: `tests/fixtures/eval-vault/`.
2. Maintain a set of recorded representative conversations: `tests/fixtures/eval-conversations/<name>.json`. Each conversation has (input, expected effects: which pages should be created or updated, which fields should change).
3. `bun test --eval` replays each conversation against the current SDK / prompts / model version. It asserts the observed effects match the expected ones. (The eval suite is a test-time target, not a `dome` CLI command.)
4. Run after every model upgrade, every prompt edit, before every release.
5. A regression manifests as a failing assertion; the diff between observed and expected effects is the report.

**Operational note:** The eval suite is not exhaustive (a real vault has cases the fixtures don't cover) but it is *reproducible* — running it before and after a change isolates the change's behavioral impact. New regression patterns get added as fixtures: when a user-reported regression is fixed, a fixture is added so the same regression cannot ship again.

**Mitigation outside the eval suite:**

- Recent log entries are scannable: `dome doctor --recent-activity` surfaces "the last N writes by tool and target." A user noticing weird recent activity can spot regression.
- The vault is git-backed: `git revert <bad-commit>` is the universal undo.
- For workflows that produce review-worthy artifacts (`dome lint`), the output lands in `inbox/review/lint-report-YYYY-MM-DD.md` first — the user reviews and selectively applies via `dome lint --apply <id>` rather than the workflow mutating the vault directly. The review buffer IS `inbox/review/`; no in-Tool dry-run mode exists.

**What NOT to do:**

- Don't add semantic checks to Tools. A Tool that tries to validate "is this content about the right person" is exactly the kind of complexity this gotcha tells us to avoid. Semantic correctness comes from the prompts, and the eval suite validates the prompts. Tool layer stays mechanical.
- Don't disable the eval suite to "ship faster." A new model rolls out → the eval suite runs → if it fails, the upgrade waits. No exception.

**Related:**
- [[wiki/specs/sdk-surface]] §"Why this design"
- [[wiki/specs/prompts-and-workflows]] §"Eval suite"
- [[wiki/gotchas/async-read-after-write-staleness]] (sister failure mode: behavior changes the user doesn't observe)
