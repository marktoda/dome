---
type: invariant
created: 2026-07-09
updated: 2026-07-09
description: Owner attention is compiled from current decisions and proposal reviews; it is never independently persisted
enforced_by:
  - tests/attention/attention.test.ts
  - tests/invariants/attention-is-derived.test.ts
tier: shipped-default
---

# ATTENTION_IS_DERIVED

**Statement:** Owner attention is a deterministic read model over open owner
questions and pending proposals. There is no attention table, AttentionEffect,
or plugin-owned attention row. Diagnostics, tasks, agent work, and engine
health retain their own settlement semantics and do not enter the owner queue.

**Why:** Persisting attention would duplicate the lifecycles it summarizes and
create another stale synchronization problem. Compiling once gives CLI, daily,
app, HTTP, and MCP one eligibility rule, one ordering, and one budget while the
underlying decision/review actions stay typed.

**Enforcement:** `tests/attention/attention.test.ts` exercises ranking,
budgeting, aging, proposal staleness, and agent-work exclusion through the
module interface. The lockstep marker pins this named invariant into the
substrate inventory.

**Related:** [[wiki/specs/owner-attention]], [[wiki/specs/effects]].
