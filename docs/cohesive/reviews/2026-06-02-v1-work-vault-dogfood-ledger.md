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

## 2026-06-02 M10 Dogfood Snapshot Script

Dogfood action:

- Added `bun run v1:dogfood-snapshot` as a read-only helper for the M10 dogfood
  ledger.
- The script runs the standard work-vault surfaces: `status`, `check`,
  `today`, `query`, and `export-context`.
- It emits a Markdown snapshot with operational state, maintenance-loop state,
  known diagnostic backlog, daily cockpit counts, first visible tasks,
  context-packet read-first entries, packet open-loop examples, query top
  matches, and blanks for qualitative notes.

Operational result:

- `bun run v1:dogfood-snapshot -- --date 2026-06-02 --limit 5` passed against
  the work vault.
- The generated snapshot reported the work vault synced at head/adopted
  `99fac73`, 0 dirty files, 0 failed runs, 46 informational diagnostics, 0
  questions, the known inactive capture loop, and `notes/2026-06-02.md` as the
  daily surface and first context-packet read-first entry.
- Follow-up hardening fixed the snapshot date semantics: `--date` now feeds the
  `dome today --date` call instead of only changing the Markdown heading.
- `tests/scripts/v1-dogfood-snapshot.test.ts` now covers script help and a
  disposable-vault end-to-end snapshot through the real process boundary.

Qualitative read:

- This makes M10 easier to run honestly. Future dogfood entries can start from
  the same measured surface snapshot and then add the subjective notes the V1
  plan requires.
- This still does not close M10. It records evidence more reliably; it does
  not create elapsed real work-vault usage.

## 2026-06-02 LLM Smoke Refresh

Dogfood action:

- Re-ran the optional networked Anthropic smoke after the V1 gate hardening.
- Ran both `bun run v1:llm-smoke` and
  `bun run v1:llm-smoke -- --auto-resolve`.

Operational result:

- Base smoke passed:
  `v1-llm-smoke: ok | generated wiki/generated/intake/v1-llm-smoke-8935059556ce.md | archive inbox/processed/v1-llm-smoke-8935059556ce.md | sync_heads eae2ad2 -> eae2ad2 | diagnostics 0 | questions 1`.
- Auto-resolution smoke passed:
  `v1-llm-smoke: ok | generated wiki/generated/intake/v1-llm-smoke-8935059556ce.md | archive inbox/processed/v1-llm-smoke-8935059556ce.md | sync_heads 60eb567 -> 60eb567 | diagnostics 0 | questions 0 | auto_resolved 2`.

Qualitative read:

- This refreshes the M2/M3/M7 evidence for the real scaffolded Anthropic
  command-provider path: capture digestion, raw preservation, adopted-state
  query recall, settlement, durable uncertainty, and opt-in low-risk
  auto-resolution all work in a disposable vault.
- This remains controlled networked smoke evidence. It does not replace the
  M10 requirement for sustained work-vault dogfood with real captures.

## 2026-06-02 M10 Dogfood Report

Dogfood action:

- Added `bun run v1:dogfood-report` as a release-soak audit helper.
- Ran the report against this dogfood ledger after the LLM smoke refresh.
- Added `--require-ready` so the report can serve as the final M10 gate.

Operational result:

- Current report:
  `Status: not-ready`; `Complete workdays: 0/10`; `Capture-evidence days: 0/5`;
  `Complete-workday span: 0/12 calendar day(s)`; `Release blockers: 0`.
- `bun run v1:dogfood-report -- --require-ready` currently exits nonzero,
  which is expected until the real work-vault soak is complete.
- The report detected the dated 2026-06-02 evidence as partial with operational
  evidence but no complete rubric-covered workday and no filled safety
  confirmations.
- Controlled smoke capture paths and unfilled snapshot prompts do not count as
  real capture-evidence days.
- Qualitative-only notes also do not count as complete workdays; a counted M10
  day needs measured Dome surface output plus filled post-session notes.
- Short backfilled ledgers do not satisfy the release soak either; counted
  complete workdays need to span a two-work-week calendar window.
- Counted M10 days now also require explicit negative safety confirmations for
  lost/overwritten human markdown edits and manual `.dome/state` edits. Any
  observed safety issue keeps the release-soak report `not-ready`.

Qualitative read:

- This makes the M10 gate more honest. The ledger now has useful engineering
  evidence, but it still lacks filled daily work-session notes for the required
  rubric dimensions.
- The next M10 step is to run `bun run v1:dogfood-snapshot` during actual work
  sessions, fill the qualitative fields after the session, and re-run
  `bun run v1:dogfood-report` until the report reflects enough real work-vault
  usage.

## 2026-06-02 M10 Dogfood Preflight

Dogfood action:

- Added `bun run v1:dogfood-preflight` as a read-only M10 session readiness
  check.
- Ran `bun run v1:dogfood-preflight -- --json` against the work vault.

Operational result:

- Collection status: `not-ready`.
- Operational readiness: ready, with no findings.
- Capture readiness: not ready.
- Capture findings:
  - `dome.intake is disabled`
  - `dome.intake processors are not loaded`
  - `dome.intake model status is disabled-provider-configured`
- Release report: still `not-ready` with 0 complete workdays, 0
  capture-evidence days, 0 complete-workday span days, and 0 release blockers.

Qualitative read:

- The work vault is clean enough to dogfood non-capture daily/context surfaces.
- The missing M10 capture-digestion proof will not start accumulating until
  `dome.intake` is intentionally enabled for the work vault.
- This preflight is deliberately read-only; it records the setup gap without
  changing Mark's vault configuration.

## 2026-06-02 Intake Dogfood Enabled

Dogfood action:

- Enabled `dome.intake` in `~/vaults/work/.dome/config.yaml`.
- Committed the work-vault setup change as `183fc6a Enable Dome intake dogfood`.
- Ran `bin/dome sync --vault ~/vaults/work --json`.
- Ran `bun run v1:dogfood-preflight -- --json`.
- Ran `bun scripts/v1-smoke.ts`.

Operational result:

- `find inbox/raw -maxdepth 2 -type f` returned no files before enablement, so
  the change made capture dogfood ready without immediately processing a raw
  capture.
- Dome adopted the work-vault setup commit at
  `183fc6acb7bbb2b3511f0a6d63219eef235e1b68`.
- Sync result: `status: adopted`, `iterations: 1`, `closureCommit: null`, 0
  garden sub-proposals, 0 rejected patches, 0 operational jobs, and no
  attention required.
- `dome inspect bundles --vault ~/vaults/work --model --json` now reports
  `dome.intake` as `enabled`, `loaded: true`, 6 processors, 3 model
  processors, and model status `ready`.
- `bun run v1:dogfood-preflight -- --json` now reports overall session
  collection status `ready`, operational readiness `true`, and capture
  readiness `true`.
- `bun scripts/v1-smoke.ts` passed with the work vault at head/adopted
  `183fc6a`, settled checked, 5 views ok, and the known 46 informational
  diagnostics.

Qualitative read:

- This removes the last setup blocker for collecting real capture-digestion
  evidence in the work vault.
- V1 still is not done. The release-soak report remains `not-ready` with 0
  complete workdays, 0 capture-evidence days, and 0 release blockers because
  elapsed real work-vault usage has not been recorded yet.

## 2026-06-02 First Work-Vault Capture Dogfood Session

Dogfood action:

- Added a controlled raw capture at
  `inbox/raw/2026-06-02-dome-v1-dogfood-capture.md`.
- Committed the raw source as `3198f81 Add Dome V1 dogfood capture`.
- Ran `bin/dome sync --vault ~/vaults/work --json`, which processed the
  capture through the enabled `dome.intake` bundle.
- The first digest exposed a real product issue: expected Dome behavior from
  the capture was misclassified as two follow-ups, and those false follow-ups
  reached the daily surface.
- Fixed the SDK in `239435d Preserve explicit intake questions`:
  - `dome.intake.extract-capture` now asks for `questions:item[]`.
  - generated capture pages render explicit `## Questions`.
  - `dome.intake.capture-index` emits `dome.intake.question` facts and
    source-backed `QuestionEffect`s for explicit capture questions.
  - generated and archived capture pages record `processor` and
    `extraction_schema`.
  - the capture page type declares the new frontmatter fields.
- Reintroduced the same raw capture as `7388a84 Reprocess Dome V1 dogfood
  capture` and re-ran sync through the v3 extractor.
- Answered the resulting agent-safe question through `dome resolve`, recording
  that this capture is valid first M10 capture evidence but not V1 release
  completion.
- Ran `bun run v1:dogfood-snapshot -- --date 2026-06-02 --limit 5`.

Commands run:

- `bin/dome status --vault /Users/mark.toda/vaults/work --json`
- `bin/dome check --vault /Users/mark.toda/vaults/work --json`
- `bin/dome today --vault /Users/mark.toda/vaults/work --date 2026-06-02 --json`
- `bin/dome query --vault /Users/mark.toda/vaults/work "today open loops" --limit 5 --json`
- `bin/dome export-context --vault /Users/mark.toda/vaults/work "today open loops" --limit 5 --json`

Operational state:

- Work-vault head/adopted: `5716af7` / `5716af7`; sync needed: no.
- Dirty files: 0 modified, 0 untracked.
- Operational runs: 0 pending, 0 failed, 0 failed outbox, 0 quarantined.
- Attention: no; diagnostics: 46 total / 0 attention; questions: 0.
- `dome.capture.digest`: quiet; diagnostics 0; questions 0; owner-needed 0.
- `dome.open-loop.continuity`: quiet; diagnostics 0; questions 0.
- `dome.link-concept.coherence`: drift from 46 known informational
  diagnostics, all non-attention.
- `dome.context.packet`: quiet.
- `dome.question.continuity`: quiet.

Measured daily/context surface:

- Daily note: `notes/2026-06-02.md`; exists: yes.
- Open tasks: 224 total, 12 daily and 212 backlog.
- Follow-ups: 1.
- Questions: 0.
- First visible tasks after the fix:
  - Continue the two-work-week M10 dogfood window before calling V1 complete.
  - Alice 1:1 compensation/promo follow-up.
  - Danny written follow-up.
  - Charles Ma routing backfill.
  - Hayden mandate/comp summary.
- `export-context "today open loops"` read-first entries start with
  `notes/2026-06-02.md`, followed by source/entity pages with open-loop
  evidence.

Capture evidence:

- Raw source path:
  `inbox/raw/2026-06-02-dome-v1-dogfood-capture.md`.
- Processed archive:
  `inbox/processed/2026-06-02-dome-v1-dogfood-capture-108236acd961.md`.
- Generated intake page:
  `wiki/generated/intake/2026-06-02-dome-v1-dogfood-capture-108236acd961.md`.
- Generated capture now includes `extraction_schema:
  dome.intake.extract-capture/v3`, a `## Questions` section, and no false
  follow-ups for "produce generated page" / "archive raw material".
- The explicit capture question was surfaced as an agent-safe question and
  answered through the normal resolve path.

Qualitative notes:

- Daily note usefulness: Useful as a cockpit and source-backed; after the
  intake fix it no longer starts with two completed system-behavior follow-ups.
  It is still noisy at 224 open tasks, so future M10 days should keep watching
  whether the daily queue feels like a useful work surface or backlog dump.
- Capture digestion: Useful enough to count as first capture-evidence day. It
  preserved the raw material, archived to `inbox/processed`, generated a
  source-backed intake page, exposed an explicit question, and converged after
  the false-follow-up prompt/schema fix.
- Open-loop surfacing: The loop successfully raised capture-derived open work
  into the daily surface. The first run over-surfaced completed system
  behavior; the v3 reprocess reduced this to the real remaining M10 follow-up.
- Context packet quality: `export-context "today open loops"` starts with the
  current daily note and carries the same first visible daily work queue, so it
  is a usable foreground-agent handoff for this session.
- Question burden: The only capture question was agent-safe and was answered
  by the foreground agent through `dome resolve`; Mark did not need to manually
  answer it.
- Link/concept hygiene: Remaining 46 diagnostics are known informational
  backlog, not mysterious engine failure. The temporary `extraction_schema`
  frontmatter warnings were fixed by updating the intake page type.
- Friction / manual foreground-agent work Dome should own: The main friction
  was a prompt/schema gap in capture digestion. Fixing it required SDK work
  rather than a one-off vault cleanup, which is the right M10 outcome.
- Lost or overwritten human markdown edits: No lost or overwritten human
  markdown edits observed.
- Manual .dome/state edits: None.

Qualitative read:

- This is the first counted capture-digestion dogfood day, not release
  readiness. It proves the capture loop can run in the work vault, expose a
  model-quality issue, receive a clean SDK fix, reprocess source-preservingly,
  and settle with no attention.

## 2026-06-02 Networked V1 LLM Smoke

Verification action:

- Ran `bun run v1:llm-smoke -- --auto-resolve` with the local Anthropic API key
  against a temporary vault.
- The smoke used `dome init --with-model-provider anthropic`, enabled
  `dome.intake`, committed a raw capture, and ran `dome sync` until settled.
- It then verified generated capture output, processed archive output,
  adopted-state query recall, no-source-change settlement, and opt-in
  low-risk `agent-safe` question auto-resolution.

Measured result:

- Result: `v1-llm-smoke: ok`.
- Generated intake page:
  `wiki/generated/intake/v1-llm-smoke-8935059556ce.md`.
- Processed archive:
  `inbox/processed/v1-llm-smoke-8935059556ce.md`.
- Sync heads: `5195753 -> 5195753`, showing the final pass settled without
  another head change.
- Diagnostics: 0.
- Open questions: 0.
- Auto-resolved questions: 2.

Qualitative read:

- This closes supporting evidence for the scaffolded command-model provider
  path and opt-in low-risk auto-resolution. It is intentionally not counted as
  M10 release-soak credit because it ran in a temporary vault rather than
  during sustained work-vault usage.

## 2026-06-02 Work-Vault Serve Host Started

Operational action:

- Started `dome serve --vault /Users/mark.toda/vaults/work --quiet
  --poll-interval-ms 1000` in a detached local `screen` session named
  `dome-work-serve`.
- Verified `dome status --vault /Users/mark.toda/vaults/work --json` reported
  `serve_status: running`, `serve_pid: 6406`, `serve_branch: main`, no pending
  runs, no failed runs, no failed outbox rows, and no quarantined processors.
- Verified `bun run v1:dogfood-preflight -- --json` reported collection status
  `ready`, serve readiness `true`, capture readiness `true`, and release
  status `not-ready`.
- Verified `bun run v1:dogfood-snapshot -- --date 2026-06-02 --limit 1`
  rendered `Serve host: running; branch main; pid 6406`.

Qualitative read:

- This improves the M10 evidence posture for future work sessions. It does not
  add another counted workday by itself; the release soak still needs filled
  daily qualitative notes across the required elapsed window.

## 2026-06-02 M10 Host-Evidence Report Gate Tightening

Verification action:

- Tightened `bun run v1:dogfood-report` so complete release-soak workdays now
  require running serve-host evidence.
- Added `serveHostEvidence` per day and `serveHostEvidenceDays` to the report
  and preflight JSON surfaces.
- Added regression coverage proving a day with `Serve host: off` does not count
  as a complete workday even when the qualitative rubric and safety checks are
  otherwise filled.

Measured result:

- `bun run v1:dogfood-report -- --json` now reports `serveHostEvidenceDays:
  1`, `completeWorkdays: 1`, `captureEvidenceDays: 1`, `spanCalendarDays: 1`,
  and `status: not-ready`.
- `bun run v1:dogfood-preflight -- --json` reports `serve.ready: true` and the
  same release counters.

Qualitative read:

- This closes an M10 overclaim path: final release readiness cannot be reached
  from manual one-shot sync evidence alone. Counted workdays now need to show
  the background compiler host was running.

## 2026-06-02 M10 Operational-Evidence Gate Tightening

Verification action:

- Tightened `bun run v1:dogfood-report` so a bare `Operational state:` heading
  no longer counts as measured Dome surface evidence.
- Counted workdays still accept concrete evidence from
  `bun run v1:dogfood-snapshot` or explicit `bin/dome check`, `today`,
  `query`, or `export-context` command lines. `bin/dome status` remains useful
  operational context, but no longer counts by itself as M10 work-surface
  evidence.
- Added regression coverage proving filled qualitative notes plus an empty
  operational heading remain `not-ready`.

Measured result:

- `bun run v1:dogfood-report -- --json` still reports `completeWorkdays: 1`,
  `serveHostEvidenceDays: 1`, `captureEvidenceDays: 1`,
  `spanCalendarDays: 1`, and `status: not-ready`.

Qualitative read:

- This closes another M10 overclaim path: release readiness now requires actual
  measured Dome surface evidence, not just the presence of a template heading.

## 2026-06-02 M10 Preflight Serve-Readiness Tightening

Verification action:

- Tightened `bun run v1:dogfood-preflight` so top-level collection status now
  requires operational readiness, capture readiness, and running `dome serve`
  host evidence.
- Added regression coverage for an otherwise clean, intake-ready vault with
  `dome serve` off. The preflight now reports `status: not-ready`,
  `operational.ready: true`, `capture.ready: true`, and `serve.ready: false`.

Measured result:

- `bun run v1:dogfood-preflight -- --json` against the work vault still reports
  collection status `ready` because the work-vault serve host is running.

Qualitative read:

- This aligns the preflight with the release report: one-shot `dome sync`
  evidence can be useful supporting context, but an M10 collection session is
  not ready unless the background compiler host is actually running.

## 2026-06-02 M10 Preflight Serve-Branch Tightening

Verification action:

- Tightened `bun run v1:dogfood-preflight` so running host evidence only counts
  for collection readiness when the `dome serve` heartbeat branch matches the
  vault's current branch.
- Added regression coverage with a synthetic live heartbeat on `other-branch`;
  preflight reports `serve.status: running` but `serve.ready: false` and
  top-level `status: not-ready`.

Measured result:

- The live work-vault preflight remains `ready` because `dome serve` is running
  on `main`, matching the work-vault branch.

Qualitative read:

- This prevents an M10 session from accidentally collecting host evidence from
  a stale or wrong-branch foreground host.

## 2026-06-02 M10 Capture-Evidence Gate Tightening

Verification action:

- Tightened `bun run v1:dogfood-report` so negative capture wording like
  "no raw captures processed today" does not count toward the M10
  capture-evidence threshold.
- The report now counts capture evidence from concrete generated/processed
  capture paths or positive processing/generation language, while still
  allowing "no captures today" as a normal qualitative note for a complete
  workday.
- Added regression coverage proving two complete days with negative capture
  wording do not inflate `captureEvidenceDays`, while a day with a generated
  intake path still counts.

Measured result:

- `bun test tests/scripts/v1-dogfood-report.test.ts` passes with 12 tests and
  78 assertions.

Qualitative read:

- This closes another M10 overclaim path: release readiness now needs real
  capture-digestion evidence, not merely a completed capture-digestion rubric
  line that says no capture work happened.

## 2026-06-02 M10 Safety-Confirmation Gate Tightening

Verification action:

- Tightened `bun run v1:dogfood-report` so contradictory safety confirmations
  like "no, but one generated patch overwrote a draft" or "none except I
  manually edited `.dome/state/runs.db`" become release blockers.
- Plain negative confirmations such as `no`, `none`, `not observed`, and
  `not seen` still count when they are not qualified by `but`, `except`,
  `however`, or similar caveats.
- Added regression coverage for contradictory lost-edit and manual-state-edit
  confirmations in the same otherwise complete workday.

Measured result:

- `bun test tests/scripts/v1-dogfood-report.test.ts` passes with 13 tests and
  84 assertions.

Qualitative read:

- This closes a safety overclaim path: M10 release readiness now fails closed
  when a workday note contains a caveated negative confirmation instead of a
  clean "nothing observed" safety statement.

## 2026-06-02 M10 Operational/Serve Evidence Tightening

Verification action:

- Tightened `bun run v1:dogfood-report` so operational evidence is detected
  from positive line-level command evidence instead of broad day-wide substring
  matches.
- Negated command references such as "Did not run `bin/dome status ...`" no
  longer count as measured Dome surface evidence.
- Tightened serve-host evidence to positive line-level host status. Caveated
  lines such as "Serve host: running; but it was stale and on the wrong
  branch" no longer count as M10 host evidence.
- Added regression coverage for both overclaim paths, plus the actual
  ledger-compatible verified-output shape where `dome status` reports
  `serve_status: running`.

Measured result:

- `bun test tests/scripts/v1-dogfood-report.test.ts` passes with 16 tests and
  102 assertions.

Qualitative read:

- This closes another release-soak evidence gap: M10 counted days now need
  affirmative measured command and foreground-host evidence, not negated or
  contradictory prose that happens to contain the same command/status words.

## 2026-06-02 M10 Preflight Actionability Tightening

Verification action:

- Updated `bun run v1:dogfood-preflight` to pass through actionable
  `dome status` next actions when operational readiness fails.
- Added regression coverage for an untracked draft file: preflight reports the
  dirty working-tree finding and includes `git status --short` as the next
  action rather than only saying to clear generic operational findings.
- Updated `docs/v1.md` to describe preflight readiness as conditional on a
  clean work tree, since operational drift can make the collection session
  temporarily not-ready even when serve and capture readiness are healthy.

Measured result:

- `bun test tests/scripts/v1-dogfood-preflight.test.ts` passes with 6 tests and
  74 assertions.
- During implementation, live work-vault preflight correctly reported
  `not-ready` while two untracked markdown files were present and surfaced
  `git status --short` as the next action.
- After the transient work-tree drift cleared, live work-vault preflight
  returned to `ready` with serve readiness and capture readiness true.

Qualitative read:

- This makes M10 session setup more operator-useful: when dogfood collection is
  blocked by ordinary working-tree drift, preflight now names the same concrete
  remediation path that `dome status` already knows.

## 2026-06-02 M10 Same-Day Safety Aggregation Tightening

Verification action:

- Tightened `bun run v1:dogfood-report` so repeated same-day safety answers
  aggregate conservatively instead of using last-answer-wins semantics.
- If any same-day section reports lost or overwritten human markdown edits, or
  manual `.dome/state` edits, that safety item remains a release blocker even
  when a later same-day entry says `no`.
- Added regression coverage with two same-date ledger sections: the morning
  section reports an overwritten draft, and the evening section says no
  overwrite; the report still keeps `lost_or_overwritten_edits` as the blocker.

Measured result:

- `bun test tests/scripts/v1-dogfood-report.test.ts` passes with 17 tests and
  110 assertions.

Qualitative read:

- This closes a same-day ledger merge overclaim path. M10 release readiness now
  preserves any observed safety issue for that workday instead of allowing a
  later clean note to erase it.

## 2026-06-02 M10 Raw Capture Evidence Tightening

Verification action:

- Tightened `bun run v1:dogfood-report` so bare or negated `inbox/raw/...`
  paths do not count as capture-digestion evidence by themselves.
- Processed archive paths, generated intake paths, and explicit positive
  processing/generation prose still count. Positive prose can mention the raw
  capture path when it clearly says Dome processed, digested, generated,
  archived, or extracted the capture.
- Added regression coverage with five complete workdays: a bare raw path, a
  negated raw-path note, positive processing prose with a raw path, a generated
  intake path, and a processed archive path.

Measured result:

- `bun test tests/scripts/v1-dogfood-report.test.ts` passes with 18 tests and
  115 assertions.

Qualitative read:

- This closes another capture-evidence overclaim path. M10 release readiness
  now distinguishes pending raw source material from completed capture
  digestion, which keeps the release-soak gate aligned with the loop's desired
  state.

## 2026-06-02 M10 Qualitative Placeholder Tightening

Verification action:

- Tightened `bun run v1:dogfood-report` so obvious placeholder rubric answers
  such as `TODO`, `TBD`, `N/A`, `?`, `not filled yet`, and
  `fill after session` do not count as filled qualitative notes.
- Kept meaningful qualitative negatives valid: entries like "No captures
  today" or "No owner-needed questions appeared" still count as filled
  dimensions while staying separate from capture-evidence credit.
- Added regression coverage with one placeholder-filled day and one meaningful
  no-capture day.

Measured result:

- `bun test tests/scripts/v1-dogfood-report.test.ts` passes with 19 tests and
  126 assertions.

Qualitative read:

- This closes another release-soak evidence gap. M10 counted workdays now need
  actual qualitative observations, not template placeholders that merely make
  each rubric line non-empty.

## 2026-06-02 M10 Elapsed-Date Tightening

Verification action:

- Tightened `bun run v1:dogfood-report` so future-dated and
  calendar-impossible ledger sections remain visible but do not count as
  elapsed M10 evidence.
- Added `dateStatus` to per-day JSON rows with `valid`, `future`, or `invalid`
  values.
- Added `--today <YYYY-MM-DD>` so tests and audits can pin the last date
  eligible to count, while normal report runs default to the local current date.

Measured result:

- `bun test tests/scripts/v1-dogfood-report.test.ts` passes with 20 tests and
  136 assertions.

Qualitative read:

- This closes another release-soak overclaim path. M10 readiness can no longer
  be inflated by prefilled future sections or typoed calendar dates, which
  keeps the gate tied to real elapsed work-vault use.

## 2026-06-02 M10 Work-Surface Evidence Tightening

Verification action:

- Tightened `bun run v1:dogfood-report` so `bin/dome status` alone no longer
  counts as measured work-surface evidence for a complete M10 day.
- Counted days still accept `bun run v1:dogfood-snapshot` and explicit
  `bin/dome check`, `today`, `query`, or `export-context` command evidence.
- Updated report fixtures so positive complete-day cases include a work
  surface and added a regression proving a status-only day remains partial.

Measured result:

- `bun test tests/scripts/v1-dogfood-report.test.ts` passes with 22 tests and
  150 assertions.
- `bun run v1:check` passes with 1030 tests and 21859 assertions, plus docs
  and work vault smoke checks.
- `bun run v1:dogfood-preflight -- --json` reports `status: ready`; the release
  substatus remains `not-ready` with one complete workday and no release
  blockers.

Qualitative read:

- This closes another M10 overclaim path. Engine health evidence remains
  useful context, but V1 release readiness now requires evidence that Dome's
  actual work surfaces were exercised during the day.

## 2026-06-02 Work-Surface Dogfood Follow-Up

Commands run:

- `bun run v1:dogfood-preflight -- --json`
- `bun run v1:dogfood-report`
- `bun run v1:dogfood-snapshot`

Operational state:

- `bun run v1:dogfood-snapshot` exercised `bin/dome check`, `today`, `query`,
  and `export-context` against `/Users/mark.toda/vaults/work`.
- Work vault was clean on branch `main`, with head/adopted both at `a857181`.
- Serve host: running; branch main; pid 11698; heartbeat updated during the
  session.
- Operational runs: 0 pending, 0 failed, 0 failed outbox, 0 quarantined.
- Attention: no; diagnostics: 46 total / 0 attention; questions: 0.

Qualitative notes to fill after the work session:

- Daily note usefulness: The daily surface remained a useful starting cockpit.
  It showed the active M10 follow-up plus current people/project tasks from
  `notes/2026-06-02.md` without needing manual file hunting.
- Capture digestion: No new work-vault raw capture was processed in this
  follow-up, but the capture loop stayed quiet and model-ready in preflight.
- Open-loop surfacing: Open loops surfaced through both the daily note and the
  context packet. The packet examples were traceable back to
  `notes/2026-06-02.md` and relevant entity/source pages.
- Context packet quality: `export-context "today open loops"` returned a
  concise read-first set with the daily note first, then relevant source,
  entity, and synthesis pages. This was useful enough for foreground-agent
  orientation.
- Question burden: No open questions were present, and no owner-needed question
  blocked sync, status, or surface use.
- Link/concept hygiene: Remaining drift is understood backlog: 42
  `link.resolve-or-create` findings and 4 `frontmatter.repair` findings, all
  informational with 0 attention diagnostics.
- Friction / manual foreground-agent work Dome should own: M10 still depends on
  elapsed real-world evidence collection. The engine and surfaces are behaving
  cleanly; the remaining work is continued dogfood, not a code-path blocker.
- Lost or overwritten human markdown edits: no
- Manual .dome/state edits: no

M10 read:

- This is useful same-day supporting evidence, not a new elapsed workday. The
  release report should remain `not-ready` until the ledger spans the required
  two real work weeks.

## 2026-06-02 M10 Readiness Criteria Surface

Verification action:

- Added a structured `readiness` array to `bun run v1:dogfood-report -- --json`
  with per-criterion `current`, `required`, `remaining`, and `ready` fields for
  complete workdays, serve-host evidence days, capture-evidence days,
  complete-workday calendar span, and release blockers.
- Added a Markdown `Release readiness:` section to the report so humans can see
  the exact remaining criteria without mentally diffing the counters.
- Threaded the same readiness data into `bun run v1:dogfood-preflight`, so
  `nextActions` can say exactly what remains for M10 rather than only giving a
  generic "keep recording notes" action.

Measured result:

- `bun test tests/scripts/v1-dogfood-report.test.ts` passes with 22 tests and
  156 assertions.
- `bun test tests/scripts/v1-dogfood-preflight.test.ts` passes with 6 tests and
  80 assertions.

Qualitative read:

- This makes the release-soak gate more inspectable for both humans and
  foreground agents. The gate still fails closed until elapsed work-vault usage
  reaches the required thresholds, but the missing criteria are now explicit in
  both report and preflight surfaces.

## 2026-06-02 M10 Release-Check Preflight Gate

Verification action:

- Added `--require-ready` to `bun run v1:dogfood-preflight` so it exits
  nonzero unless the current work vault is operationally ready for M10
  collection: clean operational state, same-branch running `dome serve`, and
  ready `dome.intake`/model configuration.
- Updated `bun run v1:release-check` to run current collection preflight before
  the historical dogfood-report readiness check:
  `bun run v1:check && bun run v1:dogfood-preflight -- --require-ready &&
  bun run v1:dogfood-report -- --require-ready`.
- Kept release-soak readiness separate. Preflight `--require-ready` proves the
  current vault can collect evidence; dogfood-report `--require-ready` proves
  the required elapsed M10 evidence exists.

Measured result:

- `bun test tests/scripts/v1-dogfood-preflight.test.ts
  tests/integration/v1-package-scripts.test.ts` passes with 9 tests and 103
  assertions.
- `bunx tsc --noEmit`, `bunx tsc --noEmit -p tsconfig.bundles.json`, and
  `git diff --check` pass.
- `bun run v1:dogfood-preflight -- --require-ready --json` exits 0 against the
  work vault and reports collection `status: ready`, while the release
  substatus remains `not-ready`.
- `bun run v1:dogfood-report -- --require-ready` exits 1 as expected with
  current M10 evidence, listing the missing complete workdays, serve-host days,
  capture-evidence days, and calendar span.

Qualitative read:

- This closes a final-gate blind spot. A future complete M10 ledger will no
  longer be sufficient by itself; the current work vault also has to be ready
  to collect and continue dogfood without manual cleanup.

## 2026-06-02 CLI Surface Consolidation

Verification action:

- Consolidated the primary V1 CLI surface around compiler control,
  attention/decision handling, and adopted-state recall:
  `init`, `serve`, `sync`, `status`, `check`, `resolve`, `query`, and
  `export-context`.
- Hid `today`, `prep`, `agenda`, `inspect`, `doctor`, `lint`, `answer`, `run`,
  and `rebuild` from top-level help while keeping them callable for
  compatibility, debugging, and processor-level tests.
- Stopped using `dome today` as M10 measured work-surface evidence. The
  dogfood snapshot now uses `status`, `check`, `query`, and `export-context`;
  the report counts explicit `check`, `query`, `export-context`, or full
  dogfood snapshots.
- Updated V1, CLI, harness, MCP, processor, matrix, vision, generated AGENTS,
  and dogfood docs to frame daily notes as prepared markdown surfaces and
  `query` / `export-context` as the foreground-agent recall path.

Measured result:

- Focused CLI/orientation/loop/dogfood tests pass with 130 tests and 1174
  assertions.
- `bunx tsc --noEmit`, `bunx tsc --noEmit -p tsconfig.bundles.json`, and
  `git diff --check` pass.
- `bun run v1:smoke` passes against docs and work vaults with `views 2 ok`,
  proving the smoke gate now checks only `query` and `export-context` as
  user-value view surfaces.
- `bun run v1:dogfood-preflight -- --require-ready --json` still reports live
  work-vault collection `status: ready`; `bun run v1:dogfood-report -- --json`
  still reports the release soak as `not-ready` with 1 complete workday, 1
  serve-host evidence day, 1 capture-evidence day, and a 1-day span.

Qualitative read:

- This removes command-surface pressure without deleting useful internal
  processors. The daily loop still prepares the markdown work cockpit; agents
  should ask natural-language `query` / `export-context` questions instead of
  using narrow deterministic planning commands.

## 2026-06-02 M10 Loop Evidence Snapshot Hardening

Verification action:

- Strengthened `bun run v1:dogfood-snapshot` so the maintenance-loop section
  records per-loop diagnostic/question/problem-run counts, processor activation,
  inactive contributors, command/path surfaces, and the loop settlement no-op
  rule.
- Kept the snapshot read-only and on the consolidated surface set:
  `status`, `check`, `query`, and `export-context`.
- Updated the V1 plan evidence to name the stronger loop-state capture as part
  of the M10 dogfood record.

Measured result:

- `bun run v1:dogfood-snapshot -- --vault docs --topic "today open loops"
  --limit 3` renders loop state, processors, surfaces, and no-op rules from
  existing `maintenance_loops` JSON.
- Focused script coverage now asserts the snapshot contains loop diagnostics,
  agent-safe question counts, problem-run counts, processors, surfaces, and
  no-op evidence.

Qualitative read:

- This makes future counted workday entries more useful for release review.
  Instead of just saying a loop was quiet or inactive, the snapshot now leaves
  enough evidence to see which desired-state objective was involved and why it
  should have settled.

## 2026-06-02 M10 Preflight Session Evidence Command

Verification action:

- Added structured `sessionEvidence` to `bun run v1:dogfood-preflight`, with
  the snapshot argv and a shell-ready append command for the configured
  dogfood ledger.
- Rendered the same command in Markdown preflight output under `Session
  evidence`, so a ready work vault gives the operator a concrete end-of-session
  command instead of only abstract remaining-count guidance.

Measured result:

- Live preflight against the work vault renders:
  `bun run v1:dogfood-snapshot -- --vault /Users/mark.toda/vaults/work
  --date 2026-06-02 >> /Users/mark.toda/dev/dome/docs/cohesive/reviews/2026-06-02-v1-work-vault-dogfood-ledger.md`.
- JSON preflight includes `sessionEvidence.snapshotCommand` and
  `sessionEvidence.appendCommand` for foreground agents.

Qualitative read:

- This makes the soak loop easier to run daily. Preflight now answers both
  "can I collect evidence?" and "what exact command should I run when the
  session is done?"

## 2026-06-02 Work-Vault Carry-Forward and Stale-Diagnostic Follow-Up

Verification action:

- Investigated repeated `dome.daily.carry-forward` commits in the work vault.
  The general behavior is expected to be more than once per day when the
  source-backed open-loop set changes, but two earlier commits had incorrectly
  inserted the current June 2 cockpit into historical notes
  `notes/2025-10-03.md` and `notes/2026-05-28.md`.
- Verified the historical daily-note generated blocks had already been removed
  in work-vault commit `b6ff119` and that the latest work-vault sync produced
  no new `dome.daily.carry-forward` patch.
- Fixed a stale wikilink-diagnostic cleanup bug in the SDK. Processors now
  have an explicit manifest `inspection` scope; `dome.markdown.validate-wikilinks`
  declares `all-readable-markdown` so creating or repairing a target page can
  clear broken-link diagnostics anchored in unchanged source files.
- Added a convergence regression proving a broken `[[Fred Zaw]]` link resolves
  when `wiki/entities/fred-zaw.md` is created later.

Measured result:

- Committed the SDK/doc fix as `4e197eb Track processor inspection scope`.
- `bun test` passed with 1049 tests, 0 failures, and 22395 assertions.
- `bunx tsc --noEmit`, `bunx tsc --noEmit -p tsconfig.bundles.json`, and
  `git diff --check` passed.
- `bun run v1:smoke -- --sync-docs` passed with docs adopted at `4e197eb` and
  work adopted at `2a48b9e`.
- `bin/dome sync --vault /Users/mark.toda/vaults/work --json` adopted the
  latest work-vault commit with 0 garden sub-proposals and no closure commit.
- `bin/dome status --vault /Users/mark.toda/vaults/work --json` reported all
  five maintenance loops quiet and settled, 0 open questions, 0 failed runs,
  0 attention diagnostics, and 10 remaining content diagnostics classified as
  noise.
- `bun run v1:dogfood-snapshot -- --date 2026-06-02 --limit 3` confirmed the
  current work-vault snapshot has head/adopted `2a48b9e`, no sync needed, all
  loops quiet, and link-concept coherence at 0 drift diagnostics.

Qualitative read:

- This is a good M10 finding: the dogfood loop caught both confusing
  daily-surface churn and a real stale-check failure mode. The system now
  converges better after source fixes, and the remaining work-vault check
  output is known noise rather than mysterious failure.
- The next M10 blocker is not this code path. It remains elapsed dogfood:
  `dome serve` is currently off, and the release report still has only 1
  complete counted workday, 1 serve-host evidence day, 1 capture-evidence day,
  and a 1-day complete-workday span.

## 2026-06-02 M10 Safety Placeholder Gate Tightening

Verification action:

- Audited the M10 release-soak parser for ways it could mark V1 ready too
  early.
- Found that `N/A` / `NA` safety answers counted as clean confirmations for
  "Lost or overwritten human markdown edits" and "Manual .dome/state edits".
  That contradicted the V1 completion gate: counted workdays must explicitly
  confirm there were no lost edits and no manual `.dome/state` edits.
- Tightened `bun run v1:dogfood-report` so placeholder safety answers are
  treated as missing safety evidence. Only explicit negative confirmations such
  as `no`, `none`, `not observed`, or `not seen` count as clean safety
  confirmations; contradictory answers remain release blockers.

Measured result:

- Added a regression where an otherwise complete workday with `N/A` / `NA`
  safety answers remains `not-ready`, has 0 complete workdays, and reports the
  two safety confirmations as missing rather than clean.
- `bun test tests/scripts/v1-dogfood-report.test.ts` passed with 23 tests and
  165 assertions.
- `bun test tests/scripts/v1-dogfood-report.test.ts
  tests/scripts/v1-dogfood-preflight.test.ts
  tests/scripts/v1-dogfood-snapshot.test.ts
  tests/integration/v1-package-scripts.test.ts` passed with 34 tests and
  313 assertions.
- `bunx tsc --noEmit`, `bunx tsc --noEmit -p tsconfig.bundles.json`, and
  `git diff --check` passed.

Qualitative read:

- This closes a concrete overclaim path in the final release gate. M10 can no
  longer pass on placeholder safety answers; each counted day must explicitly
  confirm the two source-preservation safety checks.

## 2026-06-02 M10 Serve-Host Counter Tightening

Verification action:

- Audited the M10 release-soak report counters after tightening safety
  confirmations.
- Found that `serveHostEvidenceDays` counted any valid dated ledger section
  with a host-evidence line, even when that day was otherwise incomplete.
  This did not let `--require-ready` pass by itself, because complete workdays
  also require host evidence, but it could overstate the host-evidence counter
  in reports and preflight next actions.
- Tightened `bun run v1:dogfood-report` so serve-host evidence contributes to
  release readiness only for complete workdays.

Measured result:

- Added a regression where an incomplete workday with `Serve host: running`
  records per-day `serveHostEvidence: true` but does not increment
  `serveHostEvidenceDays`.
- `bun test tests/scripts/v1-dogfood-report.test.ts` passed with 24 tests and
  176 assertions.

Qualitative read:

- This makes the release-soak counters line up with the rubric: M10 measures
  complete workdays that used Dome with a running compiler host, not isolated
  evidence snippets in partial entries.

## 2026-06-02 M10 Stale-Host Action Routing

Verification action:

- Cleaned up a stale work-vault `dome serve` heartbeat left by a dead host
  process, then used that dogfood finding to audit the operator-facing action
  path.
- Found that `dome status --json` routed `serve_stale` to the generic
  `dome check --json` action, and `bun run v1:dogfood-preflight` double-counted
  the same stale host as a generic operational readiness finding.
- Tightened the CLI surface so `serve_stale` points directly at `dome serve`,
  while preflight reports stale host evidence only under serve-host readiness.

Measured result:

- `bun test tests/scripts/v1-dogfood-preflight.test.ts` passed with 9 tests
  and 128 assertions.
- `bun test tests/cli/commands.test.ts --test-name-pattern
  "stale serve heartbeat|invalid serve heartbeat"` passed with 2 tests and 16
  assertions.
- `bun test tests/scripts/v1-dogfood-preflight.test.ts
  tests/cli/commands.test.ts` passed with 81 tests and 824 assertions.
- `bunx tsc --noEmit`, `bunx tsc --noEmit -p tsconfig.bundles.json`, and
  `git diff --check` passed.
- `bun run v1:smoke -- --sync-docs` passed for the docs and work vaults. The
  work vault was settled at `d839d0f` with 10 informational diagnostics and no
  attention required.
- `bun run v1:dogfood-preflight -- --json` now reports operational readiness
  `true`, capture readiness `true`, serve status `off`, and the expected
  next action to start `dome serve` for real dogfood host evidence.

Qualitative read:

- This keeps the M10 session setup surface cohesive. A stale or stopped
  compiler host is a host-operation problem with one obvious action, not a
  request for a foreground agent to inspect content diagnostics.

## 2026-06-02 V1 Public CLI Help Lock

Verification action:

- Re-audited the CLI surface against the V1 "small CLI, powerful compiler"
  rule after consolidating the day-to-day workflow around `serve`, `sync`,
  `status`, `check`, `resolve`, `query`, and `export-context`.
- Confirmed `bin/dome --help` exposes only the primary V1 commands plus
  `init` and Commander help, while compatibility/debug commands such as
  `today`, `prep`, `agenda`, `run`, `answer`, `lint`, `doctor`, `inspect`, and
  `rebuild` remain hidden.
- Added a process-boundary regression so the public help surface cannot drift
  back into command sprawl accidentally.

Measured result:

- `bun test tests/cli/bin.test.ts` passed with 3 tests and 38 assertions.

Qualitative read:

- This does not remove the compatibility views or developer/debug surfaces. It
  pins the user-facing workflow to the consolidated V1 command model, which
  keeps foreground agents pointed at context packets, query, status, check, and
  prepared markdown surfaces instead of narrow deterministic one-off views.

## 2026-06-02 M10 Measured Host-Evidence Tightening

Verification action:

- Re-audited the M10 report host-evidence parser after confirming the real
  dogfood snapshot emits measured heartbeat details.
- Found remaining overclaim paths: a hand-written bare `Serve host: running`
  line counted as serve-host evidence, and branch/PID-only host notes still did
  not prove the heartbeat had been refreshed during the session.
- Tightened `bun run v1:dogfood-report` so host evidence requires both a
  running host signal and measured branch, PID, and heartbeat-updated details
  on the evidence line.
  This matches the `v1:dogfood-snapshot` output and `dome status --json`
  fields while still accepting verified backticked status snippets such as
  `serve_status: running`, `serve_pid: 123`, `serve_branch: main`, and
  `serve_updated_at: 2026-06-01T12:00:00.000Z`.

Measured result:

- Added a regression where an otherwise complete day with running/branch/PID
  host details but no heartbeat-updated evidence remains partial with 0
  serve-host evidence days.
- `bun test tests/scripts/v1-dogfood-report.test.ts` passed with 25 tests and
  183 assertions.
- `bun run v1:dogfood-report -- --json` still reports the current work-vault
  ledger as `not-ready` with 1 complete workday, 1 serve-host evidence day, 1
  capture-evidence day, a 1-day span, and 0 release blockers.

Qualitative read:

- This makes M10 host evidence harder to fake accidentally and keeps the final
  release gate aligned with measured Dome heartbeat output rather than
  free-form optimistic notes.

## 2026-06-02 M10 Serve Hangup Cleanup

Verification action:

- Tried to restore the work-vault `dome serve` host from the Codex shell and
  confirmed this execution environment can reap background child processes
  after the launching shell exits.
- The failed launch left a stale heartbeat, which is useful M10 evidence: host
  cleanup needs to be robust when a foreground terminal/session hangs up.
- Hardened `dome serve` so SIGHUP follows the same graceful shutdown path as
  SIGINT and SIGTERM: abort the poll loop, close the runtime, and clear the
  heartbeat file through the existing token-guarded cleanup path.

Measured result:

- `bun test tests/cli/bin.test.ts` passed with 4 tests and 50 assertions,
  including process-boundary coverage for SIGTERM and SIGHUP heartbeat cleanup.
- `bun test` passed with 1055 tests and 22467 assertions.
- `bunx tsc --noEmit`, `bunx tsc --noEmit -p tsconfig.bundles.json`, and
  `git diff --check` passed.
- `bun run v1:dogfood-preflight -- --json` reports the work vault as
  operationally clean and capture-ready, with expected `serve_status: off` and
  M10 elapsed-evidence next actions.
- `bun run v1:smoke -- --sync-docs` passed for docs and work. Docs settlement
  was skipped because this slice still had uncommitted doc edits; the work
  vault settlement check passed with 10 informational diagnostics and no
  attention required.

Qualitative read:

- This does not close M10 and does not make this Codex shell a suitable
  long-running dogfood host. It closes a host-evidence reliability gap so
  normal terminal hangups are less likely to leave stale serve state behind.

## 2026-06-02 V1 Release-Check Runner

Verification action:

- Re-audited the final V1 release gate. The package script was a shell `&&`
  chain, which meant an implementation, preflight, or dogfood-report failure
  hid any later gate results.
- Added `scripts/v1-release-check.ts` as the single release-check runner. It
  still runs the same three gates: `bun run v1:check`,
  `bun run v1:dogfood-preflight -- --require-ready`, and
  `bun run v1:dogfood-report -- --require-ready`.
- The runner records each gate result and exits nonzero if any gate fails, so
  the final command preserves the V1 release bias while making failures more
  diagnosable.

Measured result:

- `bun test tests/scripts/v1-release-check.test.ts
  tests/integration/v1-package-scripts.test.ts` passed with 4 tests and 22
  assertions.
- `bun scripts/v1-release-check.ts --dry-run` prints all three final gates.
- `bun scripts/v1-release-check.ts --dry-run --json` reports stable gate ids:
  `implementation`, `collection-readiness`, and `release-soak`.
- `bun test` passed with 1058 tests and 22484 assertions.
- `bunx tsc --noEmit`, `bunx tsc --noEmit -p tsconfig.bundles.json`, and
  `git diff --check` passed.

Qualitative read:

- This does not change the M10 standard or add another Dome CLI command. It
  makes the existing final package-script gate a better release-audit surface:
  one command can now show whether the remaining problem is implementation,
  current dogfood setup, elapsed M10 evidence, or more than one of those.
