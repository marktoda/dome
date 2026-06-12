---
type: gotcha
description: "Outbox rows stuck in status failed with high attempts; expected external actions (calendar, webhooks, notifications) never fire."
created: 2026-05-27
updated: 2026-06-02
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
coverage: off-matrix
enforced_at: src/outbox/dispatch.ts
enforced_at_status: deferred
first_observed: 2026-05-27 (anticipated; surfaced in v1 design)
severity: medium
---

# Outbox stuck

**Symptom:** `dome status --json` routes to `dome check --json`, which reports outbox rows in `status: "failed"` with high `attempts` counts. External actions the user expected to fire (calendar events, notifications, webhook POSTs) didn't happen, and retries aren't catching up.

**Root cause:** The external capability handler is failing terminally — the remote service is down, the credentials are invalid, the idempotency key is being rejected by the remote (suggesting a state mismatch), or the handler's max-attempts cap was reached.

**Structural mitigation:** **Visibility + engine-asks recovery via QuestionEffect / `dome resolve`.**

The outbox is **never** silently discarded — every emitted `ExternalActionEffect` lands in `outbox.db` per [[wiki/invariants/EXTERNAL_EFFECTS_GO_THROUGH_OUTBOX]]. When the engine's automatic retry (exponential backoff up to `maxAttempts`, default 3) exhausts, the row goes to `status: "failed"`. The recovery loop is engine-asks rather than user-imperative:

1. **Health probe observes a terminal row.** Failed rows are visible to `dome check` and, for row-level detail, `dome doctor` / `dome inspect outbox`.
2. **`dome.health.outbox-recovery-questions` (garden-phase, scheduled) reads failed rows through `ctx.operational`** and emits a `QuestionEffect` with options `["retry", "abandon"]`, `idempotencyKey` prefixed with `dome.health.outbox-recovery:` plus a failure-instance suffix, and `sourceRefs` pointing at the failed row's originating source. The failure-instance suffix means a row that is retried and fails again can raise a fresh open question instead of being hidden behind the already-answered one.
3. **User inspects:** `dome check --json` lists the open recovery questions; advanced `dome inspect outbox` lists pending and failed entries with their last error message.
4. **User resolves:** `dome resolve <question-id> retry` re-queues the entry; the dispatcher retries. `dome resolve <question-id> abandon` marks the row `status: "abandoned"`.
5. **`dome.health.outbox-recovery-answer` (garden-phase)** declares an `answer` trigger for outbox recovery questions and emits an `OutboxRecoveryEffect`, closing the loop without a per-substrate CLI verb.

The per-CLI-verb shape (`dome doctor --outbox-replay`, `dome doctor --outbox-abandon`) that earlier specs proposed is **retired in favor of the engine-asks model**: the engine raises Questions; the user answers via the universal `dome resolve` channel; the `dome.health` bundle's answer-handler processors apply the mutation. This collapses every substrate-mutation verb-noun command into the existing Effect taxonomy.

**Current status.** `dome resolve` / `dome answer`, answer-trigger dispatch, the
`OutboxRecoveryEffect` sink, and first-party `dome.health` failed-outbox
retry/abandon questions all ship. Terminal outbox failures land as
`status: "failed"`, are visible via `dome check` / `dome inspect outbox`, and can be
recovered through `dome check --json` + `dome resolve`.

**Specific scenarios:**

- **Credentials revoked.** A calendar-sync bundle's API token expires. Every calendar.write attempt returns 401. After 3 attempts each, multiple entries land in `failed`. The user updates credentials in `<vault>/.dome/config.yaml`, restarts `dome serve`. The per-row terminal-failure questions in `dome check --json` (one per failed row) are answered `retry` either individually or via a future bulk-resolve surface (e.g., `dome resolve --code outbox.terminal-failure --capability calendar.write retry`).

- **Idempotency-key collision with external state.** The vault and the external system disagree on the idempotency key's meaning — the remote rejects the request because "this key has already succeeded" but the vault thinks it failed. The outbox row stays `pending` indefinitely. The user starts with `dome check --json` and can inspect row-level detail with `dome inspect outbox`. A future `dome.health.outbox-stuck-pending-question` processor (scheduled, e.g., hourly) can emit a Question for rows in `pending` beyond a threshold; user resolves `abandon` (if the remote is right and the action already happened) or `replay-with-fresh-key` (if the remote is wrong).

- **Remote service down.** All calendar.write attempts fail with network errors. After exponential backoff exhausts, rows go to `failed`. When the service comes back, the user answers each failed-row question with `retry`.

- **Long-running outage.** If `dome serve` was down for days and accumulated many failed dispatches, `dome check --json` exposes the open recovery questions. A future bulk-resolve surface can help abandon old entries or retry them all.

**Operational notes:**

- The outbox is **never** wiped by `dome rebuild` — projection.db rebuilds; outbox.db survives. Pinned by [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]] (the rebuild scope is explicit about excluding the outbox).
- Failed entries are not auto-pruned. They accumulate indefinitely unless the user abandons them. This is by design: dropped external actions are a serious failure mode; the user should see them and decide.
- `tests/harness/scenarios/effect-routing/health-outbox-recovery.scenario.test.ts` exercises the failure → question → retry/abandon recovery loop.

**Related:**
- [[wiki/specs/effects]] §"ExternalActionEffect"
- [[wiki/specs/projection-store]] §"Outbox"
- [[wiki/invariants/EXTERNAL_EFFECTS_GO_THROUGH_OUTBOX]]
