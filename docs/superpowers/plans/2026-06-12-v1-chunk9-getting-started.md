# Dome v1 Chunk 9 — Getting Started (WS6 docs) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The WS6 enabler: a stranger can go clone → first morning brief using only the docs. One canonical getting-started guide, the front door pointing at it, and every docs-class blocker-ledger line struck with its documented home.

**Shape:** `docs/getting-started.md` (the dogfood vault carries it; README links it). Written for a competent stranger with a Mac or Linux box, no Dome context. The voice: numbered, copy-pasteable, honest about sharp edges. It strings together what ALREADY ships — no new features.

## Tasks

### Task 1: the guide
`docs/getting-started.md`, covering in order:
1. **Prereqs** (bun; git identity; macOS or Linux; honest note: install = clone + `bun install`, updates = `git pull` + `dome restart` — no release artifact yet).
2. **Create the vault**: `dome init <dir>` (what it scaffolds — AGENTS.md/CLAUDE.md/core.md/signals/inbox), `--with-model-provider anthropic` (+ ANTHROPIC_API_KEY), optional `--with-source calendar`/`slack` (consent stance: stanzas ship disabled; the fetch script runs headless Claude AS YOU — read it before enabling; requires claude CLI + MCP auth on the daemon host).
3. **Start the daemon**: `dome install` (launchd/systemd; the Linux `loginctl enable-linger` prerequisite, stated plainly), `dome install --status`, where logs live.
4. **Verify**: `dome doctor` — what the probes mean (model provider, grant-starved info findings, gpg signing note), `dome status` → `next_actions`.
5. **First loop**: `dome capture "hello"` → commit→adopt cycle explained in three sentences → `dome today`, `dome log`.
6. **Personalize**: `dome recipe core-seed` interview (why: the brief stays generic without it); the foreground signal contract (one paragraph — your assistant logs explicit preferences; promotion is owner-mediated).
7. **Morning brief**: what arrives at 05:30 (or on wake — laptop wake-tick is normal), what feeds it (calendar/slack sources when enabled).
8. **Phone capture (optional)**: `dome recipe ios` + `dome recipe capture-queue`; the trust-domain paragraph — bearer token, Tailscale-class network only, the `/today?token=` query-param boundary stated explicitly (ledger's security line).
9. **Daily driving**: point at the vault's own AGENTS.md as the session contract; `dome check`/`resolve` for questions; escalated-sweep-row and other surgery notes link to the runbook rather than restating.
Accuracy bar: every command verified against the shipped CLI (run them against a scratch vault while writing — the guide IS the gate's script). Cross-link from README.md (short section) and docs/index.md.

### Task 2: ledger + plan sync
Strike the docs-class ledger lines with "documented:" pointers (token boundary → guide §8; enable-linger → §3; consent scripts → §2; core-seed-in-install-docs → §6). Lines that remain open after this chunk (release artifact, manual http unit, grant non-propagation, generic migration path, escalated-row surgery) stay open honestly — they're accept-or-post-v1, noted as such. v1 plan addendum: WS6 input artifact complete; remaining = the human gate itself.

### Task 3: verify + merge
The accuracy bar check: a scratch-vault walkthrough of §1–6 executed literally from the guide (copy-paste), deviations fixed in the guide. `bun test tests/integration` + full suite + typecheck (docs-coupled pins). Final review (one pass — is this followable by a stranger? does it match shipped reality?). `--no-ff` merge.
