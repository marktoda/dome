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

## 2026-06-02 Steady-State Work-Vault Smoke

Dogfood action:

- Re-ran the work-vault V1 surfaces after fixing the transient `.dome/state`
  git-status race: `status`, `check`, `today`, `query "today open loops"`,
  and `export-context "today open loops"`.
- Used the steady-state status after the compiler host finished the overlapping
  `today` run.

Operational result:

- `status` reported `sync_needed: false`, no dirty files, no pending or failed
  runs, no open questions, no outbox/quarantine issues, and no attention.
- Loop states were:
  - `dome.capture.digest`: inactive because `dome.intake` is disabled in the
    work vault and there are no raw captures waiting.
  - `dome.open-loop.continuity`: quiet.
  - `dome.link-concept.coherence`: drift from 46 informational diagnostics,
    with no attention diagnostics.
  - `dome.context.packet`: quiet.
  - `dome.question.continuity`: quiet.
- `check` reported engine status `ok`. The 46 content diagnostics are known
  informational backlog grouped under `link.resolve-or-create` and
  `frontmatter.repair`.

Daily/context result:

- `today` found `notes/2026-06-02.md`, reported 221 source-backed open tasks,
  sampled both daily-surface rows and backlog rows, and had 0 questions.
- The current daily queue shape was 12 daily open tasks plus 209 backlog tasks;
  24 rows were shown and 197 were omitted from the compact view.
- `query "today open loops"` and `export-context "today open loops"` both put
  `notes/2026-06-02.md` first via the `current daily surface` recall signal.
- The context packet overview carried current daily cockpit open-loop rows
  with SourceRefs to both the daily surface and backing sources.

Qualitative read:

- This reconfirms the M4/M6 handoff in the current work vault: daily-intent
  foreground-agent prompts now start from the same cockpit Mark uses.
- This does not close V1. The M10 gap remains elapsed dogfood proof across
  real work days, especially capture digestion while `dome.intake` is enabled
  and model-assisted consolidation/question handling are exercised.

## 2026-06-02 Optional Anthropic Capture Smoke

Dogfood action:

- Added `bun run v1:llm-smoke` as an optional networked smoke for the
  scaffolded Anthropic command-provider path.
- The smoke creates a temporary vault with
  `dome init --with-model-provider anthropic`, enables `dome.intake`, commits
  one raw capture, runs `dome sync`, checks generated/archived capture output,
  queries the adopted state, and runs a second sync pass to verify settlement.
- The default `v1:check` gate remains offline and deterministic; this smoke is
  for explicit local/API-backed V1 evidence.

Operational result:

- First attempt exposed a harness issue: the temporary vault inherited local
  GPG commit signing and failed before Dome could run. The smoke now disables
  signing only for its disposable git commands.
- Second attempt digested the capture through the real Anthropic provider and
  passed:
  `v1-llm-smoke: ok | generated wiki/generated/intake/v1-llm-smoke-8935059556ce.md | archive inbox/processed/v1-llm-smoke-8935059556ce.md | sync_heads ca939a1 -> ca939a1 | diagnostics 0 | questions 1`.
- The remaining question was low-risk and `agent-safe`, which is acceptable V1
  behavior: the model path preserved uncertainty instead of silently asserting
  the follow-up.

Qualitative read:

- This materially strengthens M2/M3 evidence for the real model-provider path.
  The capture loop now has a repeatable smoke that exercises actual networked
  model invocation without making normal tests depend on external services.
- This still does not close M10. It proves one controlled capture path, not a
  week of real work-vault capture digestion.

## 2026-06-02 Optional Auto-Resolution Smoke

Dogfood action:

- Extended `bun run v1:llm-smoke` with `--auto-resolve`.
- The new mode enables `engine.auto_resolve_questions` for low-risk
  `agent-safe` questions in the temporary vault and adds one deterministic
  ambiguous follow-up page while still processing the raw capture through the
  real Anthropic provider.
- The smoke verifies that the deterministic question is answered with the
  recommended `track` answer and that the accepted follow-up lands through the
  normal garden answer-handler path.

Operational result:

- First attempt exposed a fixture issue: the deterministic follow-up page was a
  bare markdown file, so the markdown loop correctly raised
  `dome.markdown.missing-frontmatter` diagnostics. The fixture now uses normal
  `type: concept` frontmatter.
- The passing run:
  `v1-llm-smoke: ok | generated wiki/generated/intake/v1-llm-smoke-8935059556ce.md | archive inbox/processed/v1-llm-smoke-8935059556ce.md | sync_heads 21ee736 -> 21ee736 | diagnostics 0 | questions 0 | auto_resolved 1`.

Qualitative read:

- This strengthens M7 evidence. Low-risk `agent-safe` uncertainty can be
  resolved without Mark manually answering every question, and the resulting
  markdown change still goes through the existing answer-handler, garden, and
  adoption path.
- This remains controlled smoke evidence, not full M10 release soak.

## 2026-06-02 M8 Recall Smoke Tightening

Dogfood action:

- Tightened `bun scripts/v1-smoke.ts --sync-docs` so `query` and
  `export-context` must do more than return the right JSON schemas.
- The smoke now requires top recall/export results to carry source refs,
  explainable ranking reasons/signals, and source-backed context summaries.
- This makes M8 provenance and ranking quality part of the repeatable dogfood
  gate for both `docs/` and the work vault.

Operational result:

- Passing run:
  `v1-smoke: docs ok | branch main | head d95ae95 | adopted d95ae95 | synced no | views 5 ok | notices none`
- Passing run:
  `v1-smoke: work ok | branch main | head 99fac73 | adopted 99fac73 | synced no | views 5 ok | notices 46 informational diagnostic(s)`
- `bun run typecheck` also passed after the smoke change.

Qualitative read:

- The current M8 boundary is coherent: `query` is source-backed recall, while
  `export-context` is the generated answer-prep packet for foreground agents.
- Embeddings remain deferred for V1 because the current docs/work dogfood
  queries are served by FTS plus graph, page-type, open-loop, decision,
  question, diagnostic, and projection-recall signals.
- This still does not close M10. It improves repeatable evidence for recall
  quality, but release readiness still needs elapsed work-vault usage.

## 2026-06-02 M10 Convergence Smoke Tightening

Dogfood action:

- Tightened `bun scripts/v1-smoke.ts --sync-docs` so a clean, already-adopted
  vault must pass an explicit no-source-change `dome sync --json`.
- The smoke now requires `status: in-sync`, `iterations: 0`, no closure commit,
  and zero garden sub-proposals/rejected patches/diagnostics.
- If a vault has dirty drafts or pending commits, the settlement check is
  skipped and reported as a notice instead of forcing adoption.

Operational result:

- Docs and work vaults both passed the new settlement assertion before this
  ledger entry was added. The then-current smoke summary did not yet print the
  `settled` field, but the assertion was active and the run completed with no
  notices for docs and only the known informational diagnostics for work.
- After the summary was updated to print settlement state, the work vault
  result was:
  `v1-smoke: work ok | branch main | head 99fac73 | adopted 99fac73 | synced no | settled checked | views 5 ok | notices 46 informational diagnostic(s)`
- The docs vault skipped settlement in that later run because this ledger and
  `docs/v1.md` were draft-modified at the time, which is the intended
  conservative behavior.
- Manual `dome sync --json` probes immediately before the code change showed
  both vaults returning `status: in-sync`, `iterations: 0`, and
  `closureCommit: null`.

Qualitative read:

- This gives repeatable evidence for the M10 convergence slice: repeated
  no-source-change compiler runs settle for the current docs and work vaults.
- This still does not close M10. It is a convergence gate, not elapsed
  day-to-day usefulness evidence across two real work weeks.
