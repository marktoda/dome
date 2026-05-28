---
type: spec
created: 2026-05-27
updated: 2026-05-28
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]", "[[v1]]"]
---

# Page schema

This spec is normative for the frontmatter contract Dome enforces on markdown pages. Each page type carries required and optional frontmatter fields; the `dome.markdown` adoption-phase processor validates them on every Proposal.

## Universal frontmatter

Every markdown page in a Dome vault carries:

```yaml
---
type: <singular page-type name>   # required; matches the directory under wiki/
created: <ISO-8601 date>          # required; the page's creation timestamp
updated: <ISO-8601 date>          # required; updated on every committed change
sources: [<wikilink>, ...]        # optional; explicit provenance citations
tags: [<tag>, ...]                # optional; indexed by dome.graph.tag-index
---
```

The four universal fields are required by `dome.markdown.frontmatter-required` — a missing field produces a blocking diagnostic at adoption time.

### Type field

`type:` is the **singular** form of the page's directory. A page at `wiki/entities/danny.md` carries `type: entity`. The plural directory name and the singular type are reconciled via the `pluralOf` / `singularOf` helpers in `src/page-type.ts`.

For pages outside `wiki/` (raw captures, daily notes that live in `wiki/dailies/`, etc.):
- `raw/voice/<id>.md` → `type: voice-capture` (the raw bucket convention).
- `wiki/dailies/2026-05-27.md` → `type: daily` (an **extension-contributed type** from the `dome.daily` bundle, not one of the four defaults — see §"Extension types (from bundles)" below).

Type validation against the declared page types is the `dome.markdown.type-known` diagnostic — adoption blocks on an unknown type.

### Created / updated

`created:` is set once at page creation by the writer (processor, user, or scaffold). `updated:` is set on every committed change. The `dome.markdown` adoption-phase processor updates `updated:` automatically when a patch touches the body or other frontmatter — the user does not maintain it.

### Sources

`sources:` is optional but recommended. Carries a list of wikilinks pointing to evidence — typically raw captures (`[[raw/voice/2026-05-27-danny.md]]`) or other wiki pages. `dome.markdown.broken-sources` emits a warning on unresolvable sources at adoption.

### Tags

`tags:` is an optional universal list of short labels. The `dome.graph.tag-index` adoption processor indexes both frontmatter tags and inline `#tag` syntax as `dome.graph.tagged` facts for tag-based recall.

## Default page types

The SDK ships four default types:

### Entity (`wiki/entities/`)

```yaml
---
type: entity
created: 2026-05-15
updated: 2026-05-27
sources: ["[[raw/voice/2026-05-15-meeting.md]]"]
aliases: ["Danny T.", "DT"]              # optional; for fuzzy-resolve
last_interaction: 2026-05-27             # optional; bumped by dome.intake
---
```

Entities are people, products, teams, projects, organizations — anything Dome treats as a named entity worth a backlinkable page.

### Concept (`wiki/concepts/`)

```yaml
---
type: concept
created: 2026-05-15
updated: 2026-05-27
sources: ["[[wiki/dailies/2026-05-15]]"]
tags: ["architecture", "platform-ownership"]   # optional
---
```

Concepts are ideas, threads, themes — durable claims spanning multiple captures.

### Source (`wiki/sources/`)

```yaml
---
type: source
created: 2026-05-15
updated: 2026-05-15
sources: []
url: "https://..."             # required for source pages
author: "Andrej Karpathy"      # optional
published: 2025-11-01          # optional
---
```

Sources are external citations Dome considers durable references — papers, articles, books, gists.

### Synthesis (`wiki/syntheses/`)

```yaml
---
type: synthesis
created: 2026-05-20
updated: 2026-05-27
sources: ["[[wiki/concepts/platform-ownership]]", "[[wiki/entities/danny-tan]]"]
status: "active" | "superseded" | "draft"     # optional; for synthesis lifecycle
---
```

Syntheses are higher-order claims built from other pages — positioning documents, build plans, strategic threads.

## Extension types (from bundles)

Extension bundles contribute additional page types via their `page-types.yaml`. The first-party bundles contribute:

| Type | Bundle | Directory |
|---|---|---|
| `daily` | `dome.daily` | `wiki/dailies/` |
| `weekly` | `dome.daily` | `wiki/weeklies/` |

Each declared extension type may carry `frontmatter_extras:` — required or optional fields beyond the universal four. The `dome.daily` daily type, for example, requires:

```yaml
extensions:
  - name: daily
    frontmatter_extras:
      recurrence: required    # frontmatter must carry recurrence: <YYYY-MM-DD>
      prev: optional          # backlink to previous daily
      next: optional          # backlink to next daily
```

The `dome.markdown` processor validates `frontmatter_extras` per type — a `daily` page without `recurrence:` produces a blocking diagnostic.

## Vault-local extension types

A vault may declare additional page types in `<vault>/.dome/page-types.yaml extensions:`:

```yaml
extensions:
  - name: recipe                          # vault-local type
    frontmatter_extras:
      cuisine: required
      servings: required
```

The corresponding `wiki/recipes/` directory is the page-type's home; pages there carry `type: recipe`.

## Frontmatter parsing

Parsed via `gray-matter` at the boundary. The result is a `Record<string, unknown>` on the `Document` value; processors that need specific fields read them through the Document's accessors.

Boundary validation per [[wiki/gotchas/boundary-validation-via-zod]]: the frontmatter Record gets Zod-validated against the page type's declared schema at adoption time. Validation errors become DiagnosticEffect (severity `block` for missing required fields; severity `warning` for unknown extra fields).

## Why this design

Three properties make page schemas substrate-friendly:

1. **The four-universal-field requirement is uniform.** Every page, every type, every bundle — the same four fields. Processors that walk `wiki/` can assume the universals.
2. **Extension types are first-class.** Adding a new page type is one entry in `page-types.yaml extensions:` plus an optional `frontmatter_extras:` block. Bundle-contributed and vault-local types use the same mechanism.
3. **Validation lives in one processor.** `dome.markdown` is the page-schema enforcer. Other processors don't validate frontmatter; they consume already-validated `Document` values.

## Related

- [[wiki/specs/sdk-surface]] §"Extension bundles" — how bundles contribute types.
- [[wiki/specs/vault-layout]] — directory mapping.
- [[wiki/specs/processors]] — `dome.markdown` is the adoption-phase validator.
- [[wiki/specs/effects]] §"DiagnosticEffect" — validation failures become diagnostics.
- [[wiki/gotchas/boundary-validation-via-zod]] — the Zod boundary at frontmatter parse.
