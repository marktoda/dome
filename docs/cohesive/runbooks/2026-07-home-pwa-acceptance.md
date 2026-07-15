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
   Candidate publication means the existing installed N-1→N scenarios passed,
   including UI pairing, validated Connection readiness, controlled offline
   reload, uncached `/readyz`, local capture/export, revoke, auth repair, and
   one logical replay in system Chrome. Before pairing, Chrome also validates
   the emitted platform metadata and decodes the exact favicon, SVG, touch,
   `any`, and maskable icon set at their declared dimensions.
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

Record failures and device details. Playwright WebKit, desktop responsive mode,
or the automated Chrome journey is not real-device iOS Safari evidence.

## Checked-in P5.5a portable contract gates

The focused surface, HTTP, and PWA suites must prove that Activity reads only
the current branch's adopted ancestry, is empty before initialization, excludes
a newer unadopted edit, and opens its exact path and commit only with read
access. They must also prove one pending task settlement, polite success,
alerting failure, and explicit single-flight Retry. The implementation retains
the normal App refresh path without adding an App-level acknowledgement; its
exact installed behavior remains part of the deferred journey below.

These portable checks do not prove the exact installed Activity/settlement
journey and do not replace the P5.5b adaptive-layout, focus, screen-reader,
safe-area, dynamic-type, touch-target, visual, or real-device owner-hardware
evidence.

## Current nonclaims

The P5.4 manifest/icon contract is checked in and artifact-gated. P5.5a has
portable contract-test evidence only; its exact installed Activity/settlement
journey remains P5.5b/owner evidence. Neither claims that Chrome presents or
completes its install UI or replaces a real-device iOS visual check. Until
separately delivered and recorded, this runbook also does not claim automated waiting-worker replacement,
visual-regression coverage, the P5.5 accessibility/safe-area/dynamic-type
matrix, signed execution without the three Apple inputs, or clean-consumer
acceptance without the clean Mac run above.
