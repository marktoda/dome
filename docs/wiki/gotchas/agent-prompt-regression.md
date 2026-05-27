---
type: gotcha
created: 2026-05-27
updated: 2026-05-27
severity: high
coverage: tested
enforced_at: src/eval/replay.ts
first_observed: 2026-05-27
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"]
---

# Agent prompt regression

**Symptom:** After an Anthropic model upgrade or a prompt edit in a garden-LLM processor's `<processor>.prompt.md` file, Dome's compilation behavior shifts — `dome.intake.extract-capture` extracts different atomic ideas, routes different content to wiki updates, creates pages with different criteria. Sometimes subtly wrong: the right kind of content lands on the wrong page; cross-references shift; capture-derived facts use slightly different predicates.

**Root cause:** Garden-LLM processors (per [[wiki/specs/processors]] §"Garden phase — async, possibly LLM-backed") own the meaning-shaped compilation flow. Their `run(ctx)` body composes a prompt from `<processor>.prompt.md`, calls `ctx.modelInvoke(...)`, parses the response into PatchEffects and FactEffects. The engine validates *structural* invariants (capability scope, idempotency expectation, fixed-point convergence) but cannot enforce *semantic* correctness. "This update went to the right page" is a semantic claim that no broker or matrix catches.

**Why the existing structural mitigations don't catch it:**

- [[wiki/invariants/RAW_IS_IMMUTABLE]] doesn't help — the wrong wiki page was modified, not a raw file.
- [[wiki/invariants/EVERY_EFFECT_IS_CAPABILITY_CHECKED]] doesn't help — the right *kind* of effect was emitted (PatchEffect against `wiki/**`); only the *target page* was wrong.
- [[wiki/invariants/EVERY_EFFECT_IS_LEDGERED]] catches the change in the run ledger but doesn't say it was wrong.

**Structural mitigation:** **The eval suite.**

1. Maintain a fixture vault separate from any real vault: `tests/fixtures/eval-vault/`.
2. Maintain a set of recorded representative inputs at `tests/fixtures/eval-inputs/<name>.json`. Each fixture has `(processor-id, input, expected-effects)` — including which paths the PatchEffects should target, which facts the FactEffects should emit, which questions the QuestionEffects should ask.
3. `bun test --eval` replays each fixture against the current SDK / prompts / model version. It asserts the observed effects match the expected ones. (The eval suite is a test-time target, not a `dome` CLI command — though `dome.lint` includes an "eval drift" check that surfaces stale fixtures as Diagnostics.)
4. Run after every model upgrade, every prompt edit, before every release.
5. A regression manifests as a failing assertion; the diff between observed and expected effects is the report.

**Operational note:** The eval suite is not exhaustive (a real vault has cases the fixtures don't cover) but it is *reproducible* — running it before and after a change isolates the change's behavioral impact. New regression patterns get added as fixtures: when a user-reported regression is fixed, a fixture is added so the same regression cannot ship again.

**Mitigation outside the eval suite:**

- Recent ledger entries are scannable: `dome doctor --show runs --since 24h` surfaces "the last N runs by processor and target." A user noticing weird recent activity can spot regression.
- The vault is git-backed: `git revert <closure-commit>` is the universal undo. The Dome-* trailers on the engine commit name the responsible processor and run.
- For garden processors that produce review-worthy artifacts (`dome lint`, `dome export-context`), the output lands as a ViewEffect (or in `inbox/review/` for `dome lint`) — the user reviews and selectively applies via `dome lint --apply <id>` rather than the processor mutating the vault directly. The review buffer IS `inbox/review/`; no in-engine dry-run mode exists.

**What NOT to do:**

- Don't add semantic checks to the broker. A capability that tries to validate "is this content about the right person" is exactly the kind of complexity this gotcha tells us to avoid. Semantic correctness comes from the prompts; the eval suite validates the prompts. The broker layer stays mechanical.
- Don't disable the eval suite to "ship faster." A new model rolls out → the eval suite runs → if it fails, the upgrade waits. No exception.
- Don't ship a garden-LLM processor without a fixture in `tests/fixtures/eval-inputs/`. The shipped-default test for new garden-LLM processors (per [[wiki/specs/sdk-surface]] §"Adding a processor") requires a fixture; CI rejects PRs that skip this.

**Related:**
- [[wiki/specs/processors]] §"Garden phase — async, possibly LLM-backed"
- [[wiki/specs/capabilities]] §"model.invoke"
- [[wiki/specs/effects]] §"PatchEffect" / "FactEffect"
- [[wiki/matrices/intent-prompt-processors]] §"User intents → processor mapping"
- [[wiki/invariants/EVERY_EFFECT_IS_LEDGERED]]
- [[wiki/gotchas/async-read-after-write-staleness]] (sister failure mode: behavior changes the user doesn't immediately observe)
- [[wiki/gotchas/processor-idempotency]] (related: non-determinism amplifies the regression surface)
