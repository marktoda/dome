# Brainstorm — Dome hooks v1 roadmap (dogfood-first feature set)

> **Status:** Captured product intent. Architecture deliberately light — the v0.5-to-v1-tightening refactor (`docs/cohesive/delta-ledgers/2026-05-26-dome-v0.5-to-v1-tightening.md`) will reshape the extensibility layer, so concrete hook shapes are deferred. Revisit once that refactor lands.
>
> **Audience priority:** Mark as dogfood user → curated first-party hooks for general Dome users → third-party plugin ecosystem (deferred post-v1).

## Current scope

Build hook-based features that productize Mark's actual daily workflow as a manager. Use Mark as the pressure test — what works for him becomes the curated first-party template set. Plugin ecosystem comes later.

**Mark's working pattern (observed in `~/vaults/work`):**
- Daily notes in `notes/<YYYY-MM-DD>.md` with frontmatter + structured sections (`# Notes`, `## Today's meetings`, `# What did I get done today?`, `# Story of the day`).
- Tasks in **Obsidian Tasks plugin syntax** — `- [ ] #task ... ⏫ [[wikilink]]`, completed as `- [x] ... ✅ 2026-05-26`. Priority emojis, completion dates, recurrence markers honored.
- Rich inline wikilinking already by hand — `[[wiki/entities/<person>]]` and `[[wiki/concepts/<thread>]]` peppered through the daily.
- 154 notes; dense `wiki/entities/` (people pages — Danny, Adrian, Christos, Hayden, Allison, Guillaume, etc.).
- Templates exist (`templates/Daily Note.md`, `Meeting Instance.md`) but no `raw/daily/` directory — dailies are kept flat in `notes/`. **Mark's preference:** dailies should live in `wiki/dailies/` as a first-class wiki page type.

**Mark's three core use cases as a manager:**
1. **Periodic mid-day updates** — "I just had a meeting with Danny about X, decided Y" dumped into the daily, which then drives wiki updates.
2. **Memory + recall** — "What did I mean to talk to Danny about this week?" / "What's the plan today?" answered from the vault.
3. **Post-auditing** — "How productive was I last month? What was I focused on?" answered from rolled-up dailies/weeklies.

## Future pressure (not v1 scope)

- Third-party plugin ecosystem (npm-distributable extensions, permissions, manifest).
- Native mobile/desktop surfaces consuming these hooks (per VISION.md v1+).
- Calendar integration, email-to-vault, voice transcription pipeline (separate features).
- Spaced repetition, habit tracking — interesting but not in Mark's actual workflow.

## Non-goals

- Reinventing Obsidian Tasks plugin syntax. Hooks must honor the existing format (priority emojis, ✅ completion dates, recurrence markers).
- Replacing manual authorship of dailies. The hook compiles a daily; it does not write the daily for Mark.
- Owning a separate task/todo store. Tasks live in markdown task lines; any index is a derived wiki page.
- Holding state outside the vault.

---

## The system shape — four layers, not nine features

This was the brainstorm's biggest reframe. Features-as-flat-list dissolved into a layered system once Mark's actual workflow came into focus.

```
Layer 4  Recall (agent workflows, not hooks)
         "What's the plan today?"  •  "What did I mean to talk to Danny about?"
         "What was I focused on last month?"
            ↑ reads from ↑
Layer 3  Aggregation & reflection (clock-tick hooks)
         Weekly rollup  •  Monthly retrospective  •  Stale-thread surface
            ↑ reads from ↑
Layer 2  Compile-on-write — THE KEYSTONE (write hooks)
         [[wiki/entities/X]] mention   → update X's page
         [[wiki/concepts/Y]] mention   → update Y's page
         - [ ] / - [x] ✅              → maintain tasks index + history
         Meeting outcomes              → update meeting/thread pages
         Explicit follow-ups (opt)     → route to inbox/followups
            ↑ writes into ↑
Layer 1  Capture & rhythm (clock-tick + template hooks)
         Daily note from template (with carry-forward of open #task lines)
         Weekly note from template (reads this week's dailies + last week)
```

**Why the keystone is Layer 2.** Once a daily exists and gets edited throughout the day, *all* downstream value (entity CRM, thread rollups, recall, retrospectives) comes from the daily → wiki projection. Person CRM is one column of Layer 2; thread rollups are another. The "drop a paragraph mid-day" UX is just "write into the daily and let Layer 2 propagate."

---

## Layer 1 — Capture & rhythm

**L1.1 Daily note creator.** `clock.tick.daily` fires at start-of-day → creates `wiki/dailies/<YYYY-MM-DD>.md` from template. Template includes `# Notes`, `## Today's meetings`, `# What did I get done today?`, `# Story of the day`, plus `prev`/`next` frontmatter links.

**L1.2 Daily task carry-forward.** On daily creation, reads yesterday's daily, extracts unfinished `- [ ] #task` lines, copies them to today with a footer noting origin (`from [[wiki/dailies/2026-05-25]]`). Open question: copy-with-backref vs. move (delete from yesterday). **Recommend:** copy-with-backref — keeps narrative history intact; task index handles dedup.

**L1.3 Weekly note creator.** `clock.tick.weekly` → creates `wiki/weeklies/<YYYY-W##>.md` from template. Reads all dailies from this week *and last week* for context. Includes carry-forward of unfinished tasks from last week's weekly.

**Open questions for L1:**
- Where do dailies live? `wiki/dailies/` (Mark's preference) vs. `notes/` (current vault layout) vs. `raw/daily/` (current Dome category). **Likely depends on what the refactor does to the page-type system.**
- What does the daily template look like exactly? Stable across weekdays, or per-weekday?
- Backfill semantics: if Dome is offline for 3 days, do missing dailies get created? **Recommend:** no. Backfill is an explicit `dome backfill-daily 2026-05-22..today` command.

---

## Layer 2 — Compile-on-write (the keystone)

Hook fires on `document.written.dailies.*` (whatever the eventual category name is). One umbrella `compile-daily` workflow that runs a deterministic-then-LLM pipeline. Not five independent hooks racing each other (would cause write contention).

**Pipeline:**
1. Diff against prior version.
2. Cheap extractors on the diff:
   - Wikilinks added/removed → touched entities & concepts.
   - Task line changes → task transitions (added, modified, completed, uncompleted).
   - Meeting-section edits → touched meeting threads.
   - Optional follow-up syntax (`> followup: ...`) → inbox routing.
3. Decide LLM scope per touched target:
   - Structural change only (link added) → cheap update (append `mentioned in [[date]]`).
   - Narrative change (paragraph written) → expensive LLM compile.
4. LLM workflows run per touched target, parallel across targets, serialized per target.
5. All writes via `writeDocument`; idempotency via content-addressed update (find-or-update by date heading; never blind-append).

**L2.1 Entity mention propagation (Person/Project CRM).** Every `[[wiki/entities/X]]` mention bumps X's `last_interaction` frontmatter and updates a "Recent context" section on X's page with an LLM-distilled summary of what the daily said.

**L2.2 Concept/thread propagation.** Same shape for `[[wiki/concepts/Y]]`. Concept pages accumulate "Recent positions / decisions."

**L2.3 Task state machine.** Parses Obsidian Tasks plugin syntax exactly. Detects transitions; maintains `wiki/syntheses/tasks-index.md` with cross-vault view (open tasks by status, age, wikilink). Per-task history line: "Created 2026-05-21, worked 05-23 / 05-25, completed 05-26."

**L2.4 Meeting outcome extraction.** Post-meeting notes in `## Today's meetings` → LLM identifies the meeting thread, appends "Held 2026-05-26 — outcomes: ..." to the thread's concept page. Optional: spawn `Meeting Instance` file from template, linked from daily and person pages.

**L2.5 Explicit follow-up routing (optional).** `> followup: ask Danny about audit budget` → `inbox/followups.md` entry, dated and wikilinked. Without this, follow-ups live as task lines (L2.3 handles them).

**Open questions for L2:**
- **When does compile-on-write run?** Async-debounced on every save (recommended), sync-on-save (laggy), manual trigger only (no ambient maintenance), or hybrid (cheap on save, LLM on trigger). Did not land this decision — pending refactor.
- LLM cost discipline: every save → N LLM calls. Need debounce + batching + cheap-then-expensive pipeline pattern. Possibly a built-in helper.

---

## Layer 3 — Aggregation & reflection

**L3.1 Weekly rollup.** `clock.tick.weekly` (Sunday evening) → reads the week's dailies, drafts a review doc with: tasks completed this week, key threads moved, decisions made, person interactions, suggested focus for next week. User edits.

**L3.2 Monthly retrospective.** `clock.tick.monthly` (not in current taxonomy — need to add) → "what was I focused on last month" view. Aggregates weeklies → monthly synthesis.

**L3.3 Stale thread surface.** `clock.tick.weekly` → surfaces concept/entity pages not touched in N weeks where there are open commitments. Flags to the morning agenda.

**Open question:** monthly/quarterly clock ticks. Current `clock.tick.<minutely|hourly|daily|weekly>` doesn't extend to monthly. Either add or compose from weekly with date-arithmetic guards.

---

## Layer 4 — Recall (agent workflows, not hooks)

**L4.1 "What's the plan today?"** Reads today's daily (especially `## Today's meetings`), open tasks from the index, recent dailies for ambient context, and the wiki entities/concepts mentioned in upcoming meetings. Produces a morning agenda.

**L4.2 "What did I mean to talk to X about?"** Searches recent dailies for mentions of X, filters for forward-looking verbs (ask, follow up, talk to, raise). Optionally reads X's entity page for open follow-ups.

**L4.3 "How productive was I last month?"** Reads last month's weeklies + monthly retrospective + tasks index history. Returns themes, completed work, and patterns.

**Note:** These are *recall workflows*, not hooks. They live in the workflow prompt library. They consume what Layers 1-3 produce.

---

## Extensibility-layer pressure-test findings

These are the gaps Mark surfaced that the v1 hook layer must address — independent of architectural details, which depend on the refactor.

### G1 — Scheduled hook registration

`clock.tick.<interval>` events exist but there's no API to register a hook against a *specific wall-clock time* ("fire at 6am"). v1 needs either `schedule: "0 6 * * *"` in declarative YAML or a documented guarantee about when `clock.tick.daily` fires.

**Blocks:** L1.1 daily creator, L1.3 weekly creator, L3.1 weekly rollup, L3.2 monthly retrospective.

### G2 — Custom event taxonomy

Today's taxonomy is closed (events projected from Tool effects). A `task.added` / `task.completed` / `task.transitioned` event would be much cleaner than every hook diffing `document.written.dailies.*` payloads.

**Recommend for v1:** hooks can declare *derived events* the dispatcher synthesizes from diff projections. Or: ship a built-in `tasks-events` projector that emits these.

### G3 — Substrate extension (Mark's specific question)

> *"Can hooks create page types and prompt preambles?"*

**Today: no.** Page types are first-class in `src/page-type.ts`. AGENTS.md is built from `pageTypes` + `workflowNames` (`src/agents-md.ts`). There's already a `PageTypesConfig.extensions` field that anticipates extension types (loaded from `.dome/page-types.yaml`, slated for v0.5.1 per inline TODO), but:

- No way today to register a *new page type* from a hook bundle.
- No way to ship a *preamble fragment* explaining how the new type works alongside the type registration.
- The "user-prose" section of AGENTS.md is preserved verbatim across regeneration — but it's user-edited, not extension-contributed.

**This is the real extensibility gap.** A self-contained "dailies feature" wants to bundle:
1. Page type declaration (`dailies` → `wiki/dailies/`, with frontmatter schema).
2. AGENTS.md preamble fragment (how dailies work, what conventions agents should follow when writing them).
3. Workflows it provides (`create-daily`, `compile-daily`).
4. Hooks it registers (clock.tick.daily handler, document.written.dailies.* handler).

That's a **"hook bundle" or "extension manifest"** — not just a hook. Today's `.dome/hooks/*.yaml` model is too narrow for it. Mark's instinct that hooks may cap out here is correct.

**Recommend for v1:** generalize the YAML hook loader to a YAML *extension* loader. A bundle directory `.dome/extensions/<name>/` with `manifest.yaml`, `page-types.yaml`, `preamble.md`, `workflows/*.md`, `hooks/*.yaml`.

### G4 — Manual hook trigger

No `dome run-hook <id>` exists. For features like the morning agenda or manual "compile this daily now," explicit triggering is required.

**Recommend for v1:** `dome run-hook <id>` and/or `dome compile-daily <date>` as a higher-level command that invokes the relevant hook chain.

### G5 — Idempotency at narrative granularity

"Append paragraph about today's meeting to Danny's page" isn't naturally idempotent — re-firing on reconcile duplicates. Two fixes:
- **Pattern (a) — content-addressed update:** "if section for `2026-05-26` exists on this page, replace it; else append." Correct on reconcile *and* re-edits. **Preferred.**
- **Pattern (b) — declare non-idempotent:** hook fires only live; skip reconcile. Loses backfill on watcher-missed events.

v1 should ship pattern (a) as a documented helper (e.g., `tools.upsertSection(path, sectionKey, content)`).

### G6 — LLM cost discipline

Hook fires on every save → N LLM calls. Need:
- Debouncing (don't fire on every keystroke save; fire after N seconds of quiet).
- Diff-based dispatch (only touch targets whose mentions changed).
- Cheap-then-expensive pipeline (regex extracts first; LLM only for narrative diffs).

v1 should ship a built-in `debounce: 30s` option for declarative hooks and document the cheap-then-expensive pattern with an SDK helper.

### G7 — Read-after-write contention

`p-queue` concurrency=1 already serializes. But Layer 2 produces N writes per daily edit. Need to verify queue doesn't grow unbounded under heavy edit bursts. May want concurrency-per-target rather than global=1.

---

## Decision log (so far)

- **Dailies live in `wiki/dailies/`** as a first-class page type — confirmed by Mark. *(Depends on G3 being solved.)*
- **Honor Obsidian Tasks plugin syntax exactly** — confirmed. No new task syntax invented.
- **Audience priority:** Mark dogfood → curated first-party templates → plugin ecosystem (deferred). Confirmed.
- **Compile-on-write trigger timing:** not landed. Pending refactor + further conversation.
- **Layer 2 is one umbrella workflow with 5 sub-extractors, not 5 independent hooks** — proposed; not yet validated against the refactor.

## What to revisit after the refactor

When `2026-05-26-dome-v0.5-to-v1-tightening` lands, re-open this brainstorm and check:

1. Did the refactor change the **page-type system** in a way that makes `wiki/dailies/` straightforward to add as an extension type?
2. Did the refactor change the **AGENTS.md generation** in a way that supports extension-contributed preamble fragments?
3. Did the refactor change the **declarative hook surface**? Is `schedule:` in scope? Custom events? Bundles?
4. Did the refactor change the **workflow loader** in a way that affects how hooks invoke LLM compilation?
5. What's the new shape of `.dome/` — is there a place for the "extension bundle" concept (G3)?

After answering those, decide:
- Which of L1.1–L4.3 are unblocked by the refactor and ready to spec?
- Which require additional substrate work (custom events, schedule, bundles) before they can ship?
- Should the dailies feature be built as the **first** extension bundle (proving the substrate-extension surface), or as a special-case first-party feature (proving the dogfood path first)?

---

*Brainstorm captured 2026-05-26. Continue conversation in a fresh session post-refactor.*
