---
type: guide
tags:
  - onboarding
  - second-user
  - ws6
created: 2026-06-12
updated: 2026-07-06
sources:
  - "[[cohesive/second-user-blockers]]"
  - "[[wiki/specs/cli]]"
description: "Clone → vault → daemon → capture → first morning brief, every command verified against a scratch vault; the WS6 second-user walkthrough"
---

# Getting started

Clone to first morning brief, in nine numbered steps. Written for someone with
a Mac or Linux box and no Dome context. Every command below was run against a
fresh scratch vault before it was written down; where something is rough, the
guide says so instead of smoothing it over. Depth lives in the specs — this
page links out rather than restating.

## The product loop

Dome has four user-facing jobs, all backed by the same adopted vault state:

- **Today** — capture new material and render the day's action surface.
- **Recall** — find source-backed context and explain where it came from.
- **Decide** — settle tasks, answer explicit questions, and review proposed
  garden changes.
- **Maintain** — compile commits, surface attention, and keep projections and
  background loops healthy.

These are navigation labels, not new engine primitives. The core remains
Vault, Proposal, Processor, and Effect; `dome --help` groups the existing
commands around the four jobs.

## 1. Prerequisites

- **macOS or Linux.** The daemon installs as a launchd LaunchAgent (macOS) or
  a systemd `--user` unit (Linux). Windows is unsupported.
- **[Bun](https://bun.sh) 1.x** — the only runtime dependency.
- **A git identity** (`git config --global user.name` / `user.email`) — you
  will be making ordinary git commits in your vault.
- **An Anthropic API key** (create one in the [Anthropic
  Console](https://console.anthropic.com)) for the model-backed loops (ingest, nightly
  consolidation, the morning brief). Everything deterministic works without
  one; step 4 shows exactly how Dome behaves keyless, so you can try it
  before paying.

Honest note up front: Dome now has a hermetically rehearsed npm tarball, but it
is **not published**. Installing Dome still means cloning the repo; updating
means `git pull` + `dome restart` — and new code reaches a running daemon only
after that restart. Publication waits on explicit owner choices for licensing,
versioning, and registry policy.

```sh
git clone <dome-repo> ~/dome
cd ~/dome && bun install
export PATH="$HOME/dome/bin:$PATH"   # add to your shell profile too
```

`dome` is a Bun script at `bin/dome`; putting that directory on PATH is the
whole install.

## 2. Create the vault

```sh
dome init ~/vault --with-model-provider anthropic
```

This scaffolds a git repo containing: `AGENTS.md` + `CLAUDE.md` (the agent
orientation surface — what a Claude Code session in this vault reads first),
`core.md` (your always-loaded core memory, a commented skeleton for now),
`preferences/signals.md` (append-only preference-signal log), `wiki/`,
`notes/`, `inbox/raw/` + `inbox/processed/`, `.dome/config.yaml` (which
extensions are on, with what grants), and a `.gitignore` for the derived
`.dome/state/`. It ends with an initial commit. Re-runs are idempotent and
never overwrite your edits.

`--with-model-provider anthropic` copies a self-contained provider script to
`.dome/model-provider.ts` and points `model_provider:` in the config at it.
It speaks to the Anthropic Messages API with plain `fetch` and expects
`ANTHROPIC_API_KEY` in the environment of whatever runs the compiler (step 3
wires that into the daemon). Default model `claude-sonnet-4-6`; see
[[wiki/specs/cli]] §"`dome init`" for the env overrides.

**Optional sources** (you can come back to this later):

```sh
dome init ~/vault --with-source calendar   # and/or --with-source slack
```

Each drops a fetch script at `.dome/bin/fetch-<kind>.sh` and a subscription
stanza in the config — **shipped `enabled: false`, always**. Scaffolding is
not consent: the script runs headless Claude *as you* against your calendar
or Slack connector, so read it before flipping the flag — it lands untracked
for exactly this reason, and `dome status` will nudge you to commit it once
you have.

**Honest note: calendar and Slack are foreground by default.** The shipped
scripts drive your **claude.ai connectors**, which load only in an interactive
Claude session — *not* in the non-interactive `claude -p` the daemon spawns
(this was verified; an interactive terminal made it look like it worked). So
live calendar and Slack belong in your **morning foreground Claude session**,
where the connectors are present — not in a daemon-automated subscription. The
daemon-composed brief (step 7) covers your vault state and simply omits
meetings/Slack when no day-file is present. To make a subscription genuinely
daemon-driven, swap the script's FETCH block for a **deterministic** source
that needs no interactive login (`icalBuddy` reading Calendar.app, or a direct
API call with a file-stored token). [[wiki/specs/sources]]
§"Connector-backed fetch is foreground-only" is the contract.

## 3. Start the daemon

Dome compiles your vault at the git commit boundary. The daemon is just
`dome serve` kept alive by the OS:

```sh
cd ~/vault
dome install --env ANTHROPIC_API_KEY=sk-ant-...
dome install --status     # → installed yes, loaded yes
```

`--env` entries land in the service environment (use `--env-file` for a
file of KEY=VALUE lines). The service survives crashes and reboots.

- **macOS:** a LaunchAgent at `~/Library/LaunchAgents/com.dome.serve.<id>.plist`.
- **Linux:** a systemd `--user` unit — plus one manual prerequisite Dome
  deliberately does not automate: run `loginctl enable-linger $USER` once, or
  the unit dies when you log out.

Logs live at `<vault>/.dome/state/serve.log` on both platforms. After a
`git pull` in the SDK repo, run `dome restart` to load the new code (the
installed plist/unit and its `--env` values are reused as-is).

## 4. Verify

```sh
dome status
```

`dome status` is the cheap pulse you (and any agent session) run at
boundaries. Read the `NEXT` block — `next_actions` is the canonical "what
now". If the daemon hasn't caught up yet, status says `sync needed`; let its
next tick handle it (it polls sub-second) or run `dome sync` yourself. While
the daemon is running, a manual `dome sync` may answer `branch main is already
being processed by another Dome host` — that's the daemon holding the lock,
not an error.

If status points to attention, run `dome check`; it explains the health,
content, and decisions that need action. `dome doctor` is the hidden,
troubleshooting-only probe set for dependencies and operational storage. On a
fresh vault its detailed report may include:

- `model.provider-key-missing` *(warning)* — until the key is present in the
  environment doctor runs in. The daemon has its own environment (step 3);
  this finding tells you which one is missing it.
- `git.commit-signing` *(info)* — if your global git config sets
  `commit.gpgsign=true`. Dome's own commits never invoke gpg, but your own
  `git commit` in the vault will try to sign; the finding shows the opt-out.
- `capability.grant-starved` *(info)* — a processor whose config grant gives
  it nothing to act on. Zero on a fresh vault.

## 5. First loop: capture

```sh
dome capture "hello dome"
```

This writes `inbox/raw/<date>-<time>-<slug>.md` and commits it — and that's all it
does. The cycle in three sentences: every change to the vault is an ordinary
git commit; the daemon notices the branch moved and runs the commit through
the adoption loop (deterministic processors first, model-backed ones when
enabled); adopted state is what `dome today`, `dome query`, and the brief are
built from. Nothing you commit is rewritten behind your back — processors
propose, the engine applies, git history is the audit trail.

Captures are *digested* (filed into the wiki, archived to
`inbox/processed/`) by `dome.agent.ingest`, and **`dome.agent` ships
enabled** — the brain is on from the first commit. The old protection was a
disabled bundle; the new protection is a shipped **$2.00/day** model-spend
cap (`extensions.dome.agent.grant.model.invoke.maxDailyCostUsd` in
`.dome/config.yaml`), a modest pool shared across ingest/consolidate/sweep/
brief. If you ran `dome init --with-model-provider` (step 2) and the API key
is present in the daemon's environment, ingest runs on the next sync — no
extra flip required. Two ways it can be starved, and both are **loud, never
silent**:

- **No model provider configured at all** (`dome init` without
  `--with-model-provider`, or the `model_provider:` stanza removed): `dome
  serve` logs a one-line `agent.no-model-provider` warning once per host
  start — "dome.agent is enabled but no model provider is configured; run
  `dome init --with-model-provider` or set `enabled: false`." `dome
  doctor`'s `model.provider-missing` finding reports the same gap on
  demand (also from `dome sync`, which doesn't keep a long-running host to
  log at boot).
- **A provider is configured but the key is missing or bad**: the agent
  processors run and fail *visibly* — `dome check` shows
  `dome.agent.*-failed` warnings (`source-failed` for a capture being
  ingested, `brief-failed` for the brief) and your captures simply stay in
  `inbox/raw/` until the key works.

`dome status` nudges you either way when raw captures are waiting. To turn
the bundle off entirely: edit `.dome/config.yaml`, set `enabled: false` under
`extensions.dome.agent`, commit.

Then look around:

```sh
dome today    # today's action surface (open tasks, follow-ups, questions)
dome log      # vault activity: git history joined with the engine's run ledger
```

## 6. Personalize: seed core.md

Without this step the morning brief stays generic — Dome knows your files
but not your role, your people, or your rules.

```sh
dome recipe core-seed
```

It prints an interview prompt. Open your vault in Claude Code, paste the
prompt, answer the questions, review the draft, commit. That seeds the two
owner-authored sections of `core.md` (`## Who I am`, `## Standing
preferences`); `## Active projects` is generated nightly — leave it alone.

The standing contract from there: `core.md` is propose-only for Dome. Your
foreground assistant logs explicit preferences and corrections as one-line
signals in `preferences/signals.md` (the vault's `AGENTS.md` instructs it
to); Dome tallies them and *asks you* before promoting a recurring rule into
`core.md`. Promotion is owner-mediated, never automatic
([[wiki/specs/preferences]]).

## 7. The morning brief

At **05:30** the brief agent fills the marker-delimited blocks in today's
daily note (`wiki/dailies/<date>.md`) — yesterday's thread, what's on today —
so the first read of the day is grounded and short. If the laptop was asleep
at 05:30, it fires on wake instead (at most once per day); a wake-tick brief
is normal, not a bug. The brief is built from your **vault state**, not live
integrations: when a `sources/calendar/<date>.md` or `sources/slack/<date>.md`
day-file is present it feeds the meetings/digest surfaces, and when it is
absent the brief simply omits them — no error, no fabricated agenda. With the
connector-backed scripts from step 2 left foreground (the default), those
day-files are written in your morning session, not by the daemon; a daemon
would populate them only with a deterministic fetcher swapped in.

When the brief *can't* run (bad key, network), it degrades honestly: a
deterministic stub lands in the daily note, `dome check` carries a
`dome.agent.brief-failed` warning, and the deterministic daily sections remain
available. Dome does not turn an operational outage into an owner-decision
question or advertise a retry action that has no continuation; correct the
provider/runtime cause before the next scheduled brief.
[[wiki/specs/daily-surface]] owns the choreography.

## 8. Phone capture (optional)

```sh
dome recipe ios            # iOS Shortcut → POST /capture, queue-first
dome recipe capture-queue  # laptop-side iCloud-queue drain (launchd)
```

Both print complete, self-contained setup walkthroughs against the
`dome http` surface ([[wiki/specs/http-surface]]). Read the trust-domain
paragraph before exposing anything: the compatibility HTTP surface uses one
bearer token (`DOME_HTTP_TOKEN`) in the `Authorization` header and is
acceptable only inside a loopback or Tailscale-class private network. Never
put the token in a URL. Bind a Tailscale interface, never a public one, and
treat everyone inside the trust domain as the owner. The browser product is
the Dome Home PWA at `/`, paired through its device flow rather than this
shared-token capture recipe.

## 9. Daily driving

Your vault's own `AGENTS.md` is the session contract — Claude Code (or any
harness) reads it and knows the loop: edit markdown, commit coherent units,
let the daemon adopt, run `dome status` at session boundaries and follow
`next_actions`. You don't run Dome commands after every edit; Dome works at
the commit boundary.

When status says attention remains, `dome check` explains it in one report —
engine health, content diagnostics, open decisions — and every open question
comes with its `dome resolve <id> <value>` command. Questions marked
`owner-needed` are yours; agent-safe ones a vault-aware session may answer
from sources.

Dome's gardeners don't only ask questions — some **propose edits**, and those
behaviors ship on by default (the weekly attic sweep for dead-stub pages,
page-split proposals from the nightly consolidate pass). So within the first
week or two, `dome status` will start routing you to `dome proposals`: read
each diff, then decide it with `dome apply <id>` (writes the change as one
ordinary commit) or `dome reject <id>`. Autonomy is earned, not assumed —
every mutating behavior starts at propose level, and the Monday trust review
promotes a behavior to auto-apply only after its accept rate across your own
decisions has earned it. That promotion arrives as just another proposal for
you to apply or reject, with the evidence in the weekly report card your
daily note links ([[wiki/specs/proposals]] §"Trust ladder").

Tasks have their own disposition verb: `dome settle <block-anchor>
close|defer|keep` (defer takes `--until YYYY-MM-DD`) settles a task line in
one ordinary commit, and the stale-task warden raises questions pointing at
tasks that have stopped moving.

Sharp edges that are real and known: updating still means `git pull` +
`dome restart` (§1); a handful of recovery situations (un-escalating a
poisoned sweep pair, migrating a pre-Dome vault, the hand-written
`dome-http` service unit) are operator surgery documented in the
[[cohesive/runbooks/2026-06-server-migration|server-migration runbook]] and
tracked honestly in [[cohesive/second-user-blockers]]. When something feels
off, start with `dome doctor` and `dome check` — every failure mode you're
likely to hit surfaces in one of the two.

**Adopting an existing vault?** Dome's lifecycle processors stamp stable
identity anchors (`^c…` on claim lines, `^…` on task lines) as pages are
edited — they fire on changed paths, not retroactively, so a vault with prior
content keeps unanchored backlog until each page is next touched. To complete
coverage in one pass, a one-time content commit that puts every page into a
diff lets the garden stamp the backlog on the next tick; the
[[wiki/specs/claims]] §"Backfilling coverage on an existing vault" gives the
exact (idempotent, anchor-only) incantation. A fresh `dome init` vault — the
path this guide walks — needs none of this; coverage accrues from the first
edit.
