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

**Symptom:** `dome doctor --show outbox` lists rows in `status: "failed"` with high `attempts` counts. External actions the user expected to fire (calendar events, notifications, webhook POSTs) didn't happen, and retries aren't catching up.

**Root cause:** The external capability handler is failing terminally — the remote service is down, the credentials are invalid, the idempotency key is being rejected by the remote (suggesting a state mismatch), or the handler's max-attempts cap was reached.

**Structural mitigation:** **Visibility + manual replay/abandon controls.**

The outbox is **never** silently discarded — every emitted `ExternalActionEffect` lands in `outbox.db` per [[wiki/invariants/EXTERNAL_EFFECTS_GO_THROUGH_OUTBOX]]. When the engine's automatic retry (exponential backoff up to `maxAttempts`, default 3) exhausts, the row goes to `status: "failed"` and stays. The user can:

1. **Inspect:** `dome doctor --show outbox` lists pending and failed entries with their last error message.
2. **Replay:** `dome doctor --outbox-replay <idempotency-key>` re-queues the entry; the dispatcher retries.
3. **Abandon:** `dome doctor --outbox-abandon <idempotency-key>` marks the row `status: "abandoned"` so it stops attracting attention. Useful for entries that have become irrelevant (the meeting it referenced already happened; the notification window passed).
4. **Bulk fix:** `dome doctor --outbox-replay --capability calendar.write` re-queues every failed entry for a given capability after the user fixed credentials.

The engine emits `engine.outbox.failed` events on terminal failures; future surfaces (mobile app, web UI) can subscribe and surface to the user.

**Specific scenarios:**

- **Credentials revoked.** A calendar-sync bundle's API token expires. Every calendar.write attempt returns 401. After 3 attempts each, multiple entries land in `failed`. The user updates credentials in `<vault>/.dome/config.yaml`, restarts `dome serve`, runs `dome doctor --outbox-replay --capability calendar.write`. Each entry retries against the new credentials.

- **Idempotency-key collision with external state.** The vault and the external system disagree on the idempotency key's meaning — the remote rejects the request because "this key has already succeeded" but the vault thinks it failed. The outbox row stays `pending` indefinitely. The user inspects via `dome doctor --show outbox --status pending --age 24h+`, identifies the stuck rows, and either abandons (if the remote is right and the action already happened) or replays with a fresh key (if the remote is wrong).

- **Remote service down.** All calendar.write attempts fail with network errors. After exponential backoff exhausts, rows go to `failed`. When the service comes back, the user runs `dome doctor --outbox-replay --status failed --capability calendar.write`.

- **Long-running outage.** If `dome serve` was down for days and accumulated many failed dispatches, the user inspects the per-capability count via `dome doctor --show outbox --summary`, decides whether to abandon old entries or replay them all, then bulk-acts.

**Operational notes:**

- The outbox is **never** wiped by `dome rebuild` — projection.db rebuilds; outbox.db survives. Pinned by [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]] (the rebuild scope is explicit about excluding the outbox).
- Failed entries are not auto-pruned. They accumulate indefinitely unless the user abandons them. This is by design: dropped external actions are a serious failure mode; the user should see them and decide.
- The integration test at `tests/integration/outbox-failure-recovery.test.ts` exercises the failure → replay loop.

**Related:**
- [[wiki/specs/effects]] §"ExternalActionEffect"
- [[wiki/specs/projection-store]] §"Outbox"
- [[wiki/invariants/EXTERNAL_EFFECTS_GO_THROUGH_OUTBOX]]
