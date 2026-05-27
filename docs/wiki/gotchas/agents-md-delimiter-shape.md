---
type: gotcha
created: 2026-05-26
updated: 2026-05-26
sources: ["[[cohesive/reviews/2026-05-26-dome-v0.5-to-v1-readiness-architecture-review]]"]
severity: high
coverage: off-matrix
enforced_at: tests/invariants/agents-md-is-orientation-surface.test.ts
first_observed: 2026-05-26
---

# AGENTS.md delimiter shape

**Symptom:** A contributor edits `docs/wiki/invariants/AGENTS_MD_IS_ORIENTATION_SURFACE.md` to change the user-prose section delimiters (e.g., renames `<!-- BEGIN user-prose -->` to `<!-- AGENT BEGIN -->`) for readability or clarity, without updating `src/agents-md.ts`. The next time anyone runs `dome doctor --repair` in a vault, the AGENTS.md merge logic at `mergeAgentsMd` falls into the no-delimiter branch — it cannot find the delimiters it expects in the existing file — and re-skeletons the file from the templated-sections-only shape, **destroying every user-authored line between the original delimiters**.

**Root cause:** The delimiter strings are shared between three surfaces:

- **The runtime parser:** `src/agents-md.ts:9-10` exports `USER_PROSE_BEGIN = "<!-- BEGIN user-prose -->"` and `USER_PROSE_END = "<!-- END user-prose -->"` as the load-bearing constants the merge logic reads.
- **The invariant doc:** [[wiki/invariants/AGENTS_MD_IS_ORIENTATION_SURFACE]] documents the delimiters as part of the user-prose contract.
- **The CLI spec:** [[wiki/specs/cli]] §"`dome doctor`" describes `--repair`'s merge semantics, naming the delimiters as the substrate convention.

The delimiters appear as **literal strings** in all three places. There is no compile-time link between them — the parser reads its constants; the docs cite the same strings; a change in one drifts the others silently. The drift is detectable only by running `--repair` against a real vault and seeing user prose disappear.

**Severity:** High — silent data loss in a `--repair`-driven workflow. The `--repair` flag is explicitly destructive-on-promise (it regenerates templated sections), and the user's mental model is "templated sections regenerate; my prose is preserved." A delimiter-shape regression violates the second half of the promise.

**Structural mitigation:** The lockstep test at `tests/invariants/agents-md-is-orientation-surface.test.ts` parses [[wiki/invariants/AGENTS_MD_IS_ORIENTATION_SURFACE]] for the literal `<!-- BEGIN user-prose -->` and `<!-- END user-prose -->` and asserts equality with the `USER_PROSE_BEGIN` / `USER_PROSE_END` exports from `src/agents-md.ts`. A regression in either surface fails the test. The invariant doc is the canonical source of the literal strings; the test pins the runtime constants to match.

The invariant doc carries this rule in its body: **the delimiter strings are load-bearing constants — do not edit them in the doc without editing the const, and do not edit the const without re-running the invariant test.**

**Specific scenarios:**

- A contributor cleaning up the invariant doc replaces `<!-- BEGIN user-prose -->` with `<!-- BEGIN AGENT PROSE -->` for stylistic parallelism with another delimiter convention — the lockstep test fails on the next CI run.
- A future v0.5.1 feature adds a second pair of delimiters (`<!-- BEGIN agent-instructions -->`) for a new section — the existing test pins only the user-prose pair; the new pair needs its own lockstep assertion before it ships.
- A vault carries an old AGENTS.md generated with delimiters that have since been renamed in the SDK — `mergeAgentsMd` falls into the no-delimiter branch. The mitigation here is not the delimiter lockstep; it is `dome migrate` reading the version field and applying the rename forward. Backwards-compatible delimiter migration is an explicit ship in any release that renames them.

**Related:**

- [[wiki/invariants/AGENTS_MD_IS_ORIENTATION_SURFACE]] — the invariant the delimiters serve
- [[wiki/specs/cli]] §"`dome doctor`" — the `--repair` flow that runs the merge
- `src/agents-md.ts` — the runtime parser carrying the constants
- [[wiki/gotchas/substrate-count-drift]] — the sibling pattern (substrate-vs-code drift)
