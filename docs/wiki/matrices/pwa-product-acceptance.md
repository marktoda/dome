---
type: matrix
created: 2026-07-11
updated: 2026-07-15
sources:
  - "[[cohesive/plans/2026-07-11-pwa-first-product]]"
  - "[[wiki/specs/product-host]]"
  - "[[wiki/specs/http-surface]]"
  - "[[wiki/concepts/client-model]]"
description: Versioned second-user and adversarial acceptance matrix for the PWA-first Dome Home product.
---

# PWA product acceptance

**Scenario version:** `dome.product.acceptance/2026-07-11.7`

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
| P4 public upgrade intent checkpoint | invoke only `dome home upgrade --vault ...`; inspect `dome home status`; retry retained precommit work; repair a broken committed candidate from the exact invoking artifact; retire terminal evidence | lazy CLI imports only the intent; no phase/recovery/artifact-path controls; fixed redacted v1 results; phase-free lockless status; candidate requires explicit capability; exact 0.3 release metadata becomes true only after the mandatory retained installed N-1→N gate and staged-identity reproof, with explicit 0.2→0.3 coverage and no public bypass |
| P4 guided model setup checkpoint | configure/check/remove the shipped Anthropic credential; preview/apply exact legacy plaintext cleanup; crash after selector/tombstone boundaries; launch normal packaged Home; rotate while a request is in flight; inspect missing/custom config, locked Keychain, unknown residue, active upgrade, and legacy residue; launch source and probation modes | native hidden prompt and decrypting readback; the Dome Bun host never receives secret bytes while the fixed provider child receives only an explicit scrubbed environment; helper executes only manifest-bound immutable Bun and provider payloads verified by held descriptors, compiled hashes, and final inode reproof, with no endpoint override; derived model-only setup state and live local readiness; preview-first lifecycle-owned cleanup with verified release binding, active-upgrade refusal, terminal-history pruning, transient tombstone visibility, and clean-before-resume proof; copied vault identity cannot alias a credential; live subsequent-launch rotation; custom config preserved; source behavior unchanged; probation performs no provider or Keychain reads; helper capability is signed and required for new candidates while historical 0.2 manifests remain verifiable |
| P5 product quality | installed/offline shell; text queue replay; expired auth; premature SSE EOF; update; keyboard/screen reader; real iOS | product state and accessibility/browser matrix |
| P5.1 honest offline shell checkpoint | boot a previously paired device without Home; capture/export locally; reconnect; encounter a waiting asset update; probe arbitrary static and API paths | static-only GenerateSW precache with root-only navigation fallback; no cached API documents; explicit update activation; offline/unreachable distinct from unpaired; live actions disabled while text capture remains; blind proposal decisions absent; closed static root and root PWA gate |
| P5.2 authenticated Connection checkpoint | validate ready, degraded, blocked, incompatible, revoked, offline, and unreachable Home evidence; race old 401/failure with newer success; re-pair with queued text | strict authenticated readiness parsing; monotonic single-flight evidence; prior document is visibly stale context only; one pure capability/readiness access derivation; compact accessible Connection details and text next actions; local queue survives auth loss |
| P5.3 installed Chromium checkpoint | run the exact installed candidate's supervised ready-success Home in the installed system Google Chrome stable channel; pair through the UI; control the service worker; reload offline; save/export text; revoke; reconnect; re-pair and replay | prepublication artifact-bound browser gate; strict Connection-ready evidence; uncached offline `/readyz`; visible durable queue across auth loss; one logical capture; ephemeral browser context with no trace/HAR/video/screenshot/storage-state artifact |
| P5.4 install identity checkpoint | inspect the emitted head and manifest; decode the exact favicon/SVG/touch/any/maskable assets in installed Chrome; probe precache and arbitrary root images | tracked version-pinned generated assets; stable `/` identity; separate explicit purposes; opaque full-bleed maskable/Apple pixels; exact no-cache static allowlist and duplicate-free static-only precache; no install-UI or real-iOS claim |
| P5.5a portable functional closure checkpoint | portable fixtures/components only: add a newer unadopted edit, open an Activity row, complete a task, and retry one faulted settlement | surface/HTTP/component tests show Activity excludes unadopted `HEAD` and opens the exact adopted commit behind `access.read`; settlement has one pending/success/failure lifecycle, polite success, alerting failure, and single-flight Retry; adaptive installed Chrome continues in P5.5b while the exact functional installed journey remains owner evidence |
| P5.5b adaptive accessibility checkpoint | after readiness, inspect the installed ready shell at 320×568, 390×844, and 844×390; Tab once; emulate reduced motion; reset to 390×844 and continue the existing journey | implemented artifact-bound gate for no horizontal overflow, enabled visible controls/coarse targets ≥44×44 (inline prose links excepted), critical containment, visible ≥3px focus, and disabled computed motion; portable modal/safe-axis/contrast tests; fresh exact evidence requires artifact execution; real-iPhone/keyboard/Dynamic Type/VoiceOver/Safari and waiting-worker N→N+1 remain separate |
| P6 managed-release collection checkpoint 1 | inspect a shared Home store with multiple vault selectors, active upgrades, stale vault paths, exact crash debris, and adversarial near misses; kill a coordinator owner and fault collection at every rename boundary | one dormant host-wide interface; persistent root-bound SQLite kernel mutex; selected plus active old/candidate id/version/hash reachability; history never pins; one full verification per payload plus cheap per-candidate rescans; parent/candidate reproof; exclusive tombstone/fsync/reproof/remove/fsync; structural proof of no production caller; activation reviewed separately |
| P6 managed-release collection checkpoint 2A | race first coordinator initialization; fault and retry every first-install directory fsync plus post-database-rename coordinator durability; reject forged/cross-root/expired owners and reversed ranks; replace evidence during a throwing callback; pause fresh and same-artifact install after release publication; contend a collector/writer; observe plist and readiness | canonical Home-bound opaque owner; lifecycle → operational → [host when applicable] → global → artifact hierarchy and concrete ordinary-install lifecycle → operational → global → artifact → durable-selector span; retry-convergent crash-durable component-wise ancestor publication; deep release-through-selector interface; global released before activation; exact module-seam fence; collector still dormant pending upgrade/retirement checkpoint 2B |
| P6 managed-release collection checkpoint 2B | pause candidate preparation after active fsync/readback, committed repair after release reproof and during selector replay, and retirement after both parent fsyncs; contend the zero-wait collector; inject every retirement crash seam and collect before retry; fail upgrade-namespace stabilization | lifecycle → operational → optional host → global → artifact ordering across every release reachability writer; candidate global span ends before migration; committed repair span ends before selector replay; retirement span includes active→history reproof plus history-before-upgrade fsync; one linear pre-inventory crash-convergence pass; exact structural seams; collector remains dormant pending separate activation policy |
| P6 managed-release collection checkpoint 3 — manual activation | run `dome home cleanup` from a non-vault cwd with missing, clean, unreachable, busy, redirected, and partially-collected Home stores; repeat with explicit `--apply`; try both inherited `--vault` positions; inspect JSON and human output | one host-wide path-free `dome.home.cleanup/v1` interface; default inspect removes nothing; apply removes the exact ordered candidate set or reports unknown evidence; absent Home is a zero no-op; fixed exits 0/1/64/75; one lazy CLI Adapter only; no SDK, scheduler, daemon, HTTP, MCP, or automatic caller |
| P6 managed-release collection checkpoint 4 — post-retirement advisory | finish fresh committed, recovered committed, restored, rerun, unhealthy, and retirement-failure upgrade paths; inspect JSON/human output and production callsites | healthy committed retirement preserves upgrade schema/status/exit and gives one count-free optional `dome home cleanup` action; rollback and every stronger action win; no automatic inventory, fsync, global owner, cleanup apply, or candidate claim |
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
