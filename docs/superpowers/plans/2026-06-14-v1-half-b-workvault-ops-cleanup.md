# v1 Half B — Work-Vault Operational Cleanup — Plan

**Goal:** Make the live work vault (`/Users/mark.toda/vaults/work`) actually clean — no recurring-failure findings, no wasted ticks, a robust daemon PATH — and confirm Half A's hardening (chunk 11) took on the live vault. This is the one-time "stop babysitting" pass.

**Nature — read this first.** This is **interactive ops on the LIVE vault**, NOT a subagent-driven code chunk. Discipline:
- The daemon owns the vault lock — change things via `dome resolve`, config edits + `dome restart`, and script edits; never hand-edit `.dome/state/`.
- READ before mutate; his real knowledge is in here.
- Three classes of step: **(I) I can do directly** (PATH, draining via resolve, tracing, verification); **(O) owner-only** (MCP OAuth, Tailscale, file-placement calls); **(C) SDK fix that falls out** → normal worktree + test + `--no-ff` merge, then re-copy/restart.
- Run it WITH the owner present for the O-steps and the branch points.

---

### Task 0 — fresh state snapshot (I)
Re-baseline post-chunk-11 (the restart may have already healed several items): `dome status --json`, `dome doctor`, `dome inspect outbox --json`, `inspect quarantine`, `inspect runs` (failed/running), tail `.dome/state/serve.log`. Record the current debris so we fix what's actually there, not the 2026-06-13 snapshot.

### Task 1 — verify Half A landed live (I)
- **Adoption timeout**: confirm `duplicate-detection` now runs at 30s, not 10s — force or wait for a `document.changed` fire and grep serve.log for `timeout of 30000ms` vs `10000ms` (the 39 pre-restart timeouts were all 10s). If it still times out *at 30s*, that's the deferred incremental-scan follow-up territory — note it, don't fix here.
- **Tick no longer aborts**: confirm the orphan-run / agent-safe questions are draining (auto-resolution alive) — the 2 stuck `running` rows should fail-and-clear; if they linger, resolve manually (`dome resolve <id> fail`).
- **GC**: confirm the `dome.intake.synthesize-rollup` orphan counter is pruned from `quarantined.json` (it should clear on the post-merge daemon open).
- **Findings fire**: confirm `outbox.recurring-failure` shows for the calendar rows (already observed: rows 1/66/141).

### Task 2 — drain the outbox (I, after Task 3 for the calendar rows)
- Row 1 (stale `exit 127: claude: command not found`, pre-PATH-fix): abandon (it predates the script's absolute-path fix) OR retry — retry now succeeds-or-fails on the current code path. Likely **abandon** (stale).
- Rows 66/141 (calendar, `output is not a calendar-day file`): **blocked on Task 3** — don't retry until the fetcher root cause is fixed, or they re-fail 3/3. After Task 3: retry.
- Drain via the `dome.health` recovery questions (`dome check` → `dome resolve <id> retry|abandon`). Goal: outbox empty, `outbox.recurring-failure` findings clear.

### Task 3 — calendar fetch root cause (the headline; I-diagnose → branch)
The fetcher (`.dome/bin/fetch-calendar.sh`) runs headless `claude -p` against a Google Calendar MCP and validates the output is a `calendar-day` markdown file. Row 66 failed the frontmatter gate. **Diagnose first** — run the fetcher by hand and capture actual output:
```
cd /Users/mark.toda/vaults/work && sh .dome/bin/fetch-calendar.sh "$(date +%F)" /tmp/cal-test.md; echo "exit=$?"; cat /tmp/cal-test.md
```
Branch on what the output actually is:
- **(O) MCP-auth error** (the model says it can't reach Calendar / isn't authorized) — same class as the Slack MCP gap: authorize the Google Calendar connector headlessly (`/mcp` in a `claude` session). Owner action. Most likely root cause given the symptom.
- **(C) Loose/prose/fenced model text** (real data, wrong shape) — harden the **shipped template** `assets/source-handlers/claude-calendar.sh`: a stricter "output ONLY the document, no preamble, no code fences" prompt PLUS a deterministic repair step (strip fences/preamble, re-wrap to the calendar-day shape) so loose output still validates. SDK change → worktree+test+merge, then re-copy to the vault. Apply the same hardening to `claude-slack.sh` (identical fragility).
- **(C) Genuinely empty day** (no events, model emits bare prose) — the template + validate gate should accept a well-formed *empty* calendar-day file (frontmatter + "no events today"); fix the template to emit that shape. SDK change.

Note: this is the "its own small decision" flagged at Half-A scoping — resolve the diagnosis before picking the fix; don't pre-build a deterministic EventKit/API fetcher (it trades LLM-formatting-fragility for OAuth/credential plumbing, the very thing the headless-Claude approach avoids).

### Task 4 — launchd PATH robustness (I)
The serve plist (`~/Library/LaunchAgents/com.dome.serve.work-cda3a1f5.plist`) PATH lacks `~/.local/bin` (where `claude` lives) — the calendar fetch only works because the script was edited to a hardcoded absolute path. Make it robust: add `$HOME/.local/bin` (and confirm the nix-profile bun dir is present) to the plist's `EnvironmentVariables` PATH; re-verify the `com.dome.drain-captures` and `com.dome.http.work` agent PATHs carry the same (the drain already needed the nix-profile fix). `dome restart` after. Independent of any script's absolute paths — defense in depth.
- **Candidate (note, don't build here):** a `dome doctor` check for "the daemon's resolved PATH can't resolve a configured fetch/provider command" would make this class self-surfacing — but that's Half-A-class engine work; record it as a resilience follow-up, don't fold into this ops pass.

### Task 5 — raw/-immutable re-fire trace (I-diagnose → branch)
A processor repeatedly tries to patch `raw/assets/adoption-capture-funnel.excalidraw.md`, denied every tick by raw-immutability — wasted ticks + log spam. Trace: grep serve.log for the denial, identify which processor (its grant/trigger touches `raw/**`). Branch:
- **(O) the file is mis-placed** — it's an editable capture artifact living under append-only `raw/`; the fix is to move it out of `raw/` (owner decision — it's his content). Likely the real answer.
- **(C) a processor shouldn't react to `raw/`** — if a markdown/sweep processor is triggering on `raw/**` when it shouldn't, tighten its trigger/grant to exclude `raw/`. SDK change.

### Task 6 — owner-action checklist (O; completes the ambient story, not strictly cleanup)
- Slack OAuth: `/mcp` → authorize claude.ai Slack → I smoke-test headless + flip `subscriptions.slack.enabled: true`.
- Tailscale on → I rebind `com.dome.http.work` from loopback to the TS IP (100.83.249.55) + restart.
- Build the iOS Shortcut per `dome recipe ios`.

### Task 7 — final verification (I)
`dome doctor` clean (no `outbox.recurring-failure`, no `questions.unreadable-backlog`, no `run.recurring-timeout`); outbox empty/healthy; serve.log quiet (no timeout loop, no raw/-denial spam, no "tick threw"); `dome status` attention driven to baseline. Capture the before/after as the evidence this pass worked. Append the executed steps to the migration runbook (`docs/cohesive/runbooks/2026-06-server-migration.md`) as the "Half B — operational cleanup" section.

---

**Sequencing:** 0 → 1 (verify) → 3-diagnose (it gates 2 and may spawn a C-chunk) → 4, 5 (parallel-ish, I/diagnose) → 2 (drain, after 3) → 6 (owner, anytime) → 7 (verify). Run interactively; pause at each O-step and C-branch.
