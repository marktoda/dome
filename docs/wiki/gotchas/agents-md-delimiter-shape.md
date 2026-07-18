---
type: gotcha
created: 2026-05-26
updated: 2026-07-18
sources:
  - "[[cohesive/reviews/2026-05-26-dome-v0.5-to-v1-readiness-architecture-review]]"
coverage: off-matrix
description: Historical orientation-refresh delimiter coupling; narrow init no longer parses or rewrites owner AGENTS.md.
enforced_at: tests/invariants/agents-md-is-orientation-surface.test.ts
first_observed: 2026-05-26
severity: low
---

# AGENTS.md delimiter shape

This was a shipped failure mode when legacy init refreshed managed orientation:
changing `<!-- BEGIN user-prose -->` / `<!-- END user-prose -->` in one surface
could make the refresh parser misclassify owner prose.

The parser and `--refresh-instructions` mutation path are retired. Canonical
setup now creates `AGENTS.md` only when missing, and narrow `dome init` never
rewrites an existing orientation file. The delimiters remain part of the
fresh-vault orientation format, but there is no runtime parser coupled to
their spelling.

Any future managed orientation migration must define its own explicit consent,
owner-prose preservation, crash recovery, and old-delimiter compatibility. It
must not revive an ad-hoc init writer.

**Related:**

- [[wiki/invariants/AGENTS_MD_IS_ORIENTATION_SURFACE]]
- [[wiki/specs/setup]]
- [[wiki/specs/cli]] §"`dome init`"
