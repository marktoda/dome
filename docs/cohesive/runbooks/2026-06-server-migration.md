---
type: runbook
tags: [v1, deployment, server]
created: 2026-06-11
status: ready
sources:
  - "[[cohesive/brainstorms/2026-06-11-dome-v1-plan]]"
---

# Runbook — move the Dome daemon from the MacBook to the home server

Decision of record: vault is single-residency on the server; laptop sessions
SSH in. (v1 plan §"Deployment topology", §open-questions "laptop write path".)

## 1. Prepare the server (once)

- Install bun: `curl -fsSL https://bun.sh/install | bash`
- Clone + build dome: `git clone <dome-repo> ~/dome && cd ~/dome && bun install`
- Confirm Tailscale is up: `tailscale status` (note the server's MagicDNS name).
- Allow user services to outlive logins: `loginctl enable-linger $USER`

## 2. Move the vault

- On the laptop: ensure clean state — `dome status` (no pending), then stop the
  old daemon: `dome uninstall --vault ~/vaults/work`
- Push/clone the vault to the server (one-time copy; git history travels):
  `git clone ~/vaults/work` → server `~/vaults/work` (scp/rsync the `.dome/`
  state dirs too — answers.db/runs.db/outbox.db are durable-but-not-rebuildable).
- On the server: `cd ~/vaults/work && ~/dome/bin/dome doctor` — model provider
  + projection probes must pass before installing anything.

## 3. Install the services

- Serve daemon:
  `dome install --vault ~/vaults/work --env ANTHROPIC_API_KEY=<key>`
  → systemd unit `dome-serve-<slug>.service`; check `dome install --status`.
- HTTP surface (manual unit for now — v1 scope cut, see plan):
  `~/.config/systemd/user/dome-http.service`:

      [Unit]
      Description=Dome HTTP surface (work vault)
      After=network.target
      [Service]
      ExecStart=<bun> <dome>/bin/dome http --vault %h/vaults/work --host <tailscale-ip>
      Environment="DOME_HTTP_TOKEN=<token>"
      Restart=always
      [Install]
      WantedBy=default.target

  `systemctl --user daemon-reload && systemctl --user enable --now dome-http`

## 4. Wire the phone

- `dome recipe ios --url http://<server-magicdns>:3663` and follow it.
- Smoke: the curl from the recipe; then open `/today?token=…` and add to
  home screen.

## 5. Switch the laptop workflow

- Daily driver: `ssh <server>` → tmux → Claude Code in `~/vaults/work`.
- Feeding in laptop-local files: `curl POST /capture` or `scp` into `inbox/raw/`.
- Retire the old launchd plist if step 2's uninstall was skipped.

## Rollback

- The laptop vault clone is untouched; `dome install` there restores the old
  topology in one command. Copy back the server's `.dome/` state dirs first.

## Chunk 3a — index + log migration (work vault)

Operator steps only — the chunk-3a branch does NOT touch the live work vault.
The daemon is a launchd agent running this dev tree directly, so merged code
reaches it only after a restart. (Plan:
[[superpowers/plans/2026-06-11-v1-chunk3a-index-projection-git-log]] Task 12.)

> **WARNING — unplanned-restart hazard.** Because the daemon runs this dev
> tree's `main` directly, ANY restart or reboot after the merge loads the new
> processors — and the next ingest signal would take-over-whole the blockless
> hand-written `index.md` with placeholder entries BEFORE the migration has
> run. Mitigation: run steps 2–3 (dry-run + real migration) immediately after
> merging. If `index.md` was already replaced by a render, restore it first:
> `git -C ~/vaults/work checkout <pre-render-sha> -- index.md` — the migration
> script reads the hand-written index, so it must be the curated version.

1. Heartbeat before any surgery: `dome status --vault ~/vaults/work` and check
   the launchd agent state. No pending attention, daemon alive.
2. Dry-run the description migration:
   `bun scripts/migrate-index-descriptions.ts ~/vaults/work --dry-run`
   — expect ~513 updated / ~15 skipped / 2 unmatched. The 2 unmatched are real
   divergent duplicate index entries flagged for operator eyes —
   `wiki/concepts/ai-coding-agents.md` and
   `wiki/syntheses/background-agent-landscape.md` — pick the right description
   for each by hand.
3. Real run, then review: `git -C ~/vaults/work diff --stat` should show ~513
   files with exactly one `+description:` line each. Commit.
   NOTE (grant hygiene): the work vault config's `dome.agent` `patch.auto`
   still lists `index.md`/`log.md` — harmless (the manifest no longer requests
   them and tool-time denial is active), but delete them in this same commit
   for hygiene.
4. Sources category (optional, before the first render): the default
   `index_categories` covers entities/concepts/syntheses only, so the work
   vault's 161 `wiki/sources/` index entries would drop out of the rendered
   catalog. If wanted, add to `~/vaults/work/.dome/config.yaml` under
   `extensions.dome.markdown`:

       config: { index_categories: { "wiki/entities/": "entities", "wiki/concepts/": "concepts", "wiki/syntheses/": "syntheses", "wiki/sources/": "sources" } }

   NOTE: the map REPLACES the defaults, so all four prefixes must be listed.
5. `dome restart` — the daemon must restart to pick up the new processors from
   the dev tree.
6. `render-index` produces `index.md` + shards on the next garden tick (05:15
   cron), or force it now: `dome run dome.markdown.render-index --vault
   ~/vaults/work`. NOTE: the hand-written `index.md` has no generated block, so
   the first render REPLACES it wholesale (take-over-whole semantics). The old
   content is in git history and its descriptions now live in page frontmatter
   — this is the intended migration moment, not data loss.
7. Freeze the log:
   `git -C ~/vaults/work mv log.md log-archive-through-2026-06.md` + commit.
   Agents no longer write it; `dome log` is the activity view now.
8. Verify: `dome log --vault ~/vaults/work --limit 10` shows engine commits
   with narrative bodies; `dome status --vault ~/vaults/work` clean.

Later (defer to chunk 3b): `dome init --refresh-instructions` so the vault's
AGENTS.md mentions `dome log` — the init template does not yet cover
log.md/`dome log`, so refreshing today would change nothing.

## Chunk 3b — core.md activation (work vault)

Operator steps after the chunk-3b merge. This composes with the pending
chunk-3a migration above — do both in one sitting. Order between them doesn't
matter, but finish both before (or together with) the daemon restart.

1. Grant the new processor. The work vault's config has a user-owned
   `processors:` block, so the new per-processor default grant does NOT
   propagate — on the first 05:20 tick the active-projects patch is
   capability-denied (harmless but noisy, and the feature stays inert). Add
   under `extensions.dome.agent.processors`:

       dome.agent.active-projects:
         grant:
           read: [core.md, "wiki/dailies/*.md"]
           patch.auto: [core.md]

2. Seed the core page: `dome recipe core-seed` and do the interview to fill
   Who I am + Standing preferences.
3. Verify: `dome doctor` flags the missing grant until step 1 is done; once
   it's clean, the next 05:20 tick writes the active-projects block.

## Chunk 4 — sources (work vault)

Operator steps after the chunk-4 merge (slack digest source + `dome init
--with-source`). As always: merged code reaches the daemon only after
`dome restart`.

**Current calendar state (verified read-only 2026-06-12).** The work vault is
already on the subscription path, NOT a launchd timer: `.dome/config.yaml`
carries `extensions.dome.sources` `enabled: true` with grant
`read: [sources/**/*.md, .dome/config.yaml]` + `external: [sources.fetch]`,
and the subscriptions block reads

    subscriptions:
      calendar:
        enabled: true
        schedule: "10 5 * * *"
        output_path: sources/calendar/{date}.md
        command: ["sh", ".dome/bin/fetch-calendar.sh"]

`.dome/bin/fetch-calendar.sh` exists (the shipped claude-calendar template)
and `sources/calendar/` holds fetched days through `2026-06-11.md` — so the
**fetch side** is verified: the dome.sources subscription runs the script and
commits the day files. The **weave side is NOT verified** — the vault's
user-owned `dome.agent` grant read list lacks `sources/calendar/*.md`, and
processor snapshots are grant-scoped (manifest capability ∩ vault grant;
a miss returns null silently, no diagnostic), so the 05:30 brief cannot read
the fetched calendar files at all. The rich Meetings sections in current
dailies come from something else, not the brief's calendar weave —
fetch-works ≠ weave-works. Step 3 below closes this for calendar AND slack.
`engine.external_handler_timeout_ms: 300000` is already
set (no `config.sources-timeout-default` finding expected). Note: as of this
check the config carries **no hand-written YAML comments**, so the rewrite
hazard below is currently moot for this vault — but re-verify with
`grep '#' ~/vaults/work/.dome/config.yaml` immediately before step 2, since
comments may have been added since.

Slack enablement, in order:

1. Commit any outstanding `.dome/config.yaml` changes first, so the next
   step's rewrite is reviewable as a clean diff.
2. ⚠️ **LOUD WARNING — config rewrite.**
   `dome init --with-source slack ~/vaults/work` inserts the slack stanza by
   rewriting `config.yaml` through YAML parse/stringify, which **DELETES
   every hand-written comment in the file** (pre-existing
   `--with-model-provider` behavior). Use it only on a comment-free config
   (verified in the pre-check above). If comments are present, hand-insert
   the stanza instead and run `--with-source slack` anyway just for the
   script copy — an existing stanza is left byte-untouched. The stanza:

       slack:
         enabled: false
         schedule: "15 5 * * *"
         output_path: sources/slack/{date}.md
         command: ["sh", ".dome/bin/fetch-slack.sh"]

   Either way the changes land uncommitted — review `git diff` and commit.
3. **Grant the brief read access to BOTH source feeds.** The work vault's
   `dome.agent` grant is user-owned, so the shipped default's new read
   entries do NOT propagate — and without the grant the brief's snapshot
   silently omits the files (no diagnostic, the weave just never happens;
   this is how the calendar weave has been silently ungranted, see the
   pre-check above). Under `extensions.dome.agent.grant.read` in
   `~/vaults/work/.dome/config.yaml`, add both lines:

       - "sources/calendar/*.md"
       - "sources/slack/*.md"

   Commit. After this step (plus a restart) the calendar weave starts
   working for the first time, independent of slack enablement.
4. **Review the script — it is the consent surface.** Read
   `.dome/bin/fetch-slack.sh` end to end, especially the prompt: the fetch is
   headless `claude -p` running **as you**, with your Slack MCP, summarizing
   mentions/DMs/channels since the previous evening into a committed vault
   file. Adjust the prompt (channel scope, item cap) to taste before
   enabling.
5. **Confirm headless `claude` + Slack MCP work on the daemon host.** Smoke
   test as the daemon's user:
   `claude -p --output-format text "list my Slack MCP tools"` — it must
   answer without an interactive login and must actually have the Slack MCP
   connected. ⚠️ **Post-server-migration flag:** once the daemon moves to the
   home server, this means the SERVER needs its own `claude` install, auth,
   and Slack MCP configuration for the service user — none of that travels
   with the vault clone. Budget this as a separate setup step on the server;
   until it's done, do not flip `enabled` there.
6. Flip `enabled: true` on the slack stanza, commit, `dome restart`.
7. Verify: `dome doctor` — it flags `sources.fetch-script-missing` if the
   stanza was enabled before the script landed (and is the fast check that
   the wiring is sane). Next morning, watch outbox health: `dome check`
   surfaces a terminally-failed fetch with a recovery question;
   `dome inspect outbox` shows per-attempt detail. First digest lands as
   `sources/slack/<date>.md` committed by the script and woven into the
   05:30 brief.

## Chunk 5 — economics (work vault)

Operator steps after the chunk-5 merge (prompt caching in the provider
template, per-processor model routing, `dome inspect cost`). Routing and the
inspect subject are SDK/bundle code — they reach the daemon only after
`dome restart`, as always. The provider template is different: the vault runs
its own **copy** at `.dome/model-provider.ts`, so caching arrives only when
the copy is refreshed — neither the merge nor the restart does that.

1. Re-copy the provider template. Diff first in case the vault copy was
   customized (`ANTHROPIC_*` env tweaks live in config, but the script itself
   may have been edited):

       diff ~/vaults/work/.dome/model-provider.ts <dome-dev>/assets/model-providers/anthropic.ts
       cp <dome-dev>/assets/model-providers/anthropic.ts ~/vaults/work/.dome/model-provider.ts

   Commit. The script is spawned fresh per model call, so no restart is
   needed for this file — the next call sends `cache_control` breakpoints and
   reports cache-tier-aware `costUsd`. If anything looks off,
   `DOME_DISABLE_PROMPT_CACHE=1` in the daemon environment restores the
   legacy wire shape without touching the file.
2. Optional model routing — the owner's quality call; defaults are fine and
   routing ships unset. The recommendation: haiku-class for the mechanical
   loops (ingest, sweep), provider default for the judgment-heavy ones
   (consolidate, brief). Under `extensions.dome.agent.config` in
   `~/vaults/work/.dome/config.yaml`:

       model_overrides:
         ingest: claude-haiku-4-5
         sweep: claude-haiku-4-5

   Leave `consolidate`/`brief` out of the map. The warden equivalent is
   `extensions.dome.warden.config.model_override` (single value). A typo
   cannot break the night: malformed values degrade to the default with one
   `dome.agent.model-config-invalid` / `dome.warden.model-config-invalid`
   warning. Commit.
3. `dome restart` to load the merged routing + CLI code.
4. Verify after the next nightly run:
   `dome inspect cost --vault ~/vaults/work` — per-processor spend over the
   last 7 days with a today split, extension subtotals, grand total. Steps
   2..N of the agent loops should now bill the charter+tools prefix at the
   cache-read rate, so a post-merge nightly's ingest/consolidate run cost
   should drop visibly against the prior night (`--days 2` isolates the
   comparison). The v1 plan's target this instruments: single-digit dollars
   per month.

## Topology revision (2026-06-12) — laptop-first

The server migration (§1–5 above) is DEFERRED, deliberately. The daemon stays
on the laptop. §1–5 remain valid for the day remote MCP reopens the
always-on-host question; nothing above is obsolete, just parked.

Laptop-first setup (replaces §1–5 for now):

1. Overnight gardens — OWNER CHOICE (2026-06-12): wake-tick catch-up. The
   missed 02:00–06:00 crons fire as an ordered burst when the laptop wakes;
   the brief composes while you pour coffee and re-splices if the calendar
   fetch lands late (chunk 7 hardening). The optional alternative — a firmware
   wake so mornings compose before you sit down — remains one line away:
   `sudo pmset repeat wakeorpoweron MTWRFSU 05:05:00` (verify: pmset -g sched;
   undo: sudo pmset repeat cancel).
2. Wake-tick choreography + eventually-consistent capture: shipped by the
   laptop-first hardening chunk (plan
   [[superpowers/plans/2026-06-12-v1-chunk7-laptop-first]]). The scheduler's
   cron-order wake dispatch and the brief's late-source re-compose are code —
   live after `dome restart`, no setup. The capture queue needs two:
   - Rebuild the phone Shortcut with the queue fallback:
     `dome recipe ios --url http://<laptop-tailscale>:3663` and follow it —
     the rebuilt Shortcut saves to iCloud Drive `DomeCaptures/` BEFORE the
     POST and deletes on success, so captures survive a sleeping/unreachable
     laptop. Create the `DomeCaptures` folder once (recipe step 2 names the
     two candidate locations — iCloud Drive root vs the Shortcuts container).
   - Install the laptop-side drain: `dome recipe capture-queue` and follow
     it — copies the shipped `drain-captures.sh` into `<vault>/.dome/bin/`,
     then the `com.dome.drain-captures` LaunchAgent (StartInterval 900 +
     RunAtLoad; WorkingDirectory = the vault) sweeps the queue through
     `dome capture --file --capture-id` every 15 min and on wake;
     `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.dome.drain-captures.plist`
     to load. Smoke test per the recipe's step 5 (drop a file in the queue,
     run the script by hand, confirm one inbox/raw/ capture + queue empty).
3. Slack OAuth happens HERE (the laptop is the daemon host): run `/mcp` in any
   claude session, authorize claude.ai Slack, smoke-test headless
   (`claude -p` with a Slack question), then flip
   `subscriptions.slack.enabled: true` in the work vault config.
4. Accepted costs while laptop-first: phone capture is eventually-consistent
   (iCloud queue drained when the laptop wakes) rather than instant when the
   laptop sleeps; remote MCP / voice Q&A deferred.
