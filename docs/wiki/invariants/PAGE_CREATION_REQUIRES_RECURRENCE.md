---
type: invariant
created: 2026-05-25
updated: 2026-05-25
sources: ["[[raw/original-architecture]]", "[[cohesive/brainstorms/2026-05-25-dome-vision]]"]
tier: opt-in
---

# PAGE_CREATION_REQUIRES_RECURRENCE

**Tier:** Opt-in. Not active by default. Enabled per-vault via `.dome/config.yaml`:

```yaml
invariants:
  PAGE_CREATION_REQUIRES_RECURRENCE:
    enabled: true
```

Most useful for personal-note vaults where the user wants explicit friction against page explosion. Project-design vaults (specs, invariants, matrices authored explicitly) and research vaults (every paper deserves its own source page) typically leave it disabled.

**Statement:** When enabled, creating a new wiki page (rather than updating an existing one) requires an explicit `reason` parameter to `writeDocument`. The reason must be one of: `'recurring'` (the concept has appeared multiple times), `'named_explicitly'` (the user named it directly), `'structural'` (a specific page type, e.g., a person mentioned by name in a meeting transcript). Bulk creation is rejected.

**Why:** Page explosion is the most expensive form of wiki rot. A 10-minute voice ramble can produce 30 one-off "concept" pages if the agent isn't constrained — and most will never recur, polluting the index forever. Forcing a creation reason makes the agent justify each new page, structurally.

**Structural enforcement:** When enabled, `writePage(path, body, frontmatter, { create: true, reason: ... })` requires `reason` when creating a page that doesn't yet exist. Missing `reason` → `Result.err({ kind: 'page-creation-requires-reason' })`. The reason is logged with the page-creation log entry. When disabled, `reason` is optional and unenforced.

**Counter-example (when enabled):** During ingest of a 5-minute strategy meeting voice note, the agent identifies 12 candidate "concepts" — phrases like "two-sided buyer marketplace dynamics." Without the invariant, the agent might create 12 concept pages, most one-off. With it, the agent must pass `reason: 'recurring'` only for concepts already in the index; the rest land as bullets on existing pages.

**Test guarantee:** `tests/invariants/page-creation-requires-recurrence.test.ts` — runs a representative ingest fixture against a vault with the invariant enabled; asserts all new-page creations carry a `reason` in their log entry. Asserts `writeDocument` with `create: true` and no `reason` returns the page-creation-requires-reason error. Separate fixture verifies `reason` is optional when disabled.

**Related:**
- [[wiki/specs/sdk-surface]] §"Tool catalog" (`writeDocument`)
- [[wiki/specs/prompts-and-workflows]] §"ingest"
- [[raw/original-architecture]] (page-creation rules, lines 887-905)
