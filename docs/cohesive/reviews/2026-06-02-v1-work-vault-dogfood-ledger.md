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

## 2026-06-02 Daily-Intent Context Packet Recall

Dogfood action:

- Ran `bin/dome today --vault ~/vaults/work --json`.
- Ran `bin/dome export-context --vault ~/vaults/work "what should I work on today" --json`.
- Ran `bin/dome query --vault ~/vaults/work "what should I work on today" --json --limit 8`.

Observed issue:

- `today` correctly found the current daily note at `notes/2026-06-02.md`.
- The daily note had 12 daily-surface open loops and source-backed evidence.
- The generic context packet did not put `notes/2026-06-02.md` in the
  read-first set. It prioritized older high-degree entity and synthesis pages
  because those pages had many open-loop and graph signals.
- This made the packet less useful than `dome today` for a natural foreground
  agent query like "what should I work on today".

Fix shipped in the SDK:

- `dome.search` now adds a source-backed `current daily surface` recall signal
  for daily-intent topics such as `today`, `daily`, `yesterday`, `tomorrow`, or
  an explicit `YYYY-MM-DD`.
- The recall signal is derived from existing date-named markdown files in the
  adopted snapshot, not from working-tree state or hidden `.dome/state`.
- `query` and `export-context` share the same temporal recall path, so the CLI
  surfaces stay coherent.

Work-vault result:

- `export-context "what should I work on today"` now includes
  `notes/2026-06-02.md` as the first read-first entry with reason
  `current daily surface`.
- `query "what should I work on today"` also ranks
  `notes/2026-06-02.md` first.
- The packet still includes high-signal entity/project pages after the daily
  cockpit, but the day-oriented handoff prompt no longer misses the current
  daily note.

Qualitative read:

- This closes a second concrete M6/M10 friction item: foreground agents asking
  natural daily-work questions now start from the same daily surface Mark uses,
  instead of treating the work vault like a generic FTS corpus.

## 2026-06-02 Daily Surface Near-Duplicate Folding

Dogfood action:

- Ran `bin/dome today --vault ~/vaults/work --json` after the daily-intent
  recall fix.
- Inspected the current daily rows and the sampled backlog rows for duplicate
  work-surface noise.

Observed issue:

- The daily surface was source-backed and useful, but the visible queue still
  repeated near-identical open loops across today's note, previous daily notes,
  and project/synthesis pages.
- Exact open-loop keys already folded repeated rows, but small wording changes
  such as a current daily wording versus an older backlog wording could still
  show as separate action rows.
- This made `dome today` feel more like a raw projection dump than a cockpit
  when the same piece of work had accumulated multiple source mentions.

Fix shipped in the SDK:

- `dome.daily` now folds near-duplicate daily task rows at the view layer using
  conservative token overlap.
- The fold is source-preserving: it does not edit or delete markdown source
  tasks. It chooses one representative display row and retains source refs.
- Source-backed generated daily rows now carry both the daily surface line and
  the backing source path, so the rendered row can explain where the work came
  from.
- Merged row source refs are compacted to the best ref per file path for the
  view payload, preferring line-specific evidence over page-level refs.
- Representative selection prefers daily-surface rows, direct user-authored
  rows over generated carry-forward rows when both are daily rows, and newer
  source changes when other signals tie.

Work-vault result:

- `dome today --vault ~/vaults/work --json` dropped from 246 open tasks before
  the fix to 221 open tasks after the fix, without modifying the work vault.
- Generated daily rows now render evidence labels such as
  `notes/2026-06-02.md:25; source notes/2026-06-01.md:34`.
- Some visible semantic duplicates remain. For example, Danny written follow-up
  rows with materially different wording are still present. That is the right
  boundary for this deterministic slice; broader consolidation belongs to the
  open-loop continuity loop with model or agent judgment.

Qualitative read:

- This closes one concrete daily-surface friction item without adding a new
  command, hidden state, or source-rewriting policy.
- The daily work surface is less noisy while staying inspectable and
  convergent.
- The next dogfood question is whether the remaining semantic duplicates should
  become source-preserving consolidation proposals or be left as separate
  evidence until a model-backed loop can decide.

## 2026-06-02 Daily-Intent Packet Open-Loop Overview

Dogfood action:

- Ran `bin/dome export-context --vault ~/vaults/work "what should I work on today" --json`.
- Compared the packet overview against `bin/dome today --vault ~/vaults/work --json`.

Observed issue:

- The previous daily-intent recall fix put `notes/2026-06-02.md` first in
  `Read First`, but `overview.openLoops` still came from generic projection
  facts on matched pages.
- For a foreground agent asking what to work on today, that meant the packet
  identified the right cockpit file but did not carry the cockpit's visible
  work queue in the overview.

Fix shipped in the SDK:

- `dome.search.export-context` now treats recalled daily files as daily surface
  evidence for daily-intent packets.
- It parses hand-authored open checkboxes/directives and generated
  source-backed open-loop rows from the recalled daily surface.
- Parsed daily rows are prepended to the packet overview's `Open Loops`
  section before generic topic-relevant projection facts.
- Generated rows preserve both the daily surface line SourceRef and the
  backing source SourceRef, matching the `dome today` provenance model.

Work-vault result:

- `export-context "what should I work on today"` now returns
  `notes/2026-06-02.md` as the first read-first entry with reason
  `current daily surface`.
- The first eight `overview.openLoops` rows all come from
  `notes/2026-06-02.md`, so the packet carries the daily cockpit queue instead
  of generic entity-page loops.
- Generated daily rows include both the daily surface path and backing source
  paths in their SourceRefs.

Qualitative read:

- This closes the next M4/M6 handoff gap: a foreground agent can ask the
  natural daily-work question and receive both the daily note as read-first
  context and the current daily work queue as structured overview data.
