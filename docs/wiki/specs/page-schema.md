---
type: spec
created: 2026-05-27
updated: 2026-06-01
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
  - "[[v1]]"
---

# Page schema

This spec is normative for the frontmatter contract Dome enforces on managed markdown pages. Each page type carries required and optional frontmatter fields; the `dome.markdown` adoption-phase processor validates them on every Proposal.

## Universal frontmatter

The preferred managed `wiki/` page shape is:

```yaml
---
type: <singular page-type name>   # required; matches the directory under wiki/
created: <ISO-8601 date>          # recommended; the page's creation timestamp
updated: <ISO-8601 date>          # recommended; updated on every committed change
sources: [<wikilink>, ...]        # optional; explicit provenance citations
tags: [<tag>, ...]                # optional; indexed by dome.graph.tag-index
description: <short text>         # optional; human-readable summary
name: <display name>              # optional; imported/display name
metadata: { ... }                 # optional; import/source-specific metadata bag
---
```

For v1, `dome.markdown.lint-frontmatter` requires frontmatter and `type:` on `wiki/` pages. `created:` and `updated:` are recommended; when present they must be parseable dates. On active Proposals, `dome.markdown.normalize-frontmatter` refreshes an existing managed `wiki/` page `updated:` date when it drifts from git history; during adopted-state rebuild/check, `dome.markdown.stale-dates` reports remaining stale historical pages as informational diagnostics. User-owned or ephemeral roots (`notes/`, `raw/`, `inbox/`) may omit frontmatter; if they include a frontmatter block, Dome still validates parseability and structured fields such as `updated:` and `tags:`. Reserved root files (`AGENTS.md`, `CLAUDE.md`, `index.md`, `log.md`), templates, assets, and external markdown are outside the frontmatter lint surface.

### Type field

`type:` is the **singular** form of the page's directory. A page at `wiki/entities/danny.md` carries `type: entity`. The plural directory name and the singular type are reconciled via the `pluralOf` / `singularOf` helpers in `src/page-type.ts`.

For non-default page shapes:
- `raw/voice/<id>.md` may use `type: voice-capture` when raw frontmatter is present.
- `wiki/dailies/2026-05-27.md` → `type: daily` (an **extension-contributed type** from the `dome.daily` bundle, not one of the four defaults — see §"Extension types (from bundles)" below).

Type validation against the declared page types is the `dome.markdown.type-unknown` warning diagnostic when known-type enforcement is active.

### Created / updated

`created:` is set once at page creation by the writer (processor, user, or scaffold). `updated:` is expected to match the date of the page's most recent committed content change. For managed `wiki/` pages with an existing `updated:` field, `dome.markdown.normalize-frontmatter` auto-patches drift greater than one day during adoption. `dome.markdown.stale-dates` remains a read-only informational rebuild/check diagnostic for adopted pages that predate the auto-bump policy or have not yet been touched.

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
description: "Team lead for..."          # optional
name: "Danny Tan"                        # optional
status: "active"                         # optional; lifecycle/state label
metadata: { ... }                        # optional
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
description: "Why this concept matters"        # optional
name: "Platform ownership"                     # optional
metadata: { ... }                              # optional
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
url: "https://..."             # optional but recommended for external sources
author: "Andrej Karpathy"      # optional
description: "Reference summary" # optional
name: "Karpathy gist"            # optional
metadata: { ... }                # optional
published: 2025-11-01          # optional
---
```

Sources are durable references — papers, articles, books, gists, Slack scans, meeting captures, and other internal evidence. `url:` is recommended for external sources but optional because many management-workflow sources are internal or imported from tools without stable URLs.

### Synthesis (`wiki/syntheses/`)

```yaml
---
type: synthesis
created: 2026-05-20
updated: 2026-05-27
sources: ["[[wiki/concepts/platform-ownership]]", "[[wiki/entities/danny-tan]]"]
status: "active" | "superseded" | "draft"     # optional; for synthesis lifecycle
description: "Synthesis summary"              # optional
generated_from: "wiki/generated/intake/example.md" # optional; generated synthesis provenance
name: "Org health synthesis"                  # optional
metadata: { ... }                             # optional
processor: dome.intake.synthesize-capture       # optional; generating processor id
---
```

Syntheses are higher-order claims built from other pages — positioning documents, build plans, strategic threads.

## Extension types (from bundles)

Extension bundles contribute additional page types via a bundle-root `page-types.yaml`. The bundle loader parses these at runtime open, merges them with the SDK defaults, rejects cross-bundle collisions, and threads the frozen registry to processors as `ctx.pageTypes`. The first-party bundles contribute:

| Type | Bundle | Directory |
|---|---|---|
| `daily` | `dome.daily` | `wiki/dailies/` |
| `weekly` | planned `dome.daily` | `wiki/weeklies/` |

Each declared extension type may carry `frontmatter_extras:` — required or optional fields beyond the universal four. The `dome.daily` daily type, for example, requires:

```yaml
extensions:
  - name: daily
    frontmatter_extras:
      recurrence: required    # frontmatter must carry recurrence: <YYYY-MM-DD>
      prev: optional          # backlink to previous daily
```

The `dome.markdown` processor validates `frontmatter_extras` per type — a `daily` page without `recurrence:` produces a warning diagnostic.

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

Vault-local page types are read through `ctx.snapshot.readFile(".dome/page-types.yaml")`, not from the live filesystem, so a Proposal that edits `.dome/page-types.yaml` and adds pages using the new type is validated against the candidate version of the schema. Field rules are intentionally small for v1: exact `required` means the field must be present and non-empty; `optional` and descriptive strings such as `draft | review | normative` declare the field as known but not required.

## Frontmatter parsing

Parsed via `gray-matter` at the boundary. The result is a `Record<string, unknown>` on the `Document` value; processors that need specific fields read them through the Document's accessors.

Boundary validation per [[wiki/gotchas/boundary-validation-via-zod]]: the frontmatter record is validated against the page type's declared schema at adoption time. Validation errors become DiagnosticEffect warnings in v1.

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
