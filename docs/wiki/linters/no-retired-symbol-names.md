---
type: linter
created: 2026-05-26
updated: 2026-05-26
sources: ["[[cohesive/reviews/2026-05-26-dome-v0.5-to-v1-readiness-architecture-review]]"]
tier: shipped-default
target_version: v0.5.1
---

# no-retired-symbol-names

**Status:** Lockstep test ships in v0.5.1 as `tests/integration/no-retired-symbol-names-in-specs.test.ts`, parallel to `tests/invariants/no-retired-invariant-names-in-prompts.test.ts` (the existing precedent for retired-name lockstep on shipped prompts). The convention until that lockstep ships is reviewer attention.

**Severity:** High — a normative doc naming a symbol that the code no longer exports sends future contributors and agents to design against a contract that does not exist. This is the failure mode the pass-3 architecture review surfaced across seven docs after the `ConsumerSurface` → `AbstractSurface` rename.

**What it checks:** Every normative doc under `docs/wiki/` and every cohesive-substrate doc under `docs/cohesive/` (excluding `docs/cohesive/reviews/`, `docs/cohesive/brainstorms/`, `docs/cohesive/delta-ledgers/`, and `docs/cohesive/substrate-discovery/` — historical persisted-file content that documents the rename trajectory itself) names no symbol in the retired-names allow-list.

**The retired-names allow-list** is a typed const exported from `src/types.ts` alongside `INVARIANTS`. As of v0.5.1:

| Retired symbol | Replaced by | Retired at |
|---|---|---|
| `ConsumerSurface` (type) | `AbstractSurface` | Pass 2 → Pass 3 transition |
| `buildConsumerSurface(vault)` (function) | `buildAbstractSurface(vault)` + `renderMcp(surface)` | Pass 2 → Pass 3 transition |
| `projectMcp(vault)` (function) | `renderMcp(buildAbstractSurface(vault))` | Pass 2 |
| `McpProjection` (type) | `McpSurface` (returned by `renderMcp`) | Pass 2 |
| `McpToolName` (type) | `MCP_TOOL_NAMES` (re-export from core) | Pass 2 |
| `SENSITIVE_GOES_TO_INBOX` (invariant name) | (retired wholesale; sensitivity classification removed) | Compiler-reframe merge |
| `sensitivity_classified` (frontmatter / Tool opt) | (no replacement; concept retired) | Compiler-reframe merge |

The allow-list grows when future renames or retirements land; each entry carries its replacement and the retirement event for the audit trail.

**Programmatic detection:** A test that walks `docs/wiki/**/*.md` and selected `docs/cohesive/*.md` (handoff docs; not reviews/brainstorms/ledgers), greps each file for any literal in the retired-names allow-list, and reports the file + line for every match.

The exclusion set:

- `docs/cohesive/reviews/**` — append-only review history that documents the rename's trajectory.
- `docs/cohesive/brainstorms/**` — append-only design history that may carry pre-rename terminology.
- `docs/cohesive/delta-ledgers/**` — append-only audit trail; ledger preambles legitimately cite both the retired and replacement names when describing a rename.
- `docs/cohesive/substrate-discovery/**` — discovery snapshots from before a rename land here.
- **`docs/wiki/linters/no-retired-symbol-names.md`** itself — this doc is the canonical home of the allow-list and necessarily names every retired symbol; the lockstep skips the linter spec rather than maintaining a parallel const elsewhere.
- **`docs/index.md` §"Linters"** — the substrate catalog's one-line summary of this linter cites the allow-list members categorically; the scanner skips the §"Linters" subsection of `docs/index.md` while still scanning the other sections.
- Archival-marked handoffs (e.g., `docs/cohesive/IMPLEMENTATION_HANDOFF.md`'s archival-banner section) — the banner text is asserted present so the exclusion is structurally justified.

The exclusion set is itself substrate. Adding a new excluded path requires updating this list, the test's exclusion list, and an entry in the test's frontmatter-cross-reference comment so a future contributor reading either surface sees both.

A second arm of the same test asserts that none of the retired-names appears as a public export from any `@dome/sdk` entrypoint — `grep "export.*ConsumerSurface" src/**/index.ts` returns zero matches.

**What closes a violation:**

- For a normative-doc match: rewrite the line to use the replacement symbol; if the historical name is load-bearing for the section (e.g., a "Renamed from X" callout), move the text to a clearly-marked `## History` or `## Migration` subsection so the lockstep-test's normative scope excludes it.
- For a code match: the public-surface-shape lockstep test already catches this class; the no-retired-symbol-names lockstep is the docs-side complement.

**Convention until the lockstep ships:** Whenever a symbol retires, the same PR that ships the code rename also rewrites every normative-doc reference. The pass-3 architecture review surfaced seven normative-doc lag instances post-`ConsumerSurface` retirement; this linter spec is the structural lift that prevents recurrence at the next rename.

**Related:**

- [[wiki/gotchas/substrate-count-drift]] — caught counts, but not symbol-name renames; this linter is the symbol-name complement
- [[wiki/specs/sdk-surface]] §"Consumer surfaces" — the rename that motivated this linter
- `tests/invariants/no-retired-invariant-names-in-prompts.test.ts` — the precedent for retired-name lockstep on a different surface (shipped prompts)
- `tests/integration/public-surface-shape.test.ts` — the code-side complement (catches retired exports from public entrypoints)
