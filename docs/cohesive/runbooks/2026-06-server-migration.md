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
