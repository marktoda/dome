---
type: spec
created: 2026-06-09
updated: 2026-06-11
sources:
  - "[[wedge]]"
  - "[[v1]]"
---

# Capture

This spec is normative for Dome's capture loop — how a raw thought gets from
anywhere (terminal, phone, voice memo) into the vault with guaranteed
processing. It is the Phase 3 wedge surface ([[wedge]] §"Phase 3 — Capture
loop"): capture must be trivially cheap, and everything after the capture is
the engine's existing job, not a new surface.

## The capture loop

```text
thought (terminal / phone / voice)
  → file at inbox/raw/<YYYY-MM-DD-HHmm>-<slug>.md
  → ordinary git commit on the current branch        (HUMAN write — no Dome-* trailers)
  → compiler host adopts the commit                  (dome serve poll / dome sync)
  → dome.agent.ingest integrates it                  (garden phase; needs dome.agent enabled + model ready)
      wiki pages + wikilinks + index/log updates
      tactical tasks land in today's daily under `## Captured today`,
        inside the dome.daily:captured block (tool-seam enforced);
        durable follow-ups go to entity `## Open threads`
      raw file archived to inbox/processed/
  → dome.agent.inbox-stale-check warns               (when raw captures sit unprocessed)
```

Two properties are load-bearing:

- **Capture never talks to the engine.** A capture is an ordinary commit; the
  daemon constructs the Proposal from branch drift, exactly like any other
  human write (per [[wiki/invariants/PROPOSALS_ARE_THE_ONLY_WRITE_PATH]]).
  Phones, scripts, and synced folders need git, not a Dome API.
- **The inbox is ephemeral.** Raw captures either move out (ingest archives
  them to `inbox/processed/`) or surface a recoverable diagnostic
  (`inbox.stale`), per [[wiki/invariants/INBOX_IS_EPHEMERAL]]. `dome status`
  raises `capture_loop_inactive` when raw captures exist but the
  `dome.capture.digest` loop cannot run.

The shipped entry point is `dome capture` (normative command spec in
[[wiki/specs/cli]] §"`dome capture`"): it writes the file, commits exactly
that one path, and returns immediately.

**The landing zone.** A capture's tactical tasks land in today's daily note
under the `## Captured today` section, inside the `dome.daily:captured`
generated block ([[wiki/specs/daily-surface]] §"Block ownership"). The
ingest agent's tool seam enforces the landing: only task-shaped
`- [ ] #task …` lines are accepted for today's daily, and the seam — not the
model — splices them inside the block (creating the shared daily skeleton
when the note doesn't exist yet). From there the line is an ordinary task
*origin*: `stamp-block-id` anchors it on the next cycle, `task-index`
projects it, and `carry-forward` surfaces it in later dailies with
provenance.

## Raw capture file shape

The shape `dome capture` writes — and the shape any other ingress (Shortcut,
sync script, hand-authored drop) should write — is:

```markdown
---
captured: 2026-06-10T06:11:00.000Z
source: cli
title: call the landlord
---

call the landlord about the radiator before friday
```

- `captured:` — the capture instant, ISO-8601 UTC. The filename carries the
  same moment in local time (`YYYY-MM-DD-HHmm`) so captures file under the
  human's evening, not UTC's next morning.
- `source:` — the ingress channel. `dome capture` writes `cli`; other
  ingresses should write an honest channel name (`shortcut`, `voice`,
  `email`, …). Free-form; nothing dispatches on it yet.
- `title:` — optional; present when the capturer supplied one explicitly.
- **No `type:` field.** `inbox/` roots may omit frontmatter typing per
  [[wiki/specs/page-schema]]; the file is ephemeral and ingest archives it.
  Archived captures under `inbox/processed/` stay untyped too — no shipped
  bundle declares a `capture` page type.

Frontmatter is **recommended, not required**: `dome.agent.ingest` triggers on
any `inbox/raw/*.md` commit and reads the whole file as untrusted source
content. A bare markdown file dropped by hand still gets ingested. The
frontmatter exists so provenance survives the archive to `inbox/processed/`.

Captures are untrusted input. Ingest treats source content as data, not
instructions ([[wedge]] §"Risks" — prompt injection via captures); the
capability grant on `dome.agent.ingest` is the write boundary either way.

## Phone and voice ingress (recipe)

The wedge phone path ([[wedge]] §"North-star daily experience") is: mumble a
thought into the phone at 11pm; it lands in `inbox/raw/`; overnight it's
ingested and the todo shows up in the morning. **What ships** is everything
from the committed file onward: `dome capture`, the ambient daemon
(`dome install`), ingest, and stale-capture diagnostics. **What you
assemble** is the hop from phone to a committed file. There is no shipped
transcription and no file-watcher on the inbox — the git commit is the
trigger boundary, deliberately.

Three workable assemblies, in increasing self-sufficiency:

### A. iOS Shortcut over SSH (recommended)

An iOS Shortcut with two actions: **Dictate text** (or "Ask for input"),
then **Run script over SSH** against the machine that holds the vault:

```bash
cd /Users/you/vaults/work && dome capture --title "phone capture" "<Shortcut input>"
```

Or pipe the dictated text through stdin to avoid shell-quoting surprises:

```bash
cd /Users/you/vaults/work && dome capture
```

with the Shortcut's SSH action configured to pass the dictated text as stdin.
Voice memos work the same way once transcribed — iOS dictation happens
on-device in the Shortcut, so no transcription service is needed for the
quick-mumble case. The capture is committed the moment the SSH command
returns; the installed daemon ([[wiki/specs/cli]] §"`dome install`") adopts
it on the next poll. Requires: the Mac reachable over SSH (Tailscale makes
this painless), `dome` on the PATH of the SSH login shell.

### B. Synced folder + `dome capture --file`

When SSH isn't available at capture time: save the dictated/transcribed text
into a folder that syncs to the vault machine (iCloud Drive, Syncthing,
Obsidian Sync — anything that lands a file on the Mac). The capture is **not
visible to Dome yet** — a file in a synced folder (even inside `inbox/raw/`)
is just a dirty working tree until committed; `dome status` reports it as
`dirty_untracked`, and the engine ignores it. Close the loop on the vault
machine:

```bash
dome capture --file ~/Sync/captures/2026-06-09-thought.txt
```

which writes the properly-shaped raw capture and commits it. Automating the
sweep (a cron/launchd job that runs `dome capture --file` over new files in
the staging folder) is user-assembled today; a shipped inbox file-watcher is
an explicit non-goal for Phase 3 (see Follow-ups).

### C. Direct git from the phone

Apps like Working Copy (iOS) can commit and push to the vault repository
directly. Write the file under `inbox/raw/` following the raw-capture shape
above (or don't — bare markdown also ingests), commit, push. This needs no
Mac-side helper at all; the trade is that filename/frontmatter discipline is
on you, and a malformed push can leave the branch in a state the daemon
reports rather than fixes.

### Transcription beyond dictation

For real voice memos (audio files), transcription is user-assembled:
Shortcuts' "Get text from audio" on newer iOS, or a local Whisper pass on the
Mac over a synced audio folder, feeding `dome capture --file`. Dome
deliberately has no audio surface — by the time content reaches the engine it
is markdown in a commit, like everything else.

## Out of scope (follow-ups, not Phase 3)

- **Inbox file-watcher** — a daemon-side watcher that auto-commits files
  dropped into `inbox/raw/` (would dissolve the manual step in recipe B).
  Today the commit boundary is the contract.
- **Auto-updating sources** — when a captured source is a living document
  (e.g. an article that changes upstream), detect the update and re-ingest /
  re-index the derived pages. Today a source is consumed once at ingest;
  re-capturing the new version as a fresh `inbox/raw/` file is the manual
  path.
- **Shipped transcription** — voice/audio handling stays user-assembled.
- **Open-loop guarantee hardening** — "every ingested capture with an
  actionable item leaves a trace in the daily note" now has its landing zone
  (the `## Captured today` owned block, above); the remaining hardening —
  *verifying* the trace exists per ingested capture and warning when it
  doesn't — lands with the Phase 4 brief work.

## Related

- [[wiki/specs/cli]] §"`dome capture`" — the normative command spec.
- [[wiki/specs/vault-layout]] §"`inbox/` — ephemeral drop-zones" — the bucket
  layout and trigger surface.
- [[wiki/specs/autonomous-agents]] — `dome.agent.ingest`'s charter and loop.
- [[wiki/specs/daily-surface]] — the `## Captured today` section contract and
  the `dome.daily:captured` block ownership row.
- [[wiki/invariants/INBOX_IS_EPHEMERAL]] — why captures must move or warn.
- [[wedge]] §"Phase 3 — Capture loop" — the product framing.
