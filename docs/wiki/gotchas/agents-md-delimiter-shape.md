---
type: gotcha
created: 2026-05-26
updated: 2026-06-12
sources:
  - "[[cohesive/reviews/2026-05-26-dome-v0.5-to-v1-readiness-architecture-review]]"
coverage: off-matrix
description: Renaming user-prose delimiters in the AGENTS.md invariant page without updating init.ts breaks dome init --refresh-instructions refresh.
enforced_at: tests/invariants/agents-md-is-orientation-surface.test.ts
first_observed: 2026-05-26
severity: high
---

# AGENTS.md delimiter shape

**Symptom:** A contributor edits `docs/wiki/invariants/AGENTS_MD_IS_ORIENTATION_SURFACE.md` to change the user-prose section delimiters (e.g., renames `<!-- BEGIN user-prose -->` to `<!-- AGENT BEGIN -->`) for readability or clarity, without updating `src/cli/commands/init.ts`. The next time `dome init --refresh-instructions` refreshes AGENTS.md for a real vault, the refresh logic cannot find the existing user-prose block and treats the whole old file as legacy prose. That avoids data loss, but it also stops the managed/user boundary from being recognized correctly and can duplicate stale managed instructions inside user prose.

**Root cause:** The delimiter strings are shared between three surfaces:

- **The refresh implementation:** `src/cli/commands/init.ts` defines `USER_PROSE_BEGIN = "<!-- BEGIN user-prose -->"` and `USER_PROSE_END = "<!-- END user-prose -->"` as the load-bearing constants the refresh logic reads.
- **The invariant doc:** [[wiki/invariants/AGENTS_MD_IS_ORIENTATION_SURFACE]] documents the delimiters as part of the user-prose contract.
- **The CLI spec:** [[wiki/specs/cli]] §"`dome init`" describes the `--refresh-instructions` flow that refreshes managed AGENTS content while preserving the delimited user-prose block.

The delimiters appear as **literal strings** in all three places. There is no compile-time link between them — the parser reads its constants; the docs cite the same strings; a change in one drifts the others silently. The drift is detectable only by running `--repair` against a real vault and seeing user prose disappear.

**Severity:** High — instruction refresh is explicitly destructive-on-promise: managed sections regenerate, user prose is preserved. A delimiter-shape regression violates the clarity of that boundary and can leave stale managed instructions in the user-owned block.

**Structural mitigation:** The lockstep test at `tests/invariants/agents-md-is-orientation-surface.test.ts` parses [[wiki/invariants/AGENTS_MD_IS_ORIENTATION_SURFACE]] for the literal `<!-- BEGIN user-prose -->` and `<!-- END user-prose -->` and asserts equality with the `USER_PROSE_BEGIN` / `USER_PROSE_END` constants in `src/cli/commands/init.ts`. A regression in either surface fails the test. The invariant doc is the canonical source of the literal strings; the test pins the runtime constants to match. The refresh tests also assert that stale managed AGENTS text is replaced while delimited user prose survives.

The invariant doc carries this rule in its body: **the delimiter strings are load-bearing constants — do not edit them in the doc without editing the const, and do not edit the const without re-running the invariant test.**

**Specific scenarios:**

- A contributor cleaning up the invariant doc replaces `<!-- BEGIN user-prose -->` with `<!-- BEGIN AGENT PROSE -->` for stylistic parallelism with another delimiter convention — the lockstep test fails on the next CI run.
- A future v0.5.1 feature adds a second pair of delimiters (`<!-- BEGIN agent-instructions -->`) for a new section — the existing test pins only the user-prose pair; the new pair needs its own lockstep assertion before it ships.
- A vault carries an old AGENTS.md generated with delimiters that have since been renamed in the SDK — `dome init --refresh-instructions` falls into the no-delimiter branch and preserves the whole old file as legacy prose. The mitigation here is not the delimiter lockstep; it is a migration that reads the previous delimiter shape and applies the rename forward. Backwards-compatible delimiter migration is an explicit ship in any release that renames them.

**Related:**

- [[wiki/invariants/AGENTS_MD_IS_ORIENTATION_SURFACE]] — the invariant the delimiters serve
- [[wiki/specs/cli]] §"`dome init`" — the shipped refresh flow
- `src/cli/commands/init.ts` — the refresh implementation carrying the constants
- [[wiki/gotchas/substrate-count-drift]] — the sibling pattern (substrate-vs-code drift)
