---
type: gotcha
created: 2026-05-27
updated: 2026-05-27
severity: medium
coverage: off-matrix
enforced_at: src/outbox/dispatch.ts
enforced_at_status: deferred
first_observed: 2026-05-27 (anticipated; surfaced in v1 design)
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"]
---

# Outbox stuck

**Symptom:** `dome show outbox` lists rows in `status: "failed"` with high `attempts` counts. External actions the user expected to fire (calendar events, notifications, webhook POSTs) didn't happen, and retries aren't catching up.

**Root cause:** The external capability handler is failing terminally — the remote service is down, the credentials are invalid, the idempotency key is being rejected by the remote (suggesting a state mismatch), or the handler's max-attempts cap was reached.

**Structural mitigation:** **Visibility + engine-asks recovery via QuestionEffect / `dome answer`.**

The outbox is **never** silently discarded — every emitted `ExternalActionEffect` lands in `outbox.db` per [[wiki/invariants/EXTERNAL_EFFECTS_GO_THROUGH_OUTBOX]]. When the engine's automatic retry (exponential backoff up to `maxAttempts`, default 3) exhausts, the row goes to `status: "failed"`. The recovery loop is engine-asks rather than user-imperative:

1. **Engine publishes a signal.** On terminal failure the engine emits the `engine.outbox.terminal-failure` event carrying the row's idempotency key.
2. **`dome.health.outbox-failure-question` (garden-phase, v1.x, in the deferred `dome.health` bundle) subscribes to the signal** and emits a `QuestionEffect` with options `["retry", "abandon", "wait"]`, `idempotencyKey` set to the underlying row's key, and `sourceRefs` pointing at the failed row.
3. **User inspects:** `dome show outbox` lists pending and failed entries with their last error message; `dome show questions` lists the open recovery questions.
4. **User answers:** `dome answer <question-id> retry` re-queues the entry; the dispatcher retries. `dome answer <question-id> abandon` marks the row `status: "abandoned"`. `dome answer <question-id> wait` defers re-asking until a configurable cooldown elapses.
5. **`dome.health.outbox-answer-handler` (garden-phase, v1.x)** subscribes to `engine.question.answered` for outbox-class questions and applies the mutation, closing the loop without a per-substrate CLI verb.

The per-CLI-verb shape (`dome doctor --outbox-replay`, `dome doctor --outbox-abandon`) that earlier specs proposed is **retired in favor of the engine-asks model**: the engine raises Questions; the user answers via the universal `dome answer` channel; the `dome.health` bundle's answer-handler processors apply the mutation. This collapses every substrate-mutation verb-noun command into the existing Effect taxonomy.

**v1.0 status.** The `dome.health` bundle and `dome answer` surface are deferred to v1.x per [[wiki/specs/cli]] §`dome doctor` / §`dome answer`. In v1.0, terminal outbox failures land as `status: "failed"` and are visible via `dome show outbox`; recovery requires manual sqlite-level update or `dome rebuild` (which doesn't touch outbox.db). The recovery loop's full shape ships with `dome.health`.

**Specific scenarios:**

- **Credentials revoked.** A calendar-sync bundle's API token expires. Every calendar.write attempt returns 401. After 3 attempts each, multiple entries land in `failed`. The user updates credentials in `<vault>/.dome/config.yaml`, restarts `dome serve`. v1.x: the per-row terminal-failure questions in `dome show questions` (one per failed row) are answered `retry` either individually or via a future bulk-answer surface (e.g., `dome answer --code outbox.terminal-failure --capability calendar.write retry`).

- **Idempotency-key collision with external state.** The vault and the external system disagree on the idempotency key's meaning — the remote rejects the request because "this key has already succeeded" but the vault thinks it failed. The outbox row stays `pending` indefinitely. The user inspects via `dome show outbox --status pending --age 24h+`, identifies the stuck rows. v1.x: the `dome.health.outbox-stuck-pending-question` processor (scheduled, e.g., hourly) emits a Question for rows in `pending` beyond a threshold; user answers `abandon` (if the remote is right and the action already happened) or `replay-with-fresh-key` (if the remote is wrong).

- **Remote service down.** All calendar.write attempts fail with network errors. After exponential backoff exhausts, rows go to `failed`. When the service comes back, the user answers each failed-row question with `retry`.

- **Long-running outage.** If `dome serve` was down for days and accumulated many failed dispatches, the user inspects the per-capability count via `dome show outbox --summary` (v1.x subject), decides whether to abandon old entries or retry them all, then answers the recovery questions in bulk.

**Operational notes:**

- The outbox is **never** wiped by `dome rebuild` — projection.db rebuilds; outbox.db survives. Pinned by [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]] (the rebuild scope is explicit about excluding the outbox).
- Failed entries are not auto-pruned. They accumulate indefinitely unless the user abandons them. This is by design: dropped external actions are a serious failure mode; the user should see them and decide.
- The integration test at `tests/integration/outbox-failure-recovery.test.ts` exercises the failure → replay loop.

**Related:**
- [[wiki/specs/effects]] §"ExternalActionEffect"
- [[wiki/specs/projection-store]] §"Outbox"
- [[wiki/invariants/EXTERNAL_EFFECTS_GO_THROUGH_OUTBOX]]
