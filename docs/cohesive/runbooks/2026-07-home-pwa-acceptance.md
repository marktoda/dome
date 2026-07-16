---
type: runbook
tags: [pwa, home, release, acceptance]
created: 2026-07-15
status: ready
sources:
  - "[[cohesive/plans/2026-07-11-pwa-first-product]]"
  - "[[wiki/matrices/pwa-product-acceptance]]"
  - "[[wiki/specs/product-host]]"
---

# Runbook — accept a Dome Home PWA release

Use a clean `main` worktree on an Apple Silicon Mac. Record the date, Dome
artifact id/version, macOS version, Chrome version, iPhone/iOS version, and
each result. A skipped row is not a pass.

## Automated installed-Chromium gate

1. Install repository and PWA dependencies with the frozen locks:
   `bun install --frozen-lockfile` and
   `bun install --cwd pwa --frozen-lockfile`.
2. Install or update Google Chrome through its normal system distribution.
   Dome intentionally does not download or ship a browser.
3. Run `bun run build:home-artifact -- --output <new-absent-directory>`.
   The frozen 0.1 predecessor may cross its historical ten-second readiness
   window under build load; the gate permits only its exact installed/loaded
   timeout envelope, then independently requires bounded, identity-bound
   readiness before continuing.
   Candidate publication means the existing installed N-1→N scenarios passed,
   including UI pairing, validated Connection readiness, controlled offline
   reload, uncached `/readyz`, local capture/export, revoke, auth repair, and
   one logical replay in system Chrome. Before pairing, Chrome also validates
   the emitted platform metadata and decodes the exact PNG, SVG, touch,
   `any`, and maskable icon set at their declared dimensions. After readiness,
   it checks 320×568, 390×844, and 844×390 for overflow, 44px enabled controls
   and coarse targets (excluding inline prose links), critical-control
   containment, visible keyboard focus, and reduced-motion computed styles,
   then resets to 390×844 for the remaining journey.
   The release-only functional gate gives H→adopted→Activity+Today one
   60-second convergence budget after its separately bounded human commit.
   After Chrome receives S, adoption, Today removal, and the final Git/Markdown
   proof share one overall 60-second budget. The containing task-settlement
   Chrome phase is 120 seconds so its click/receipt and final reload checks do
   not consume either convergence budget; every other Chrome phase remains 30
   seconds.
4. Record `/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --version`
   beside the artifact id and archive SHA-256 printed by the builder. Preserve
   the builder's installed-activation evidence.

The browser context is ephemeral. The gate must not create or retain a trace,
HAR, video, screenshot, browser profile, or storage-state file. A phase-only
failure is intentional; fix the product or browser precondition and rerun from
a new absent output path.

## Signed distribution gate

With a real Developer ID Application identity, matching team id, and existing
`notarytool` Keychain profile, run:

`DOME_CODESIGN_IDENTITY='<identity>' DOME_APPLE_TEAM_ID='<team-id>' DOME_NOTARY_KEYCHAIN_PROFILE='<profile>' bun run build:home-distribution -- --output <new-absent-envelope>`

Record the receipt hash, artifact id, DMG hash, and `Accepted` notarization
status printed by the builder. This execution cannot be replaced by hermetic
tests or an unsigned artifact build.

## Owner hardware gates

On a clean consumer Mac, open the DMG and confirm Gatekeeper accepts it, install
Home, initialize/import a scratch vault, start Home, and pair without a source
checkout. In current desktop Chrome and on a real iPhone in Safari, verify:

- pairing and Connection details are understandable;
- offline shell and text capture survive reload;
- revocation leads to re-pair without losing the local queue;
- keyboard-only pairing/capture/Connection operation and visible focus;
- VoiceOver announces status changes and controls in a useful order;
- 200% zoom, iOS dynamic type, safe areas, and 44px touch targets remain usable.
- with Calendar access granted and a calendar source producing events, install
  one ordinary same-Bun upgrade and confirm the post-upgrade scheduled fetch
  still produces events without another privacy prompt. The first cutover from
  a historical release-scoped Home executable to the stable Home identity may
  require one explicit re-grant; record it separately. Any later same-Bun
  upgrade prompt or `No calendars` result is a release failure.

Record failures and device details. Playwright WebKit, desktop responsive mode,
or the automated Chrome journey is not real-device iOS Safari evidence.

## P6 local owner-beta packet

Use `dome.home.beta-protocol/2026-07-15.1`. Consent, external-owner status, and
the fact that five packets belong to five distinct owners are manual truths;
the validator deliberately retains no identity that could prove them. Use one
monotonic clock for every elapsed duration. Record all twelve protocol steps,
both fixed capture cases, and the one owner-observable
`mid-operation-reconcile` restart. Do not discard slow, timed-out, failed, or
not-run observations. The internal before/after-ref and checkout-repair fault
phases belong to installed/test automation and are not owner-beta fields.

Use these exact owner clocks and collection budgets (a timeout duration equals
the budget; these are collection termination rules, not latency SLOs):

- install→paired Ask: start immediately before opening the signed DMG; stop at
  the first complete non-stale Ask response after pairing; 900,000 ms;
- active-generation reads: perform exactly twenty rounds in order. On desktop,
  start one Ask. While that same Ask is visibly streaming, use the paired phone
  to activate the always-visible `Refresh Today`; start its clock at activation
  and wait for the persistent `Today is fresh.` or visible failed terminal.
  Then, while that Ask is still visibly streaming, activate one existing
  Activity/citation source control for a preselected exact adopted SourceRef;
  start its clock at activation and wait for SourceViewer's accessible `Source
  loaded` or `Source failed to load` terminal. If either activation starts
  after streaming ends, record that slot `not-run`. Let the Ask finish, then
  begin the next round. Each clock has a 30,000 ms budget; preserve both exact
  twenty-element arrays and round order. Do not dispatch forty unawaited
  requests, select results post hoc, or use automation, developer tools, a
  direct API, or a script caller;
- capture: start when Save is activated; stop the three clocks at the durable
  local row, attributable commit receipt, and same logical capture at the
  current adopted commit; 10,000/120,000/180,000 ms;
- mid-operation reconcile: first confirm exactly one Home is running. While a
  mediated mutation is visibly pending, start the clock, open Activity Monitor,
  select the exact managed process named `Dome Home`, and choose Force Quit.
  Wait for
  launchd `KeepAlive` to restart it automatically; do not manually relaunch it.
  Stop at authenticated readiness plus a closed non-pending UI receipt for that
  mutation; 300,000 ms. At the budget record `timeout`; there is no unsafe
  fallback. Do not substitute a quiescent `dome home restart`, and do not
  inspect or record a PID, launch label, or internal write phase;
- initial/after-restart/after-restore readiness: start immediately before the
  corresponding launch or quiescent restart and stop at authenticated
  readiness; 300,000 ms each;
- each journey step, recovery action, and real-client platform action starts at
  the named owner action and ends at its fresh runtime-valid UI result;
  900,000 ms. Device actions use the same rule with 120,000 ms.

Authenticated readiness means the current UI has runtime-validated a fresh
`dome.product.readiness/v1` for the expected product version and current
device/vault session, with `host.state: ready`, `writesAdmitted: true`,
`adoption.state: current`, and the required device capability. Stale context,
liveness, and pairing status do not count.

The two capture `start-to-adopt` clocks are the only adoption-latency samples.
Also record the exact mutation queue partition and saturation/conflict/retry
counts, device pair/revoke/unauthorized/remaining-authorized outcomes,
backup/migration/rollback/restore outcomes, and real Chromium plus iOS
install/offline/update/accessibility outcomes. Set an iOS or Chromium major to
`null` only when every outcome for that platform is `not-run`; once any check
runs, its coarse major is required.

The closed packet shape is illustrated below. The repeated scheduled outcomes
are all written out so this example can be parsed and validated without a
template-expansion convention.

```json
{
  "schema": "dome.home.beta-evidence/v1",
  "protocol": "dome.home.beta-protocol/2026-07-15.1",
  "product": {
    "version": "0.3.0",
    "target": "darwin-arm64",
    "distributionReceiptSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "environment": {
    "date": "2026-07-15",
    "macosMajor": 15,
    "iosMajor": 18,
    "chromiumMajor": 138
  },
  "attestations": {
    "consented": true,
    "externalOwner": true,
    "withoutDeveloperIntervention": true
  },
  "steps": {
    "install": { "outcome": "ok", "durationMs": 1 },
    "vault-start": { "outcome": "ok", "durationMs": 1 },
    "pair": { "outcome": "ok", "durationMs": 1 },
    "concurrent-use": { "outcome": "ok", "durationMs": 1 },
    "mutation-admission": { "outcome": "ok", "durationMs": 1 },
    "external-edit": { "outcome": "ok", "durationMs": 1 },
    "restart-reconciliation": { "outcome": "ok", "durationMs": 1 },
    "offline-replay": { "outcome": "ok", "durationMs": 1 },
    "revoke-isolation": { "outcome": "ok", "durationMs": 1 },
    "backup-upgrade-rollback": { "outcome": "ok", "durationMs": 1 },
    "blank-host-restore": { "outcome": "ok", "durationMs": 1 },
    "projection-rebuild-audit": { "outcome": "ok", "durationMs": 1 }
  },
  "observations": {
    "installToPairedAsk": { "outcome": "ok", "durationMs": 1 },
    "todayDuringGeneration": [
      { "outcome": "ok", "durationMs": 1 },
      { "outcome": "ok", "durationMs": 2 },
      { "outcome": "ok", "durationMs": 3 },
      { "outcome": "ok", "durationMs": 4 },
      { "outcome": "ok", "durationMs": 5 },
      { "outcome": "ok", "durationMs": 6 },
      { "outcome": "ok", "durationMs": 7 },
      { "outcome": "ok", "durationMs": 8 },
      { "outcome": "ok", "durationMs": 9 },
      { "outcome": "ok", "durationMs": 10 },
      { "outcome": "ok", "durationMs": 11 },
      { "outcome": "ok", "durationMs": 12 },
      { "outcome": "ok", "durationMs": 13 },
      { "outcome": "ok", "durationMs": 14 },
      { "outcome": "ok", "durationMs": 15 },
      { "outcome": "ok", "durationMs": 16 },
      { "outcome": "ok", "durationMs": 17 },
      { "outcome": "ok", "durationMs": 18 },
      { "outcome": "ok", "durationMs": 19 },
      { "outcome": "ok", "durationMs": 20 }
    ],
    "sourceDuringGeneration": [
      { "outcome": "ok", "durationMs": 1 },
      { "outcome": "ok", "durationMs": 2 },
      { "outcome": "ok", "durationMs": 3 },
      { "outcome": "ok", "durationMs": 4 },
      { "outcome": "ok", "durationMs": 5 },
      { "outcome": "ok", "durationMs": 6 },
      { "outcome": "ok", "durationMs": 7 },
      { "outcome": "ok", "durationMs": 8 },
      { "outcome": "ok", "durationMs": 9 },
      { "outcome": "ok", "durationMs": 10 },
      { "outcome": "ok", "durationMs": 11 },
      { "outcome": "ok", "durationMs": 12 },
      { "outcome": "ok", "durationMs": 13 },
      { "outcome": "ok", "durationMs": 14 },
      { "outcome": "ok", "durationMs": 15 },
      { "outcome": "ok", "durationMs": 16 },
      { "outcome": "ok", "durationMs": 17 },
      { "outcome": "ok", "durationMs": 18 },
      { "outcome": "ok", "durationMs": 19 },
      { "outcome": "ok", "durationMs": 20 }
    ],
    "captures": {
      "online": {
        "start-to-local": { "outcome": "ok", "durationMs": 1 },
        "start-to-commit": { "outcome": "ok", "durationMs": 2 },
        "start-to-adopt": { "outcome": "ok", "durationMs": 3 },
        "lostLogicalCaptures": 0,
        "duplicateLogicalCaptures": 0
      },
      "offline-replay": {
        "start-to-local": { "outcome": "ok", "durationMs": 1 },
        "start-to-commit": { "outcome": "ok", "durationMs": 2 },
        "start-to-adopt": { "outcome": "ok", "durationMs": 3 },
        "lostLogicalCaptures": 0,
        "duplicateLogicalCaptures": 0
      }
    },
    "restart": {
      "mid-operation-reconcile": { "outcome": "ok", "durationMs": 1 }
    },
    "readiness": {
      "initial": { "outcome": "ok", "durationMs": 1 },
      "after-restart": { "outcome": "ok", "durationMs": 1 },
      "after-restore": { "outcome": "ok", "durationMs": 1 }
    },
    "mutationQueue": {
      "scheduled": 3,
      "success": 3,
      "timeout": 0,
      "failed": 0,
      "notRun": 0,
      "saturationEvents": 0,
      "conflictEvents": 0,
      "retryAttempts": 0
    },
    "device": {
      "desktop-pair": { "outcome": "ok", "durationMs": 1 },
      "phone-pair": { "outcome": "ok", "durationMs": 1 },
      "phone-revoke": { "outcome": "ok", "durationMs": 1 },
      "revoked-unauthorized": { "outcome": "ok", "durationMs": 1 },
      "desktop-authorized": { "outcome": "ok", "durationMs": 1 }
    },
    "recovery": {
      "backup": { "outcome": "ok", "durationMs": 1 },
      "migration": { "outcome": "ok", "durationMs": 1 },
      "rollback": { "outcome": "ok", "durationMs": 1 },
      "restore": { "outcome": "ok", "durationMs": 1 }
    },
    "platform": {
      "chromium": {
        "install": { "outcome": "ok", "durationMs": 1 },
        "offline": { "outcome": "ok", "durationMs": 1 },
        "update": { "outcome": "ok", "durationMs": 1 },
        "accessibility": { "outcome": "ok", "durationMs": 1 }
      },
      "ios": {
        "install": { "outcome": "ok", "durationMs": 1 },
        "offline": { "outcome": "ok", "durationMs": 1 },
        "update": { "outcome": "ok", "durationMs": 1 },
        "accessibility": { "outcome": "ok", "durationMs": 1 }
      }
    },
    "cost": {
      "model": { "source": "run-ledger", "microUsd": 1000 },
      "transcription": { "source": "not-used", "microUsd": 0 }
    }
  }
}
```

Validate one packet without publishing it:

`bun scripts/home-beta-evidence.ts validate --input <packet.json> --expected-version <semver> --expected-receipt <sha256>`

After separately verifying consent, external-owner truth, and five distinct
owners, aggregate at least five explicit packets and record that completed
operator review:

`bun scripts/home-beta-evidence.ts aggregate --input <one.json> --input <two.json> --input <three.json> --input <four.json> --input <five.json> --expected-version <semver> --expected-receipt <sha256> --operator-reviewed --require-ready`

Both commands emit JSON only. The aggregate omits filenames, packet rows,
dates, environments, and all hashes except the expected public receipt binding.
It cannot prove distinct ownership or consent. Without `--operator-reviewed`,
an otherwise qualifying aggregate is `review-required` and `--require-ready`
exits 1. Use the flag only after the out-of-band review above. Readiness also
requires every one of the 5–100 submitted packets to qualify; any failure is
`not-ready` even with the flag. Validation cannot complete manual review. The
report retains only closed review check names/status, never identity. Never
drop a failed scheduled run after collection.

## Checked-in P5.5a portable contract gates

The focused surface, HTTP, and PWA suites must prove that Activity reads only
the current branch's adopted ancestry, is empty before initialization, excludes
a newer unadopted edit, and opens its exact path and commit only with read
access. They must also prove one pending task settlement, polite success,
alerting failure, and explicit single-flight Retry. The implementation retains
the normal App refresh path without adding an App-level acknowledgement; its
exact installed behavior remains owner evidence below.

These portable checks do not prove the exact installed Activity/settlement
journey. P5.5b adds the installed Chrome adaptive gate. P5.5c implements the
artifact-bound functional journey: one ordinary human Git canary becomes
adopted Activity and due-today truth; Chrome opens its exact commit and bytes,
restores focus on Escape, clicks completion once, binds the exact successful
settlement receipt, and reloads after a bounded host proof of that adopted
commit and its Done-today record. Portable component tests own the transient
pending/success presentation because refresh may remove the installed row.
The Chrome grant is exactly `read,capture,resolve`; neither runner uses an
engine write API. Portable ordering and canary tests remain explicitly
non-evidence. Fresh exact evidence requires running the artifact builder.
The 60-second H and S windows are release-gate convergence bounds, not product
request timeouts: H gets one window after its 15-second deterministic setup,
while S adoption and final evidence share one overall window.

## Checked-in P5.6 waiting-worker gate

After the existing installed Chromium journey closes, `ready-success` passes
only the extracted candidate `app/pwa/dist` directory to the update rehearsal.
The rehearsal uses one ephemeral static-only loopback origin and one ephemeral
system-Chrome context. It does not start or proxy Home and does not pair a
second device. A non-secret local-evidence cookie lets the static `/readyz`
404 reach the limited capture shell.

The runner derives N in memory from the exact N+1 inventory: one fixed meta
marker is inserted in `index.html`, and only the singular matching Workbox
index MD5 in `sw.js` is changed. It refuses stale or duplicate revisions,
symlinks, unbounded inventories, unsafe paths, and missing generation files.
The gateway atomically switches from N to the untouched extracted candidate.

Chrome must establish N service-worker control and the marked DOM, save one
text capture through the UI, then observe N+1 as a visible waiting update while
the old controller and N DOM remain active. Only `Update now` may activate it.
After a recorded `controllerchange` reload, the marker is absent, waiting is
null, browser-fetched index/worker SHA-256 values match the candidate, and the
exact IndexedDB capture id/text/local state remains. The gate deletes the row
through the UI before destroying its context. No browser profile, trace, HAR,
video, screenshot, download, or storage-state evidence is retained.

The claim is limited to waiting-worker activation and local IndexedDB row
survival. It is not capture replay, engine/vault persistence, logical capture
idempotency, API compatibility, install UI, multi-tab, background-update, or
real-device Safari evidence. Portable generation, gateway, phase-order,
timeout-settlement, and cleanup suites are explicitly non-evidence.

## Current nonclaims

The P5.4 manifest/icon contract is checked in and artifact-gated. P5.5a has
portable contract-test evidence. P5.5b, P5.5c, and P5.6 implement artifact-bound
adaptive, functional, and waiting-worker Chrome gates; fresh exact installed
Chrome evidence requires running the artifact builder above. These checkpoints do not claim Chrome install UI,
real-iPhone portrait/landscape/notch or software-keyboard behavior, Dynamic
Type/200%, VoiceOver, Safari touch/microphone flows, visual regression, capture
replay in the isolated update journey, or engine persistence from that journey. Signed execution still requires
the three Apple inputs; clean-consumer acceptance still requires the clean Mac
run above.
