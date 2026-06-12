#!/bin/sh
# drain-captures.sh — sweep the iCloud-Drive capture queue into the vault.
#
# This file is SDK-shipped vault-side data, not SDK code (the model-provider
# template precedent: nothing under src/ executes it). It is the laptop half
# of eventually-consistent phone capture: when the iOS Shortcut
# (`dome recipe ios`) cannot reach POST /capture, it leaves the dictation as
# `<timestamp>-<uuid>.md` in iCloud Drive `DomeCaptures/`; this script
# drains that queue through `dome capture`.
#
# Deliberately an EXTERNAL JOB (launchd StartInterval LaunchAgent printed by
# `dome recipe capture-queue` — the manual dome-http unit precedent), NOT a
# dome.sources subscription: that contract is one output file per period
# with snapshot skip-if-present and HEAD-verified completion
# (wiki/specs/sources.md), and a many-files drain violates all of it.
#
# Contract:
#   - $1 (or $DOME_CAPTURE_QUEUE) = queue directory; default
#     iCloud Drive root: ~/Library/Mobile Documents/com~apple~CloudDocs/DomeCaptures
#   - Run from the vault root (the LaunchAgent's WorkingDirectory), or set
#     $DOME_VAULT; `dome capture` otherwise resolves the vault from cwd.
#   - Per `*.md` queue file: `dome capture --file <f> --capture-id <stem>`.
#     Exit 0 (captured OR duplicate) → delete the queue file; non-zero →
#     keep it and retry next interval.
#   - Idempotent across a crash between capture and delete: the captureId
#     (= the filename stem) makes the re-run answer `duplicate`, which is
#     still exit 0, so the queue file is still deleted — never double-filed.
#   - Empty or missing queue directory → exit 0, silent.

set -u

QUEUE_DIR="${1:-${DOME_CAPTURE_QUEUE:-$HOME/Library/Mobile Documents/com~apple~CloudDocs/DomeCaptures}}"
DOME_BIN="${DOME_BIN:-dome}"

[ -d "$QUEUE_DIR" ] || exit 0

# iCloud placeholders (`.<name>.md.icloud`) are queue entries the phone
# uploaded but this machine has not downloaded yet: request the download
# (best effort) and pick the real file up on a later interval.
for placeholder in "$QUEUE_DIR"/.*.md.icloud; do
  [ -e "$placeholder" ] || continue
  if command -v brctl >/dev/null 2>&1; then
    brctl download "$placeholder" || true
  fi
done

status=0
for f in "$QUEUE_DIR"/*.md; do
  [ -e "$f" ] || continue # unexpanded glob = empty queue → exit 0, silent
  id="$(basename "$f" .md)"
  if "$DOME_BIN" capture --file "$f" --capture-id "$id" ${DOME_VAULT:+--vault "$DOME_VAULT"}; then
    rm -f -- "$f"
  else
    echo "drain-captures: dome capture failed for $id (queue file kept for retry)" >&2
    status=1
  fi
done

exit $status
