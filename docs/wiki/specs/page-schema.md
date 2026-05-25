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
linked_pages: ["[[wiki/...]]"]       # set during ingest; lists pages updated
---
```

Raw files are immutable AFTER creation (`RAW_IS_IMMUTABLE`), but `linked_pages` may be appended to during ingest. This is the single exception to raw-immutability — the linked-pages list grows as the raw source is referenced. The body content is never modified.

### Extension types

A vault's `.dome/page-types.yaml` may declare additional types. Each extension type may optionally declare its own frontmatter schema in the same YAML:

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
```

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
