---
type: matrix
created: 2026-07-11
updated: 2026-07-13
sources:
  - "[[cohesive/plans/2026-07-11-pwa-first-product]]"
  - "[[wiki/specs/product-host]]"
  - "[[wiki/specs/http-surface]]"
  - "[[wiki/concepts/client-model]]"
description: Versioned second-user and adversarial acceptance matrix for the PWA-first Dome Home product.
---

# PWA product acceptance

**Scenario version:** `dome.product.acceptance/2026-07-11.2`

This matrix is the product release charter. Unit, contract, and interface tests
support it; they do not replace it. Every implementation phase P1–P6 extends
and runs the installed-artifact journey available at that phase.

## Product invariants

| Invariant | Observable acceptance |
|---|---|
| One owner, one vault, many clients | two paired clients share one host without introducing a second human authority model |
| Conversation is a client | host restart may expire the session; vault knowledge and receipts remain |
| Host-mediated write safety | no commit/untouched owner bytes, repaired attributable commit, or explicit divergence |
| External editor coexistence | a concurrent owner edit is never overwritten by rollback or materialization |
| Committed is not adopted | receipt exposes committed/adopted/blocked/diverged separately |
| Logical capture idempotency | retry/archive/receipt rebuild still maps to one committed capture identity |
| Device-specific authority | revoke one client without invalidating another; restore invalidates all |
| Honest offline boundary | text queue is visible/exportable; offline voice/chat are unavailable, not simulated |
| Degraded usefulness | no model/transcription still permits Today, capture, decisions, reads, lexical recall |
| Portable recovery | blank-host restore preserves knowledge/durable decisions and forces local re-pair |

## Phase journeys

| Phase | Installed journey | Exit evidence |
|---|---|---|
| P1 safe capture | loopback pair; save text offline; inspect/export pending; reconnect/retry; committed then adopted | one logical capture; fault-injected mutation reconciliation |
| P2 host + Today | two loopback/in-process clients; slow fake turn; concurrent Today/source read/capture; kill/restart | no head-of-line blocking, stale host lease, orphan, or half-write |
| P3 auth + Ask | enable configured Tailscale origin; pair phone/desktop with different grants; Ask/Stop/Retry/open source; revoke one | exact-origin/CSRF enforcement, session bounds, independent revoke, actor receipts |
| P4 distribution/recovery | clean Mac install; iPhone pair; backup; forced failed N-1 upgrade before admission; rollback; blank-host restore/re-pair | no source checkout/manual build; preserved durable state; credential invalidation |
| P4 backup + blank-host restore checkpoint | bundled age keygen/create/verify/restore; supervised Home suspension; source/evidence-drift refusal; both Product Host locks; seven SQLite snapshots; adversarial verification; absent-target reconstruction | atomic encrypted archive and atomic no-replace publication; archive truth survives restart failure; exact manifest; no native Git dependency; restored credentials/grants invalidated; absent authority reported |
| P4 frozen N-1 migration checkpoint | materialize checked predecessor; prepare; migrate under closed admission; inject post-store-commit crash; retry or restore | six closed SQL/schema/canary proofs; exact candidate protocol compatibility; transactional receipt index migration; no unjournaled mutation; N-1 credential truth restored |
| P4 private candidate cutover checkpoint | suspend Home; prepare/migrate frozen N-1; launch exact managed candidate; prove readiness plus closed pair/capture behavior; drain; fault every selector-switch window; rollback or commit/authorize/release/resume; run competing recovery invocations | transaction-bound probation proof; exact six-store precommit proof; CAS-shaped plist-then-installation switch; candidate-independent prepared/switching rollback; committed-only forward recovery; exact candidate-bound admission; serialized recoverers |
| P5 product quality | installed/offline shell; text queue replay; expired auth; premature SSE EOF; update; keyboard/screen reader; real iOS | product state and accessibility/browser matrix |
| P6 beta | full adversarial journey on at least five external owner-vaults | measured reliability, latency, cost, restore, and upgrade report |

## Adversarial P6 sequence

1. Install the signed macOS artifact on a clean supported host.
2. Initialize or import a vault and start one Product Host.
3. Pair desktop and iPhone with distinct device identities and grants.
4. Run concurrent Ask, Today, adopted source read, text capture, and owner
   question settlement.
5. Confirm model generation holds no vault-wide lease and mutations have one
   deterministic admission order.
6. Modify a target file externally while a mediated mutation is pending; prove
   the external bytes are not overwritten.
7. Kill the host during each mediated-write phase and reconcile after restart.
8. Queue text offline, expose/export it, reconnect, and replay to one logical
   committed/adopted capture.
9. Revoke the phone; prove desktop remains authorized.
10. Take an encrypted consistent backup, force an N-1 upgrade failure before
    write admission, and roll back.
11. Restore onto a blank host, prove every old credential is invalid, and pair
    again through local-console recovery.
12. Rebuild projections and compare Markdown/Git, adopted ref, answers,
    proposals, pending outbox, quarantine, and audit receipts.

## Required measures

- install-to-paired-Ask time;
- locally-saved, committed, and adopted capture latency;
- lost and duplicate logical captures;
- P95 Today/source-read latency during generation;
- mutation queue saturation/conflict/retry outcomes;
- restart reconciliation outcomes and time;
- device pair/revoke/unauthorized outcomes;
- model/transcription cost per active owner;
- backup, migration, rollback, and restore success;
- real iOS/Chromium install, offline shell, update, and accessibility results.

## Explicit non-evidence

- Playwright WebKit alone is not iOS Safari evidence.
- Current-schema reopen is not N-1 migration evidence.
- A copied live SQLite file is not backup evidence.
- A successful HTTP ping is not vault readiness.
- Network request uniqueness is not logical-capture idempotency.
- A green unit suite is not an installed-product journey.
