---
type: invariant
created: 2026-07-09
updated: 2026-07-11
description: Agent work is compiled from open questions and never owns a queue, claim, retry, or job store.
enforced_by:
  - tests/agent-work/agent-work.test.ts
  - tests/invariants/agent-work-is-derived.test.ts
status: shipped
tier: shipped-default
---

# AGENT_WORK_IS_DERIVED

Agent work is a current read model over open `QuestionEffect` rows. It never
owns a durable queue, claim lease, retry row, or job lifecycle. The question is
the request; the durable answer is settlement; answer-handler Effects perform
the transition.

This keeps foreground, hosted, and background agents interchangeable at one
small seam. Failed or deferred attempts leave the question open and therefore
reappear automatically. Concurrent agents race through first-answer-wins
durable resolution instead of coordinating through another state machine.

The invariant test rejects any `agent_work` table DDL and pins the compiler to
question inputs. See [[wiki/specs/agent-work]].
