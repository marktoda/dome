---
type: matrix
created: 2026-05-27
updated: 2026-07-11
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
description: Maps user intents (capture, maintain, recall, schedule) to the handling processor, its phase, prompt source, and effects emitted.
---

# Intent × prompt × processor matrix

Maps user-level intents (what the user wants to do) to the garden-phase or
view-phase processor that handles them, the prompt the processor uses (when
LLM-driven), and the effects the processor emits. Rows marked `shipped` are
implemented in first-party manifests and covered by harness scenarios. Rows
marked `planned` are product-pressure references, not shipped assets.

This matrix replaces v0.5's `intent-prompt-tools` matrix. The shape generalized: workflows-with-prompts dissolved into processors with `model.invoke` capability; tools dissolved into effect emissions. The intent → handler mapping stays useful as the user-facing catalogue.

## Capture intents

| Intent | Status | Processor | Phase | Prompt source | Effects emitted |
|---|---|---|---|---|---|
| "Quick-capture a thought" | shipped | `dome.agent.ingest`, `dome.agent.inbox-stale-check` | garden | model-driven agent loop in `assets/extensions/dome.agent/processors/ingest.ts` (charter + tool bindings); none for deterministic staleness | PatchEffect (agent-authored wiki/notes edits integrating the capture), PatchEffect (archive inbox raw → processed), QuestionEffect for owner clarifications during ingest, DiagnosticEffect for stale inbox files; the ingest loop reads, writes, and archives captures without `graph.write`, so durable facts come downstream via `dome.daily.task-index`; richer long-horizon synthesis remains planned |
| "Voice-capture a meeting" | planned | `dome.agent.ingest` (with voice frontmatter type) | garden | same | same |
| "Drop a research clip" | planned | `dome.agent.ingest` (with research frontmatter type) | garden | same | same |
| "Add a follow-up to a daily" | planned | `dome.daily.append-followup` | garden | `assets/extensions/dome.daily/processors/append-followup.prompt.md` | PatchEffect (insert into daily's followups section) |

## Maintenance intents

| Intent | Status | Processor | Phase | Prompt source | Effects emitted |
|---|---|---|---|---|---|
| "Cross-reference new entity mentions" | planned | `dome.links.cross-reference` | garden | none (rule-based, no LLM) | PatchEffect (insert wikilinks) |
| "Update the index" | shipped | `dome.markdown.render-index` | garden (cron `15 5 * * *` + wiki create/delete signals) | none (deterministic render from `description:` frontmatter) | PatchEffect (rewrite the `dome.markdown:index-catalog` block in `index.md` + category shards), info DiagnosticEffect on marker anomalies |
| "What did Dome do?" | shipped | `dome log` (CLI-native — no processor; git history joined with the run ledger) | — | none | none (read-only; `log.md` is frozen per NO_ACCRETING_REGISTRIES) |
| "Index explicit wiki-page tasks/followups" | shipped | `dome.daily.task-index`, `dome.daily.ambiguous-followup-answer` | adoption + garden answer | none | FactEffect (`dome.daily.open_task`, `dome.daily.followup`), QuestionEffect for ambiguous prose follow-ups, answer-triggered PatchEffect to write accepted prose follow-ups back into markdown |
| "Show today's action surface" | hidden compatibility | `dome.daily.today` | view (hidden command wrapper / `dome run today`) | none | ViewEffect (structured daily note, open tasks, followups, questions) |
| "Review my task backlog" | shipped product read | `dome.daily.task-backlog` | view (`GET /task-backlog` / `dome run task-backlog`) | none | ViewEffect (`dome.daily.task-backlog.list/v1`: exact groups, source context, revision-bound pagination) |
| "Lint the wiki for issues" | shipped | `dome.lint.report` | view (command via `dome lint`) | none (projection diagnostics + deterministic adopted-state checks) | ViewEffect (structured lint report) |
| "Apply a lint finding" | planned | `dome.lint.apply-finding` | view (command) | `assets/extensions/dome.lint/processors/apply-finding.prompt.md` | PatchEffect (the proposed fix) |

## Recall intents

| Intent | Status | Processor | Phase | Prompt source | Effects emitted |
|---|---|---|---|---|---|
| "What did I decide about X" | shipped | `dome.search.query` | view (command via `dome query`) | none (FTS + projection-signal recall; narrative rendering remains planned) | ViewEffect (structured adopted-state matches) |
| "What's on the agenda with [person]" | shipped | `dome.daily.agenda-with` | view (command via `dome today --with <person-or-topic>`) | none | ViewEffect (source-backed agenda markdown + structured payload) |
| "Prep for tomorrow" | shipped | `dome.daily.prep` | view (command via `dome today --prep`) | none | ViewEffect (source-backed prep markdown + structured payload) |
| "Week in review" | planned | `dome.daily.week-review`, future `dome.daily.create-week-review` | view command + garden schedule | `assets/extensions/dome.daily/processors/week-review.prompt.md` | ViewEffect (interactive review markdown); scheduled garden PatchEffect can write a review to `wiki/syntheses/` |
| "Export context for cross-AI handoff" | shipped | `dome.search.export-context` | view (command via `dome export-context <topic>`) | none (FTS + projection-signal recall; narrative rendering remains planned) | ViewEffect (portable context packet) |

## Scheduled intents

| Intent | Status | Processor | Phase | Trigger | Effects emitted |
|---|---|---|---|---|---|
| "Create today's daily note" | shipped | `dome.daily.create-daily` | garden | cron `0 6 * * *` | PatchEffect (create configured daily path, default `wiki/dailies/YYYY-MM-DD.md`, with source-backed Start Here context when yesterday exists) |
| "Raise source-backed open loops into today's daily note" | shipped | `dome.daily.carry-forward` | garden | daily cron plus markdown create/change/delete signals under readable daily/wiki roots | PatchEffect (replace small generated `## Start Here` and `## Open Loops` blocks in the configured daily path) |
| "Create this week's weekly" | planned | `dome.daily.create-weekly` | garden | cron `0 6 * * MON` | PatchEffect (create wiki/weeklies/YYYY-Www.md) |
| "Auto-lint weekly" | planned | future `dome.lint.scheduled-report` | garden (cron) | cron `0 7 * * MON` | DiagnosticEffect or PatchEffect for a durable scheduled lint report |
| "Inbox staleness check" | shipped | `dome.agent.inbox-stale-check` | garden | hourly schedule plus inbox path signals | DiagnosticEffect (`inbox.stale` warning for files older than 168 hours) |

## Why this matrix exists

Three properties:

1. **The catalog is user-readable.** A user wondering "how do I extract follow-ups from a daily" can grep this matrix for `follow-up` and find the processor that handles it.
2. **It's the cross-reference between prompts and processors.** Garden-LLM processors carry prompt files alongside their TypeScript; the matrix names which prompt drives which processor.
3. **Extension bundles add rows.** A third-party `acme.calendar-sync` bundle's processors land here when registered, extending the user-facing intent catalogue.

## Related

- [[wiki/specs/processors]] §"First-party processors"
- [[wiki/matrices/built-in-extensions-x-phase]]
- [[wiki/specs/effects]]
- [[wiki/specs/capabilities]] §"model.invoke"
