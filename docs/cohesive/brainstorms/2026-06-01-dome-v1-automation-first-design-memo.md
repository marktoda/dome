---
type: brainstorm
tags:
  - v1
  - automation
  - product
  - work-vault
  - design-memo
created: 2026-06-01
updated: 2026-06-01
status: draft
sources:
  - "[[v1]]"
  - "[[VISION]]"
  - "[[wiki/concepts/llm-wiki-pattern]]"
  - "[[wiki/syntheses/dome-as-compiler]]"
---

# Dome V1 automation-first design memo

This memo is a reset of the Dome V1 product frame after the engine reached a
relatively stable point. It is meant for design discussion, not as a final
engineering spec.

The short version:

> Dome V1 should be an autonomous background garden for Mark's work vault. It
> should make the vault more useful for foreground agents and for daily work
> without requiring Mark to ask for every maintenance task manually.

This is a narrower and sharper target than "make a generally useful markdown
vault SDK." V1 is not for the market yet. V1 is for one real work vault.

## Context

Dome currently has a serious technical substrate:

- Git-backed markdown as source of truth.
- A fixed-point adoption loop.
- Processor/effect/capability architecture.
- Garden and view phases.
- SQLite-backed projections, run ledger, answers store, and outbox.
- CLI surfaces for `serve`, `sync`, `status`, `check`, `resolve`, `today`,
  `prep`, `agenda`, `query`, and `export-context`.
- First-party bundles for markdown validation, graph facts, search, daily
  notes, health/recovery, lint, and LLM-backed intake.

That system is interesting and semi-useful today, but it is not yet a large
workflow improvement over "open Claude Code in the vault and ask it to manage
things manually."

The next V1 question is therefore not "can the engine run?" It can. The next
question is:

> What should Dome do in the background that a foreground agent could do, but
> that Mark should not have to remember to ask for?

## Core product distinction

The key distinction is foreground agent versus background engine.

### Foreground agent

Examples: Claude Code, Codex, future agentic IDEs or chat tools.

The foreground agent is point-in-time:

- Mark is directly talking to it.
- It answers a question.
- It updates a note.
- It prepares an agenda.
- It edits markdown in response to a specific instruction.
- It has conversational context from the current session.

Foreground agents are excellent at interactive work. They are not a good
substrate for recurring maintenance, because the user has to remember to ask.

### Dome background engine

Dome should be long-running, recurring, and non-point-in-time:

- It maintains the vault between foreground sessions.
- It creates and improves daily notes.
- It raises open loops into the work surface.
- It repairs broken structure.
- It consolidates duplicates.
- It maintains indexes and recall surfaces.
- It compiles raw captures into useful wiki pages.
- It answers low-risk open questions where the vault has enough context.
- It makes the next Claude Code session more effective.

This is the actual value wedge. Dome should make Claude Code, Codex, Obsidian,
and future mobile voice capture better by maintaining the shared markdown
substrate.

### Git is the safety model

Mark is comfortable with Dome making real changes because Git is deeply part of
the system. The product should take advantage of that.

The default should not be "ask the user for approval before anything semantic."
The default should be:

- make coherent commits,
- preserve provenance,
- keep SourceRefs,
- record processor runs,
- make changes inspectable,
- rely on Git rollback when needed.

This means V1 can be more autonomous than a typical consumer notes product.

## Product thesis

Dome V1 is an autonomous garden engine for a work vault.

It should feel less like a compiler that reports failures and more like a
background collaborator that keeps the vault getting better:

- The daily note is ready before Mark starts work.
- Yesterday's unresolved work is raised into today.
- Broken wikilinks become repaired links or intentional stubs.
- Duplicate pages are consolidated or prevented.
- Indexes become more useful for agent recall.
- Raw captures become source-backed notes, tasks, and synthesis.
- Open questions keep accumulating context and are answered when possible.
- Human attention is reserved for questions that genuinely need Mark's context.

## What V1 is for

V1 is for Mark's work vault.

Success is not measured by whether a second user can install it cleanly. Success
is measured by whether Mark's actual work vault becomes meaningfully more
useful than plain markdown plus a foreground agent manually maintaining it.

Good V1 signs:

- Mark opens the daily note and it is already useful.
- Claude Code finds answers faster because Dome maintained indexes and context.
- There are fewer repeated asks like "fix all the check issues."
- Broken links and duplicate stubs trend down without manual cleanup sessions.
- Open loops show up in the daily note without Mark hunting for them.
- Raw captures compile into usable, source-backed vault material.
- Mark rarely has to answer menial questions.

Bad V1 signs:

- Dome mostly tells Mark what is wrong.
- `dome check` becomes the primary product surface.
- Mark has to manually resolve a long queue of obvious questions.
- Daily notes feel like generated artifacts rather than a living work surface.
- The CLI grows a new verb for every maintenance concept.
- The vault is technically cleaner but not easier to work from.

## CLI stance

The CLI is already close to too broad. V1 should avoid adding another top-level
command like `dome tend`.

Preferred model:

- `dome serve`: continuous background compiler and garden engine.
- `dome sync`: one-shot catch-up and drain.
- `dome status`: cheap pulse and routing.
- `dome check`: detailed explanation of what remains.
- `dome resolve`: decision sink.
- `dome today`, `dome prep`, `dome agenda`, `dome query`,
  `dome export-context`: value views.
- `dome inspect`, `dome doctor`, `dome run`, `dome rebuild`, `dome answer`:
  advanced/debug compatibility surface.

New automation should generally become behavior inside `serve` and `sync`, not
new top-level CLI.

The guiding rule:

> Consolidate power into a few verbs. Do not fragment the product into a
> command zoo.

## Daily note stance

The daily note should be the canonical work queue.

This is probably the highest-leverage V1 workflow. Mark already enjoys using
the daily note manually as the place where work converges. Dome should amplify
that pattern.

### Daily note as collaborative markdown

The daily note should not be a rigid generated document. It should be
collaborative markdown:

- Mark can edit it directly.
- Claude Code can edit it in a foreground session.
- Dome can update it in the background.
- Obsidian can browse and edit it.

This argues against heavy Dome-owned managed sections as the default. Managed
regions are useful for deterministic processors, but too many of them make the
daily note feel like an internal data structure.

Instead, use light conventions:

```md
# 2026-06-01

## Start Here

## Open Loops

## Meetings

## Notes

## Decisions

## Done

## Story of the Day
```

These headings are conventions, not hard ownership boundaries. Dome can append,
rewrite, or reorganize where useful. Claude Code can also update the same
sections. The safety model is Git plus adoption, not strict section ownership.

### More LLM-oriented than regex-oriented

The daily note should lean LLM-oriented.

Deterministic processors are still useful for indexing explicit checkboxes,
`TODO:` lines, and follow-up syntax. But the product should not depend on a
large pile of brittle section rewriting rules.

Target behavior:

- Morning: Dome prepares or refreshes today's daily from yesterday, recent
  open loops, and active work.
- During the day: Mark and the foreground agent edit naturally.
- Background: Dome periodically raises todos and follow-ups into the daily.
- Evening or next morning: Dome summarizes what changed, what got done, and
  what remains.
- Adoption: deterministic processors index tasks, follow-ups, decisions, and
  links from whatever markdown exists.

This should feel like a useful work document, not a generated report.

### Daily note questions

Open design questions:

1. How much should Dome rewrite versus append?
2. Should daily updates happen only in morning/evening windows, or opportunistic
   throughout the day?
3. What should happen if Claude Code and Dome both update the same section?
4. Should unchecked tasks be copied forward, moved forward, or raised with
   source links while originals remain?
5. Should the daily note have stable task IDs, or can Git/source refs carry
   enough identity for V1?

Current leaning:

- Prefer collaborative markdown over strict managed regions.
- Prefer source-linked raised work over destructive moves.
- Use Git history and SourceRefs before introducing visible task IDs.
- Let the first work-vault soak teach how aggressive rewriting should be.

## Questions and resolution

The current system has `QuestionEffect`, `dome answer`, and `dome resolve`.

The design reset changes the product meaning:

- `answer` is the low-level/debug compatibility alias.
- `resolve` is the product verb.
- Most open questions are not necessarily for Mark.
- Questions should not block sync unless they represent true adoption safety
  issues.
- Agents and background processors can answer questions when they have enough
  context.

### Avoid fake precision

A rigid taxonomy like `low_risk`, `medium_risk`, `high_risk`,
`agent_safe`, `owner_required` may be too artificial. Real questions are gray.

Better V1 shape:

```ts
type DomeQuestion = {
  question: string;
  sourceRefs: SourceRef[];
  recommendation?: string;
  rationale?: string;
  confidence?: number;
  suggestedResolver?: "agent" | "owner" | "either";
};
```

Even `suggestedResolver` may be optional. The agent can inspect the question,
look at the vault context, and decide whether it can answer or needs Mark.

The important property is not perfect classification. The important property is
that questions are contextual, non-blocking, and answerable through one durable
sink.

### Open questions as backlog, not blockers

Open questions should be an uncertainty backlog. Dome should keep going.

Desired behavior:

- A processor emits a question.
- Sync still completes.
- Other garden work continues.
- A background model or foreground agent can answer later.
- If the answer unlocks a patch, the answer handler emits effects through the
  normal engine path.
- Mark only sees questions that agents cannot responsibly answer.

This is different from a compiler error. It is more like a soft TODO for the
garden.

## Broken wikilinks

Broken wikilinks should usually not block adoption.

Markdown is flexible. Obsidian users often create links before pages exist.
Broken links are signals, not necessarily errors.

Desired repair ladder:

1. Deterministic resolver checks exact path/title/slug cases.
2. If there is an obvious rename or title mismatch, auto-fix.
3. If the link probably refers to an existing page, patch the link.
4. If the link probably represents a real new concept/person/project, create a
   stub page.
5. Before stub creation, run duplicate search to avoid duplicate stubs.
6. If ambiguous, let a background model or foreground agent decide.
7. Only ask Mark when the link meaning depends on outside context.

The hard product problem is duplicate prevention. Creating stubs too eagerly
can make the vault worse. Stub creation should be paired with duplicate search
and alias detection from the beginning.

## Duplicate consolidation

Duplicate consolidation is a major part of the semantic garden.

The goal is not just "detect duplicate pages." The goal is to prevent the vault
from accumulating parallel representations of the same work, person, project,
or concept.

Possible workflow:

1. Detect duplicate candidates:
   - same or similar title,
   - overlapping aliases,
   - similar backlinks,
   - similar body embeddings or summaries,
   - broken wikilink target matching an existing concept.
2. Decide canonical page.
3. Merge non-conflicting content.
4. Preserve unique source-backed detail.
5. Add aliases or redirect notes.
6. Update incoming links.
7. Commit as a coherent garden change.

Given Mark's comfort with Git, exact-safe cases can probably auto-merge. Messy
semantic duplicates can still be committed if source-backed and coherent, but
the first implementation may want to start with proposals or conservative
patches until trust is earned.

## Index and search stance

Indexes are not primarily for pretty human browsing. They are for making
foreground agents faster and more accurate.

Useful index types:

- Hierarchical index: what areas exist in the vault.
- Time-based index: what happened recently and when.
- Project/person index: where live context lives.
- Daily index: what days matter for a topic.
- Context packet: what a foreground agent should read before answering.

Search should start with:

- FTS,
- graph facts,
- recency,
- page type,
- task/follow-up signals,
- daily relevance,
- source-backed snippets.

Embeddings are optional. They may become valuable, but V1 should not assume
embeddings are required until the work vault proves FTS plus graph/recency is
insufficient.

## Temporal memory

Temporal memory is real but not a V1 pillar.

The current vault already has some temporal substrate:

- Git history.
- Daily notes.
- Run ledger.
- Dates in frontmatter.
- SourceRefs.
- Capture timestamps.

Explicit person/project/decision timelines are probably less important than:

- making daily notes useful,
- making search better,
- maintaining indexes,
- preventing duplicates,
- repairing links,
- raising open loops.

Temporal recall can emerge from better daily summaries and better search. Do
not make "timeline system" a V1 feature unless dogfood clearly shows it is
blocking.

## Intake stance

The intake compiler is one of the clearest ways Dome differs from plain
markdown.

Target behavior:

- Raw captures stay immutable.
- Dome compiles captures into generated pages, tasks, decisions, entities, and
  follow-ups.
- Low-confidence extractions become contextual questions, not blockers.
- Agent/background resolution handles obvious cases.
- Extracted todos and follow-ups flow into the daily work cockpit.
- Processed archives are easy to inspect.

Typed capture fronts are likely useful:

- quick note,
- meeting note,
- research clip,
- decision note,
- voice capture later.

This points toward a future mobile voice surface without requiring the mobile
app for V1.

## Background model processors

V1 should include model-backed garden processors, but they should be bounded
and purposeful.

Good candidates:

- daily refresh,
- intake extraction,
- wikilink repair decisions,
- duplicate consolidation,
- index simplification,
- entity/project context refresh,
- open question resolution.

Bad candidates:

- a single huge "do everything" model run,
- unrestricted rewrites across the vault,
- model calls in adoption,
- high-frequency save-triggered model calls with no cost guard.

Potential pattern:

- deterministic processors create facts and candidate diagnostics,
- model-backed garden processors consume those facts,
- model processors emit source-backed patches or answers,
- adoption applies the resulting patches,
- Git records the outcome.

## Background agent versus foreground agent

There is a critical product distinction between a background model processor
and the foreground Claude Code session.

Foreground Claude Code:

- conversational,
- user-directed,
- sees current chat context,
- does point-in-time edits and queries.

Background Dome model processor:

- recurring,
- bounded by trigger and capability,
- uses source refs,
- has no conversational dependency,
- should leave a clear commit and run record.

Dome should not route work to Claude Code as if Claude Code were a worker queue.
That would make Dome dependent on the foreground tool. Instead, Dome should use
its own garden processors for recurring maintenance.

The foreground agent still benefits because the vault is better when it arrives.

## Feature suite for V1

### 1. Daily cockpit

Goal: the daily note is ready, useful, and canonical.

Capabilities:

- create today's daily before work starts,
- summarize yesterday into today's start context,
- raise open todos/follow-ups,
- keep a useful open-loops section,
- let Mark and Claude edit naturally,
- summarize done/decisions at the end of day or next morning.

### 2. Intake compiler

Goal: raw updates become useful vault material without manual processing.

Capabilities:

- process raw markdown captures,
- extract tasks/follow-ups/decisions/entities,
- write source-backed generated pages,
- route extracted work into the daily note,
- answer low-risk extraction questions when possible.

### 3. Semantic repair garden

Goal: flexible markdown stays flexible, but the vault improves over time.

Capabilities:

- repair obvious wikilinks,
- create stubs only after duplicate search,
- consolidate duplicates,
- maintain aliases,
- update incoming links,
- downgrade intentionally loose links.

### 4. Agent-optimized recall

Goal: foreground agents find the right context fast.

Capabilities:

- improve query ranking,
- maintain hierarchical/time/person/project indexes,
- improve `export-context`,
- include open loops and recent decisions in context packets.

### 5. Open question backlog

Goal: questions do not block normal work.

Capabilities:

- preserve questions with source context,
- let agents answer when they have enough context,
- route only genuinely owner-dependent questions to Mark,
- apply answer-handler effects through adoption.

### 6. Extension hardening

Goal: the system remains coherent as more garden behavior lands.

Capabilities:

- clearer bundle authoring,
- missing bundle errors,
- dependency/degradation metadata,
- exact grant-scope tests,
- less metadata duplication.

## What not to do in V1

- Do not add a `dome tend` command.
- Do not create a command per maintenance feature.
- Do not make temporal memory a first-class feature pillar yet.
- Do not require a perfectly clean vault before value appears.
- Do not make every broken wikilink a failure.
- Do not overfit the daily note into a rigid generated document.
- Do not route background work to foreground Claude Code as the core design.
- Do not build native mobile before the background engine proves daily value.
- Do not build a public plugin ecosystem before Mark's work vault works.

## Implementation sequence

This is a suggested sequence, not a final plan.

### Phase 1 - Update the V1 product substrate

- Make the automation-first `docs/v1.md` the plan of record.
- Remove old V1 planning docs.
- Align specs with "open questions are backlog, not blockers."
- Align docs against no command sprawl.

### Phase 2 - Daily cockpit experiment

- Redesign the daily template.
- Add LLM-backed daily refresh as a garden processor.
- Start with non-destructive edits or conservative rewrites.
- Raise source-backed open loops into today's daily.
- Dogfood in the work vault for a week.

### Phase 3 - Open question handling

- Enrich questions with recommendation/rationale/confidence where available.
- Make `resolve` the primary product verb everywhere.
- Keep questions non-blocking.
- Add an agent/background resolution loop for obvious cases.

### Phase 4 - Wikilink repair and duplicate prevention

- Convert broken wikilinks from failure posture into repair candidates.
- Add duplicate search before stub creation.
- Auto-fix obvious title/path mismatches.
- Add source-backed commits for stub creation and alias updates.

### Phase 5 - Agent-optimized recall

- Improve query ranking.
- Improve context export.
- Add or improve indexes based on actual Claude Code failures in the work
  vault.

### Phase 6 - Consolidation

- Add duplicate consolidation.
- Add entity/project context refresh.
- Add semantic cleanup processors once the smaller repair loops are trusted.

## Design questions for review

1. How much should Dome rewrite a daily note versus append to it?
2. Is the daily note allowed to be substantially LLM-rewritten if Git rollback
   is available?
3. Should open tasks be copied forward, moved forward, or source-linked into
   today's daily?
4. Do visible stable task IDs help or harm the markdown experience?
5. How often should background LLM processors run?
6. What is the threshold for creating a stub page from a broken wikilink?
7. What is the threshold for auto-merging duplicate pages?
8. What should `status` show when there are many garden opportunities but no
   urgent problems?
9. Should background question resolution be a first-party model processor or a
   host-level operational loop inside `serve` / `sync`?
10. What should a foreground agent read first when it starts a session in the
    vault?

## Proposed one-sentence V1 definition

Dome V1 is a background garden engine for Mark's work vault: it keeps the daily
note useful, turns captures into source-backed knowledge, repairs and
consolidates markdown structure, improves recall for foreground agents, and
uses Git provenance rather than constant approval prompts as the safety model.

