# Dome V1 Work-Vault Dogfood Ledger

**Started:** 2026-06-02
**Scope:** M10 release soak for `docs/v1.md`
**Vault:** Mark's work vault

This ledger tracks whether Dome is actually improving day-to-day work in the
work vault. It should record outcomes, not just command success.

The M10 gate is not satisfied until this has enough real usage to show that
Dome is meaningfully better than plain markdown plus ad hoc Claude Code
maintenance.

## Rubric

Each workday entry should capture:

- daily note usefulness: could the day start from the Dome surface?
- capture digestion: were captures processed, preserved, and useful?
- open-loop surfacing: did important tasks/follow-ups appear without manual
  prompting?
- context packet quality: did `query` or `export-context` reduce manual file
  hunting for a foreground agent?
- question burden: did low-risk questions resolve without turning Mark into a
  clerk?
- link/concept hygiene: were remaining diagnostics understood backlog rather
  than mysterious failure?
- friction: what did Mark or a foreground agent still have to ask Claude Code
  to do manually that Dome should have handled?

## 2026-06-02 Baseline

Commands run from the SDK repo after `2eb2fc0`:

- `bin/dome status --vault ~/vaults/work --json`
- `bin/dome check --vault ~/vaults/work --json`
- `bin/dome today --vault ~/vaults/work --json`
- `bin/dome query --vault ~/vaults/work "today open loops" --json`
- `bin/dome export-context --vault ~/vaults/work "today open loops" --json`
- `bin/dome inspect bundles --vault ~/vaults/work --model --json`

Observed state:

- Work vault is in sync, with no attention required.
- No dirty modified or untracked files.
- `status` shows 46 diagnostics, all non-attention diagnostics.
- `status` shows 0 open questions.
- Loop states:
  - `dome.capture.digest`: inactive because `dome.intake` is disabled; the
    model provider is configured, so enabling intake is a deliberate dogfood
    decision rather than a missing-provider blocker.
  - `dome.open-loop.continuity`: quiet.
  - `dome.link-concept.coherence`: drift, explained by the 46 non-attention
    diagnostics.
  - `dome.context.packet`: quiet.
  - `dome.question.continuity`: quiet.
- `today` for 2026-06-02 returns 24 open tasks, 0 followups, and 0 questions.
- `query "today open loops"` returns 10 matches with source-backed ranking
  reasons and more matches available.
- `export-context "today open loops"` returns 8 entries, 2 overview open loops,
  no overview diagnostics, and more entries available.

Qualitative read:

- The engine is operationally clean enough to dogfood.
- The daily surface has enough content to be useful, but the next test is
  whether 24 open tasks feels like a helpful work queue or too much backlog.
- Context packet/search surfaces are returning source-backed material with
  explainable ranking, but usefulness still needs a real foreground-agent
  session.
- Link/concept diagnostics are understood backlog today, not release-blocking
  engine failure.
- Capture digestion is not being dogfooded yet because intake is disabled in
  the work vault.

Next dogfood checks:

1. Use `today` as the starting work queue for at least one real work session.
2. Ask a foreground agent to use `export-context` before a real work-vault
   task, then note whether it avoided manual file hunting.
3. Decide whether to enable `dome.intake` in the work vault for a controlled
   capture week.
4. Record whether the 46 link/concept diagnostics shrink, stay as known
   backlog, or become distracting noise.

## 2026-06-02 Foreground-Agent Orientation Refresh

Dogfood action:

- Ran `bin/dome init ~/vaults/work --refresh-instructions` after inspecting the
  work-vault foreground-agent orientation.

Observed issue:

- `~/vaults/work/AGENTS.md` had stale managed Dome instructions even though it
  already carried the user-prose delimiters.
- The stale section included obsolete workflow guidance and a nonstandard
  `.worktrees/` worktree location, which directly conflicts with the current
  repo-wide worktree convention.
- The CLI refresh path treated the presence of user-prose delimiters as a
  reason to skip the file, so managed orientation could remain stale forever.

Fix shipped in the SDK:

- `dome init --refresh-instructions` now replaces the managed `AGENTS.md`
  scaffold while preserving the delimited user-prose block.
- Legacy files without delimiters are preserved inside a new
  `## Previous vault-specific instructions` user-prose section instead of being
  overwritten.
- The managed template now tells foreground agents to use
  `dome export-context <topic> --json`, `dome query <text> --json`, and the
  daily/planning views as read-first context surfaces before broad manual file
  hunting.

Work-vault result:

- `~/vaults/work/AGENTS.md` now has current Dome workflow guidance.
- The work-vault-specific operating contract was preserved in the user-prose
  block.
- The stale `.worktrees/` guidance is gone from the active orientation surface.

Qualitative read:

- This closes one concrete M10 friction item: a foreground agent entering the
  work vault now sees current Dome context-packet guidance instead of stale
  scaffold text.
- The next dogfood question is whether agents actually follow the read-first
  guidance and whether the returned context packets are good enough to reduce
  manual vault spelunking.

## 2026-06-02 Context Packet Payload Bound

Dogfood action:

- Ran `bin/dome export-context --vault ~/vaults/work "Dome v1 work vault dogfood" --json`.
- Ran `bin/dome query --vault ~/vaults/work "Dome v1 work vault dogfood" --json`.

Observed issue:

- The packet correctly found `log.md` and `AGENTS.md`, but `log.md` is a
  highly connected work-vault file.
- Structured JSON included the full related fact array for `log.md`, producing
  a very large packet that was not a good foreground-agent handoff.
- Ranking reasons also surfaced raw high-cardinality graph counts like
  `1000 graph signals`, which was technically explainable but not useful.

Fix shipped in the SDK:

- `dome query --json` now bounds per-match related facts, diagnostics, and
  questions to topic-prioritized rows.
- `dome export-context --json` now serializes bounded related rows while the
  markdown packet still includes omitted-row hints such as `more facts`.
- High-cardinality graph ranking reasons now render as `many graph signals`
  instead of noisy raw counts.
- The CLI spec now states that `query` and `export-context` are concise
  handoff/read-first surfaces; exhaustive evidence belongs in `dome inspect
  facts`, `dome inspect diagnostics`, and `dome inspect questions`.

Work-vault result:

- The same `export-context` smoke now returns 2 entries.
- `log.md` exposes 8 related facts, 0 diagnostics, and 0 questions.
- `AGENTS.md` exposes 1 related fact, 0 diagnostics, and 0 questions.
- The structured export packet is about 10 KB for this query, and the markdown
  packet is about 1.8 KB.

Qualitative read:

- This closes a concrete M6/M10 friction item: foreground agents can use JSON
  context packets without being flooded by exhaustive projection rows from
  high-degree pages.
- The next context-packet dogfood question is quality, not payload size: did
  the packet select the right read-first files for a real task?
