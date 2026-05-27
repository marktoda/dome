---
type: matrix
created: 2026-05-27
updated: 2026-05-27
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"]
---

# Intent × prompt × processor matrix

Maps user-level intents (what the user wants to do) to the garden-phase or view-phase processor that handles them, the prompt the processor uses (when LLM-driven), and the effects the processor emits.

This matrix replaces v0.5's `intent-prompt-tools` matrix. The shape generalized: workflows-with-prompts dissolved into processors with `model.invoke` capability; tools dissolved into effect emissions. The intent → handler mapping stays useful as the user-facing catalogue.

## Capture intents

| Intent | Processor | Phase | Prompt source | Effects emitted |
|---|---|---|---|---|
| "Quick-capture a thought" | `dome.intake.extract-capture` | garden | `assets/extensions/dome.intake/processors/extract-capture.prompt.md` | PatchEffect (wiki updates), FactEffect (mentions), PatchEffect (archive raw → processed) |
| "Voice-capture a meeting" | `dome.intake.extract-capture` (with voice frontmatter type) | garden | same | same |
| "Drop a research clip" | `dome.intake.extract-capture` (with research frontmatter type) | garden | same | same |
| "Add a follow-up to a daily" | `dome.daily.append-followup` | garden | `assets/extensions/dome.daily/processors/append-followup.prompt.md` | PatchEffect (insert into daily's followups section) |

## Maintenance intents

| Intent | Processor | Phase | Prompt source | Effects emitted |
|---|---|---|---|---|
| "Cross-reference new entity mentions" | `dome.links.cross-reference` | garden | none (rule-based, no LLM) | PatchEffect (insert wikilinks) |
| "Update the index" | `dome.index.update-index` | adoption | none | PatchEffect (rewrite index.md) |
| "Append run records to log.md" | `dome.log.append-log` | adoption | none | PatchEffect (append log.md row) |
| "Lint the wiki for issues" | `dome.lint.lint-report` | view (cron + command) | `assets/extensions/dome.lint/processors/lint-report.prompt.md` (LLM for narrative findings; rule-based for structural findings) | DiagnosticEffect (per finding), ViewEffect (report markdown) |
| "Apply a lint finding" | `dome.lint.apply-finding` | view (command) | `assets/extensions/dome.lint/processors/apply-finding.prompt.md` | PatchEffect (the proposed fix) |

## Recall intents

| Intent | Processor | Phase | Prompt source | Effects emitted |
|---|---|---|---|---|
| "What did I decide about X" | `dome.search.query` | view (command via `dome query`) | none (FTS + LLM-driven narrative rendering) | ViewEffect (markdown response with SourceRefs) |
| "What's on the agenda with [person]" | `dome.daily.agenda-with` | view (command) | `assets/extensions/dome.daily/processors/agenda-with.prompt.md` | ViewEffect (agenda markdown) |
| "Prep for tomorrow" | `dome.daily.prep` | view (command, often invoked manually) | `assets/extensions/dome.daily/processors/prep.prompt.md` | ViewEffect (prep markdown) |
| "Week in review" | `dome.daily.week-review` | view (cron + command) | `assets/extensions/dome.daily/processors/week-review.prompt.md` | ViewEffect (review markdown), optionally PatchEffect (write the review to wiki/syntheses/) |
| "Export context for cross-AI handoff" | `dome.search.export-context` | view (command via `dome export-context <topic>`) | `assets/extensions/dome.search/processors/export-context.prompt.md` | ViewEffect (portable context packet) |

## Scheduled intents

| Intent | Processor | Phase | Trigger | Effects emitted |
|---|---|---|---|---|
| "Create today's daily note" | `dome.daily.create-daily` | garden | cron `0 6 * * *` | PatchEffect (create wiki/dailies/YYYY-MM-DD.md from template) |
| "Carry forward unfinished tasks" | `dome.daily.carry-forward` | garden | signal `file.created` on `wiki/dailies/*` | PatchEffect (copy unfinished tasks from prior daily) |
| "Create this week's weekly" | `dome.daily.create-weekly` | garden | cron `0 6 * * MON` | PatchEffect (create wiki/weeklies/YYYY-Www.md) |
| "Auto-lint weekly" | `dome.lint.lint-report` | view (cron) | cron `0 7 * * MON` | ViewEffect (lint report written to inbox/review/) |
| "Inbox staleness check" | `dome.intake.inbox-stale-check` | adoption | per-sync | DiagnosticEffect (warning for files older than threshold) |

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
