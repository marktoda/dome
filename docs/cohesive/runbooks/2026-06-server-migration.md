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
4. `dome restart` — the daemon must restart to pick up the new processors from
   the dev tree.
5. `render-index` produces `index.md` + shards on the next garden tick (05:15
   cron), or force it now: `dome run dome.markdown.render-index --vault
   ~/vaults/work`. NOTE: the hand-written `index.md` has no generated block, so
   the first render REPLACES it wholesale (take-over-whole semantics). The old
   content is in git history and its descriptions now live in page frontmatter
   — this is the intended migration moment, not data loss.
6. Freeze the log:
   `git -C ~/vaults/work mv log.md log-archive-through-2026-06.md` + commit.
   Agents no longer write it; `dome log` is the activity view now.
7. Verify: `dome log --vault ~/vaults/work --limit 10` shows engine commits
   with narrative bodies; `dome status --vault ~/vaults/work` clean.

Later (defer to chunk 3b): `dome init --refresh-instructions` so the vault's
AGENTS.md mentions `dome log` — the init template does not yet cover
log.md/`dome log`, so refreshing today would change nothing.
