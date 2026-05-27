---
type: spec
created: 2026-05-25
updated: 2026-05-25
sources: ["[[raw/original-architecture]]", "[[cohesive/brainstorms/2026-05-25-dome-vision]]"]
---

# Page schema

This spec is normative for the frontmatter contract on Dome pages. `writeDocument` validates frontmatter against this schema and rejects malformed input. The schema is intentionally minimal — required fields capture provenance and identity; optional fields are open for extension.

## Universal frontmatter (every wiki page)

Every page under `wiki/` carries this frontmatter:

```yaml
---
type: entity | concept | source | synthesis | <extension-type>
created: YYYY-MM-DD
updated: YYYY-MM-DD
sources: ["[[wikilink]]", ...]
---
```

- `type` — must match the page's directory: `wiki/entities/x.md` has `type: entity`. The frontmatter and directory are redundant by design — either alone is sufficient, but both are required (the directory is the canonical truth per [[wiki/invariants/PAGE_TYPE_BY_DIRECTORY]]; the frontmatter is a self-documenting redundancy).
- `created` — ISO date. Set on first write; never modified.
- `updated` — ISO date. Set on every write (the writing Tool maintains it).
- `sources` — array of wikilinks to `raw/` files, `notes/` files, or `wiki/sources/` pages. May be empty for entirely-synthesized pages. Captures provenance.

## Page-type-specific extensions

Different types may carry optional additional fields:

### entity

```yaml
---
type: entity
created: ...
updated: ...
sources: [...]
aliases: ["alternative name", ...]   # optional; aliases the entity is also known by
tags: ["tag1", "tag2"]               # optional; freeform classification
---
```

### concept

```yaml
---
type: concept
created: ...
updated: ...
sources: [...]
aliases: [...]                       # optional
tags: [...]                          # optional
status: emerging | stable | retired  # optional; tracks concept maturity
---
```

### source

```yaml
---
type: source
created: ...
updated: ...
sources: ["[[raw/...]]"]             # the raw source this summarizes; usually exactly one
url: "https://..."                   # optional; original URL if from web
author: "..."                        # optional
external: true                       # marks claims as external research, not user belief
---
```

The `external: true` flag is load-bearing for research provenance — see [[wiki/specs/sdk-surface]] §"Why this design" (prompts as contract) and the brainstorm's note on belief-vs-claim conflation.

### synthesis

```yaml
---
type: synthesis
created: ...
updated: ...
sources: [...]                       # what was synthesized; often multiple
status: draft | review | settled     # optional; synthesis maturity
supersedes: ["[[wikilink]]"]         # optional; prior synthesis this replaces
---
```

### raw

Raw files carry a different frontmatter shape (they are user inputs, not Dome pages):

```yaml
---
id: raw_YYYY-MM-DD_HHMM_<slug>
source_type: voice | meeting | clip | upload | research | design-seed | manual
status: pending | processed | preserved
sensitivity: normal | sensitive | private
---
```

Raw files are immutable after creation per [[wiki/invariants/RAW_IS_IMMUTABLE]] — there are no exceptions. Reverse references from raws to wiki pages are not stored; they are computed on demand via `dome doctor --show raw-citations` by scanning wiki page frontmatter `sources:` fields.

### Extension types

A vault's `.dome/page-types.yaml` may declare additional types directly (vault-local), AND extension bundles under `<vault>/.dome/extensions/<bundle>/page-types.yaml` may declare additional types whose entries the bundle loader merges into the vault's `PageTypesConfig.extensions` at `openVault` time. The merge is keyed by `name:`; a collision between a vault-local declaration and a bundle's declaration (or between two bundles) is a `bundle-load-failure` per [[wiki/gotchas/extension-bundle-load-order]]. The two declaration paths produce equivalent runtime entries — the only difference is provenance (`source: "vault"` vs `source: "extension:<bundle>"` is tracked internally for diagnostic surfacing but does not change frontmatter validation behavior).

Each extension type may optionally declare its own frontmatter schema in the same YAML:

```yaml
extensions:
  - name: spec
    frontmatter_extras:
      status: draft | review | normative
  - name: invariant
    frontmatter_extras:
      severity: required | recommended
  - name: matrix
    frontmatter_extras: {}
  - name: gotcha
    frontmatter_extras:
      first_observed: <date>
      severity: low | medium | high
      coverage: matrix | off-matrix | deferred
      enforced_at: <path>            # required when coverage == off-matrix
      enforced_at_status: deferred   # optional; signals the path is planned-not-shipped
  - name: linter
    frontmatter_extras:
      tier: axiom | shipped-default | opt-in | deferred
      target_version: <version-string, e.g., "v0.5.1">
      status: shipped | planned | deferred
```

The `coverage:` field on gotcha pages drives the `tests/integration/gotcha-coverage.test.ts` lockstep test (parallel to AC3 for invariants). Three values, all lowercase:

- **`matrix`** — there is a regression test at `tests/gotchas/<slug>.test.ts` whose filename slug-matches the gotcha doc. The lockstep test asserts the file exists.
- **`off-matrix`** — the gotcha's structural mitigation is exercised by a test elsewhere (or is a documented scar with no behavioral regression test). The accompanying `enforced_at:` frontmatter field names the canonical test file (e.g., `tests/integration/bundle-deps.test.ts` for `transitive-llm-dependency`; `src/eval/replay.ts` for `agent-prompt-regression`). The lockstep test asserts the named file exists; a gotcha that is genuinely a documented scar with no behavioral test (e.g., `ai-sdk-tool-variance`'s `Tool<>` cast) names the source file the scar lives in (`src/tools/registry.ts`) so the lockstep is still anchored to a real path.
- **`deferred`** — a per-gotcha test should land at `tests/gotchas/<slug>.test.ts` but hasn't yet. The lockstep test surfaces these as warnings rather than failures; promote to `matrix` (with a real test) when the test ships, or to `off-matrix` (with an `enforced_at:`) when structural mitigation lands at another seam.

**`enforced_at_status:` field** *(optional, off-matrix gotchas only)*. When a gotcha's structural mitigation is planned but not yet shipped — e.g., a v0.5.1 lockstep test that the gotcha's mitigation depends on — the gotcha may carry `enforced_at:` pointing at the *future* path of the mitigation alongside `enforced_at_status: deferred`. The lockstep test treats `enforced_at_status: deferred` gotchas as warnings (not failures) until the named path exists; once the path lands, `dome doctor` either silently promotes the status or surfaces a one-line "deferred mitigation now exists; remove `enforced_at_status: deferred`" pointer. This semantic mirrors `coverage: deferred` for the gotcha's own test file, applied to the enforcement-anchor path. Omitting `enforced_at_status` (the modal case) means the named path must exist at lockstep-test time.

**`linter` extension type** *(docs/wiki/linters/<slug>.md)*. Linter specs declare convention-with-grep rules that may or may not have shipped lockstep tests. The `tier:` field declares the active-enablement intent (matching the invariant tier vocabulary); `target_version:` names when the lockstep ships if not yet (e.g., `v0.5.1`); `status:` is one of `shipped` (lockstep is live), `planned` (lockstep is named but not yet shipped — the doc is convention-with-grep until then), or `deferred` (no lockstep planned; the doc is documentation-only). A linter doc declaring `status: shipped` without a corresponding test file is a substrate violation; a future `dome doctor` check or `tests/integration/linter-coverage.test.ts` would catch this.

**`daily` and `weekly` extension types** *(Phase 1 dailies bundle)*. The first-party `dailies` extension bundle (per [[wiki/specs/sdk-surface]] §"Extension bundles" and [[wiki/matrices/extension-bundle-shape]]) contributes two page types when loaded into a vault:

```yaml
# Contributed by .dome/extensions/dailies/page-types.yaml
extensions:
  - name: daily
    frontmatter_extras:
      date: <YYYY-MM-DD>             # required; the calendar date of the daily
      prev: <wikilink-or-null>        # required; previous daily for navigation
      next: <wikilink-or-null>        # required; next daily for navigation
      tags: <string-array>            # optional; freeform
  - name: weekly
    frontmatter_extras:
      week: <YYYY-W##>                # required; ISO week identifier
      dailies: <wikilink-array>       # required; the seven (or fewer) daily pages this week aggregates
      tags: <string-array>            # optional
```

Daily and weekly pages land in `wiki/dailies/<YYYY-MM-DD>.md` and `wiki/weeklies/<YYYY-W##>.md` respectively. The `date:` / `week:` frontmatter is the canonical truth (re-derivable from the filename, but explicit for grep + Obsidian-Templater compatibility). Open `- [ ]` task lines in dailies follow Obsidian Tasks plugin syntax (`- [ ] #task ... ⏫ ✅ YYYY-MM-DD`), respected unchanged by Dome's tools — see [[wiki/matrices/extension-bundle-shape]] §"`dailies`" for the bundle's full contribution catalog.

A gotcha doc without a `coverage:` field is a frontmatter-validation soft warning (per the rule below); the lockstep test treats it as missing data and the gotcha's lockstep status is undefined until the field lands. An `off-matrix` gotcha doc without an `enforced_at:` field is a frontmatter-validation hard warning — the lockstep test cannot verify the "mitigation exercised elsewhere" claim without the path pin, and an unverifiable claim is reviewer-memory rather than structure.

`writeDocument` validates the type-specific frontmatter for extension types against this declaration. Unknown fields trigger a soft warning (logged to `log.md`) but not a rejection — pages can carry vault-specific metadata that the SDK doesn't validate.

## Body conventions

The body of a page (after the frontmatter `---` close) is markdown. Conventions:

- First-level header `# Title` is the page's display title.
- Wikilinks use full path: `[[wiki/entities/danny]]` not `[[danny]]`. See [[wiki/invariants/WIKILINKS_ARE_FULLPATH]].
- Sections are open; common sections include `## Current synthesis`, `## Important observations`, `## Open questions`, `## Related`, `## See also`.
- Page-creation reason is captured at the *Tool call site*, not in the body — see [[wiki/invariants/PAGE_CREATION_REQUIRES_RECURRENCE]].

## Schema evolution

When a page type's frontmatter schema changes:

1. The change is declared in `.dome/page-types.yaml` extensions block.
2. Existing pages are not migrated automatically. `dome doctor` reports pages that don't match current schema.
3. A migration command (`dome migrate-schema`) is reserved for future work; v0.5 leaves migration to the user.

## Related

- [[wiki/specs/vault-layout]] — directory structure.
- [[wiki/specs/sdk-surface]] — `writeDocument` Tool.
- [[wiki/invariants/PAGE_TYPE_BY_DIRECTORY]] — type is the directory.
- [[wiki/invariants/WIKILINKS_ARE_FULLPATH]] — wikilink convention.
- [[wiki/invariants/PAGE_CREATION_REQUIRES_RECURRENCE]] — new pages need a reason.
