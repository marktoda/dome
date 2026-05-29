---
type: invariant
created: 2026-05-27
updated: 2026-05-27
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"]
tier: axiom
---

# EXTERNAL_EFFECTS_GO_THROUGH_OUTBOX

**Tier:** Axiom — non-disable-able.

**Statement:** Every `ExternalActionEffect` (calendar write, notification send, network POST, etc.) is recorded in the outbox table (`<vault>/.dome/state/outbox.db`) before the external call is attempted. The engine inserts an outbox row with `status: "pending"`, dispatches the registered capability handler, and updates the row on success/failure. There is no fire-and-forget path for external side effects.

**Why:** External side effects are the failure-mode-rich layer of the system. Networks fail, vendors return 500s, idempotency keys collide, retries cause double-sends. The outbox provides:

1. **Idempotency.** The `idempotencyKey` on every effect de-dups: a processor that re-emits the same effect on retry produces one row, one external call.
2. **Recoverability.** A terminally-failed external action is visible via `dome inspect outbox`; recovery follows the engine-asks model — a health/recovery processor raises a `QuestionEffect`, the user answers `dome answer <question-id> retry|abandon`, and a recovery answer-handler emits an `OutboxRecoveryEffect` that the engine-owned outbox sink applies. The generic answer-handler substrate ships now; the first-party `dome.health` question emitters and handlers are still v1 work. See [[wiki/specs/cli]] §"dome answer" and [[wiki/gotchas/outbox-stuck]].
3. **Auditability.** The outbox is the audit history of "what did Dome try to do to the outside world." Every call traces to a processor, a Proposal, and a RunRecord.
4. **Crash safety.** If the engine crashes between "insert outbox row" and "dispatch handler," the next startup sees `status: pending` and retries. If it crashes between "dispatch" and "mark sent," the retry detects via idempotency key that the call already succeeded and updates the row without re-firing.

**Structural enforcement:**

1. **The capability broker only allows `ExternalActionEffect` when `external:<capability>` is granted.** A processor that emits an ExternalAction without the matching grant is denied at the broker.
2. **The applier in `src/engine/apply-effect.ts` routes `external` effects to `src/outbox/dispatch.ts` exclusively.** No other module reaches the registered external-handler set.
3. **Dispatch always inserts before calling.** `src/outbox/dispatch.ts` performs `INSERT INTO outbox ...` synchronously, then calls the handler. A handler-direct call without an outbox row is a bug; the integration test `tests/integration/outbox-idempotency.test.ts` catches it.
4. **The handler interface returns `{ externalId, recovered? }`.** Handlers may indicate that a retry detected an already-completed call via `recovered: true`; the engine marks the row as sent without re-attempting.

**Counter-example:** A garden-phase processor emits `ExternalActionEffect { capability: "calendar.write", payload: { ... } }` to write a calendar event. The engine inserts an outbox row with `idempotencyKey: "dome.intake.dani-meeting-2026-05-27"`. The first attempt succeeds; the row updates to `status: "sent"`, `external_id: "evt_xyz"`. A subsequent re-run of the processor (idempotent on the same input) emits the same effect; the broker accepts; dispatch inserts a row — but the `UNIQUE` constraint on `idempotency_key` rejects, the dispatcher reads the existing row, sees `status: "sent"`, returns the cached result. One row; one external call.

**Test guarantee:** `tests/invariants/external-effects-go-through-outbox.test.ts` (off-matrix; delegates to `tests/integration/outbox-idempotency.test.ts`) — exercises the dispatch path with a mock handler that counts invocations; asserts one row per idempotency key, one handler call per idempotency key.

**Related:**
- [[wiki/specs/effects]] §"ExternalActionEffect"
- [[wiki/specs/projection-store]] §"Outbox"
- [[wiki/specs/capabilities]] §"external"
- [[wiki/gotchas/outbox-stuck]]
- [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]]
