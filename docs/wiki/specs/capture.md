---
type: spec
created: 2026-06-09
updated: 2026-07-11
sources:
  - "[[wedge]]"
  - "[[v1]]"
description: "Capture loop: dome capture commits inbox/raw files with no engine call, iOS Shortcut/HTTP recipes, iCloud queue fallback, captureId dedupe"
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

The captured seam also stamps an inline ` ([↗](inbox/processed/<name>))`
backlink to the archived capture on each lifted task line, so a TODO in the
daily is one click from the thought it came from ([[wiki/specs/daily-surface]]
§"The ingest tool seam").

## Raw capture file shape

The shape `dome capture` writes — and the shape any other ingress (Shortcut,
sync script, hand-authored drop) should write — is:

```markdown
---
captured: 2026-06-10T06:11:00.000Z
source: cli
title: call the landlord
capture_id: "018f4f19-7f69-7c20-9f0b-8fc715a2742d"
---

call the landlord about the radiator before friday
```

- `captured:` — the capture instant, ISO-8601 UTC. The filename carries the
  same moment in local time (`YYYY-MM-DD-HHmm`) so captures file under the
  human's evening, not UTC's next morning.
- `source:` — the ingress channel. `dome capture` writes `cli`; other
  ingresses should write an honest channel name (`shortcut`, `voice`,
  `email`, …). It is a conservative 1–32 character token; nothing dispatches
  on it yet.
- `title:` — optional; present when the capturer supplied one explicitly.
- `capture_id:` — optional for manual/CLI capture, required for retrying
  product clients. This is the durable logical identity: it survives rename
  and archive and is compared exactly, while the sanitized filename slug is
  only a human-readable hint.
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
from the dictated text onward: the HTTP capture route (`dome http`'s
`POST /capture`, [[wiki/specs/http-surface]]), `dome capture`, the ambient
daemon (`dome install`), ingest, and stale-capture diagnostics. **What you
assemble** is one iOS Shortcut on the phone — `dome recipe ios` prints the
exact build steps — plus, for a laptop-resident daemon, the queue-fallback
drain that `dome recipe capture-queue` prints (§"The iCloud queue fallback").
There is no shipped transcription and no file-watcher on the inbox — the git
commit is the trigger boundary, deliberately.

### A. iOS Shortcut over HTTP (recommended)

The shipped path: an iOS Shortcut with **Dictate Text** + **Get Contents of
URL** posting `{text, captureId}` to the vault machine's `dome http` surface
(bearer token in a header, Tailscale-class network — see
[[wiki/specs/http-surface]] §"Trust domain"). Dictation happens on-device;
the route writes the raw-capture file with `source: http` frontmatter and
commits it, exactly like `dome capture`. A Shortcut-generated
`<timestamp>-<uuid>` string bound to `captureId` makes flaky-network retries
idempotent (§"Retry semantics", below) — the retry answers
`status: "duplicate"` instead of filing the thought twice — and the same
string doubles as the queue filename in the fallback below, so both channels
dedupe against each other.

```bash
dome recipe ios --url http://<your-server>:3663
```

prints the full setup: prerequisites, the Shortcut actions step by step, a
copyable `curl` verification command, and the `GET /today` cockpit URL for
the home screen. The recipe is normative in [[wiki/specs/cli]]
§"`dome recipe`"; it lives next to the CLI so it cannot drift from the HTTP
surface. No SSH, no Mac-side shell — and the Action button / Apple Watch can
trigger the Shortcut directly.

### The iCloud queue fallback (eventually consistent)

The HTTP path assumes a reachable host, and on a laptop-resident daemon that
assumption fails nightly — the lid is closed. The shipped Shortcut is
therefore **queue-first**: before the POST, it saves the dictation as
`DomeCaptures/<timestamp>-<uuid>.md` in iCloud Drive, and deletes that file
only after the POST succeeds. The ordering is forced by Shortcuts' failure
semantics: there is no try/catch — when "Get Contents of URL" hits an
unreachable host the Shortcut simply STOPS, so the only failure branch
available is whatever already ran before the failing action. Save first and
the stop *is* the failure branch: the file waits in the queue, the capture is
never lost, merely late.

The laptop half is `dome recipe capture-queue` ([[wiki/specs/cli]]
§"`dome recipe`"): it installs the shipped drain script
(`assets/source-handlers/drain-captures.sh`, copied to `<vault>/.dome/bin/` —
SDK-shipped vault-side data, the model-provider-template precedent) plus a
launchd `StartInterval` LaunchAgent that sweeps the queue every 15 minutes,
with missed intervals coalescing into one run on wake. Per `*.md` queue file
the drain runs `dome capture --file <f> --capture-id <stem>`; exit 0 — which
covers both `captured` and `duplicate` — deletes the queue file, non-zero
keeps it for the next interval's retry. A zero-byte queue file is deleted
with a logged note instead of retried: it carries nothing recoverable, and
`dome capture` rejects an empty body every interval, so keeping it would
wedge the queue forever. Not-yet-downloaded iCloud
placeholders (`.<name>.md.icloud`) get a best-effort `brctl download` and are
picked up on a later interval. The drain is deliberately a recipe-installed
external job, **not** a `dome.sources` subscription — the why is recorded at
[[wiki/specs/sources]] §"What is deliberately NOT a subscription: the
capture-queue drain".

**One id, two channels.** The Shortcut builds a single `<timestamp>-<uuid>`
string and uses it as BOTH the POST body's `captureId` AND the queue filename
stem; the drain derives its `--capture-id` from that stem. Whichever channel
lands first wins and the other answers `duplicate` (still success), so a
capture that raced both channels — or a drain re-run after a crash between
`dome capture` and the queue-file delete — never double-files. The dedup
scan covers `inbox/processed/` as well as `inbox/raw/` (ingestion archives a
consumed capture with its basename preserved), so the guarantee holds even
when the queue copy arrives after the original was already ingested and
archived. The cost of
queue-first is eventual consistency: a capture made while the laptop sleeps
sits in iCloud until the first drain interval after wake, instead of landing
instantly.

The assemblies below remain workable fallbacks for vaults without the HTTP
surface, in increasing self-sufficiency:

### B. iOS Shortcut over SSH

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

### C. Synced folder + `dome capture --file`

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
the staging folder) is user-assembled in the general case — but the iCloud
Drive instance of this assembly now ships assembled, as the queue fallback's
drain (§"The iCloud queue fallback"; `dome recipe capture-queue`). A shipped
inbox file-watcher remains an explicit non-goal for Phase 3 (see Follow-ups).

### D. Direct git from the phone

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

## The remote-capture seam

The recipes above all end the same way: a properly-shaped file committed on
the vault branch. This section names that contract as a seam, so the first
phone app, voice client, or relay service builds against one sanctioned
shape instead of inventing a path around the adoption loop.

**The contract.** A remote-capture ingress is anything that takes
`{ text, title?, source }` from an authenticated caller and produces exactly
what `dome capture` produces: one raw-capture file under `inbox/raw/`
(§"Raw capture file shape" — with `source:` carrying the honest channel
name), committed as one ordinary human commit on the current branch, and
answered with the `dome.capture/v1` document (`path`, `commit`,
`compile_pending`, …). Nothing else: no engine call, no adopted-state
write, no projection read. The capture core behind `dome capture` and the
MCP `capture` tool — `performCapture` in `src/cli/commands/capture.ts` — is
the reference implementation of this contract; a relay wraps it, never
reimplements it.

**Settle is the second operation on this seam.** `performSettle`
(`src/surface/settle.ts`) applies a close / defer / keep disposition to a task
addressed by its `^block-anchor`, landing it as the same one ordinary human
commit with the same trust posture — the write-side sibling of capture,
detailed at [[wiki/specs/task-lifecycle]] §"The settle operation".

**Why commit-or-nothing.** The seam inherits its security and consistency
story from [[wiki/invariants/PROPOSALS_ARE_THE_ONLY_WRITE_PATH]]: because a
remote capture is an ordinary human commit, the relay needs filesystem +
git, never Dome internals; the daemon treats it exactly like a terminal
capture; and a compromised relay can at worst write commits into
`inbox/raw/` — visible in history, processed as untrusted input by ingest,
revertible like any commit.

**Trust domain.** The compatibility form runs in the owner's trust domain:
a process running as the vault owner on the vault host, reachable over a
private network (Tailscale-class), authenticating callers with a bearer
token. Same posture as `dome mcp` — locally launched, owner-trusted. Dome
Home replaces this browser posture with paired device authority before
remote exposure; see [[wiki/specs/product-host]].

**Retry semantics.** Mobile callers retry on flaky networks, and a naive
relay would file the same thought twice. The seam accepts an optional
client-supplied `captureId`; it is embedded as `capture_id` and also drives
the filename slug. An existing file for the exact same id — in `inbox/raw/`
or archived to `inbox/processed/` —
answers `status: "duplicate"` with the original path — nothing written,
nothing committed. Clients without an id accept duplicate
risk; ingest tolerates duplicates either way. Implemented in
`performCapture` (`source` + `captureId` options). The CLI exposes the same
key as `dome capture --capture-id <id>` ([[wiki/specs/cli]]
§"`dome capture`") — the queue drain's idempotency seam — and a `duplicate`
answer is success (exit 0), so the drain deletes its queue copy on either
outcome and a crash between capture and delete never double-files.

The shared `contracts/capture.ts` boundary validates product receipts. A
new capture explicitly reports `commit_status: "committed"` and
`adoption_status: "pending"`; a duplicate reports
`commit_status: "already-committed"` and does not pretend its adoption state
is known. The PWA outbox saves text to IndexedDB before transport, retains a
failed item with its stable id, and exposes retry, export, and delete.
Capture commits now enter through [[wiki/specs/controlled-mutation]]; the
surface itself no longer writes workspace files before commit or owns rollback.

**Shipped form.** Form 2 below shipped first (2026-06-10): `dome http`
carries `POST /capture` alongside the read routes — see
[[wiki/specs/http-surface]]. The other forms stay banked:

1. ~~**`dome capture-relay`**~~ — subsumed by `dome http` (the dedicated
   capture-only listener turned out to cost the same as the full
   read+capture adapter).
2. **A route on the HTTP surface** — **shipped** as `dome http`'s
   `POST /capture`, with `source: "http"` frontmatter and `captureId`
   retry idempotency implemented in `performCapture`.
3. **Git-native relay** — a service holding its own checkout that commits
   and pushes to a shared vault remote. Needs the multi-device sync story
   (who fetches, what the daemon ticks on) and is banked with it.

## Out of scope (follow-ups, not Phase 3)

- **Inbox file-watcher** — a daemon-side watcher that auto-commits files
  dropped into `inbox/raw/` (would dissolve the manual step in recipe C).
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
