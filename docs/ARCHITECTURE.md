Yes — I think your instinct is right. The first build should **not** over-model the world with hard-coded objects like decisions, risks, people profiles, strategy records, and so on.

The Karpathy LLM Wiki pattern is much simpler: there are basically **raw sources**, an **LLM-maintained wiki**, and a **schema/prompt file** that teaches the LLM how to maintain the wiki. The raw sources are immutable; the wiki is generated and updated by the LLM; and the schema is the key configuration layer that evolves over time. Karpathy also emphasizes that the specific directory structure and conventions should depend on the user/domain, not be fixed upfront. ([Gist][1])

So I would frame the MVP as:

> **A prompt-governed compiler from raw personal input into a living markdown wiki.**

Not a knowledge graph product yet. Not a database of decisions. Not a rigid CRM for your brain. Just a disciplined LLM workflow that turns messy input into durable, linked, queryable pages.

---

# Simplified v0 architecture

## The whole system can start with five things

```text
/vault
  /raw
    /voice
    /meetings
    /clips
    /uploads

  /wiki
    index.md
    log.md
    inbox.md
    /pages
      project-atlas.md
      maya-rivera.md
      platform-team.md
      org-design.md
      red-maps.md

  /prompts
    system.md
    ingest.md
    query.md
    lint.md
    research.md

  /state
    page_registry.json
    aliases.json
```

That is enough.

The core product is not the folders. The core product is the **workflow encoded in prompts**.

Karpathy’s version has the same basic separation: raw source files, a generated wiki, and a schema document that tells the LLM how to structure, update, query, and maintain the wiki. He also calls out `index.md` as the content-oriented catalog and `log.md` as the chronological record of ingests, queries, and maintenance. ([Gist][1])

---

# The minimal data model

You only need four durable concepts.

## 1. Raw source

A raw source is anything the user gives the system.

Examples:

- Voice note
- Meeting transcript
- ChatGPT/Claude thread export
- Web clip
- PDF
- Slack thread
- Email
- Manual typed note
- Research memo

Raw sources should be **immutable**. The AI can summarize and reference them, but should not rewrite them.

Example:

```markdown
---
id: raw_2026-05-25_1432_voice
created_at: 2026-05-25T14:32:00-04:00
source_type: voice
status: processed
linked_pages:
  - [[Project Atlas]]
  - [[Platform Team]]
  - [[Org Design]]
---

# Raw transcript

I think the real problem with Project Atlas is not velocity, it's that we're
creating too much coordination overhead between the platform team and the infra
team...

# Extraction summary

## Atomic ideas

- Project Atlas may be creating hidden coordination costs.
- The platform/infra boundary is still ambiguous.
- Velocity metrics may be hiding onboarding or handoff drag.

## Possible page updates

- [[Project Atlas]]
- [[Platform Team]]
- [[Org Design]]

## Open questions

- How much time is being lost to coordination?
- Who owns the handoff boundary?
```

The extraction summary can be stored in the raw file for auditability, but it does **not** need to become a separate database object yet.

## 2. Wiki page

A wiki page is the living synthesis for some topic, person, project, team, concept, or thread.

The important design choice: **all wiki pages use one generic format.**

Do not create separate schemas for person, project, decision, risk, etc. Let those emerge later.

Example:

```markdown
---
title: Project Atlas
aliases:
  - Atlas
  - Atlas migration
tags:
  - project
last_updated: 2026-05-25
sources:
  - raw_2026-05-25_1432_voice
---

# Project Atlas

## Current synthesis

Project Atlas is currently framed as a velocity-improving platform effort, but
recent notes suggest the main risk may be coordination overhead between platform
and infra rather than pure execution speed.

## Important observations

- The platform/infra ownership boundary remains ambiguous.
- Velocity metrics may undercount onboarding and handoff costs.
- There may be a mismatch between perceived progress and actual user-facing impact.

## Open questions

- Who owns the handoff boundary?
- What metric would reveal coordination drag?
- Is Atlas making downstream teams faster or just centralizing complexity?

## Related pages

- [[Platform Team]]
- [[Infra Team]]
- [[Org Design]]
- [[Red Maps]]

## Source trail

- [[raw_2026-05-25_1432_voice]]
```

This structure is enough for people, teams, projects, and ideas. A person page may naturally have sections like “current context” and “recent conversations.” A project page may naturally have “open questions” and “risks.” But the core engine does not need to know that upfront.

## 3. Index

The index is the navigational map.

```markdown
# Index

## Projects

- [[Project Atlas]] — Platform effort with unresolved coordination and ownership questions.
- [[Project Mercury]] — Early-stage infra reliability project.

## People

- [[Maya Rivera]] — Engineering manager connected to Atlas and infra handoff concerns.
- [[Sam Lee]] — Product lead involved in planning process.

## Teams

- [[Platform Team]] — Owns shared tooling and parts of Atlas.
- [[Infra Team]] — Owns lower-level reliability and deployment systems.

## Concepts / Threads

- [[Org Design]] — Ongoing thinking about team boundaries, ownership, and decision latency.
- [[Red Maps]] — Current map of projects/teams that feel blocked, risky, or ambiguous.
```

Karpathy specifically calls out `index.md` as the content-oriented catalog that helps both the user and the LLM navigate the wiki before reading specific pages. ([Gist][1])

## 4. Log

The log is append-only.

```markdown
# Log

## [2026-05-25 14:32] ingest | Voice note about Project Atlas

- Created raw source: [[raw_2026-05-25_1432_voice]]
- Updated: [[Project Atlas]], [[Platform Team]], [[Org Design]]
- Added open question about coordination-cost metrics.

## [2026-05-25 15:10] query | Prep for 1:1 with Maya

- Read: [[Maya Rivera]], [[Project Atlas]], [[Platform Team]]
- Generated prep summary.
```

This gives the agent memory of what it did recently. Karpathy notes that a chronological `log.md` helps track ingests, queries, and lint passes, and can be made parseable with consistent prefixes. ([Gist][1])

---

# The important simplification

## Atomic ideas do not need to be first-class files yet

This is the biggest product/design call.

You could build an explicit atomic-node graph:

```text
idea_001
idea_002
idea_003
```

But I would **not** start there.

Instead, I would make atomic ideas an **intermediate representation** produced during ingest.

The flow should be:

```text
raw input
  → transcript
  → atomic extraction
  → page association
  → wiki updates
  → index/log updates
```

The atomic ideas are useful because they help the model reason clearly. But they do not need to persist as separate objects unless the user explicitly wants that later.

So the “database” is just:

```text
Raw files
Wiki pages
Index
Log
Prompts
```

That is the MVP.

---

# The real data model

The real data model is the prompt contract.

I would make the core prompt say something like this:

```markdown
# Wiki Maintainer Contract

You are maintaining a personal knowledge wiki for the user.

The wiki is a living synthesis layer built from immutable raw sources.
The user does not want a rigid taxonomy. Prefer flexible markdown pages,
clear links, and lightweight conventions over hard-coded object types.

Your job is to:

1. Preserve raw input without rewriting it.
2. Extract atomic ideas, observations, questions, and connections.
3. Decide which existing wiki pages should be updated.
4. Create new pages only when a concept is likely to recur.
5. Keep pages concise, current, and source-grounded.
6. Add links between related pages.
7. Update index.md after every meaningful page change.
8. Append every operation to log.md.
9. Flag ambiguity instead of inventing certainty.
10. Ask for review before writing sensitive or potentially harmful claims.

Do not:

- Create needless pages for one-off thoughts.
- Over-structure the wiki.
- Turn every observation into a decision, task, or project.
- Delete old claims without preserving source trail.
- Treat speculative thoughts as facts.
```

That is much more important than designing a fancy schema.

---

# Core workflow

## 1. Capture

User says something casually:

> “Capture this. I think Atlas is exposing a deeper issue with how platform and infra split ownership. We keep acting like this is a velocity problem, but I think it’s a decision-boundary problem.”

The app creates:

```text
/raw/voice/2026-05-25-1432-atlas-ownership.md
```

No classification required at capture time. Capture should be dumb and fast.

## 2. Normalize

Speech is cleaned into readable form, but the raw transcript is preserved.

Output:

```markdown
# Cleaned transcript

I think Atlas is exposing a deeper issue with how platform and infra split ownership.
We keep acting like this is a velocity problem, but I think it is actually a
decision-boundary problem.
```

## 3. Extract

The LLM pulls out atomic ideas.

```markdown
## Atomic ideas

1. Atlas may be exposing a deeper platform/infra ownership issue.
2. The apparent velocity problem may actually be a decision-boundary problem.
3. The current org split may create ambiguity around who can make calls.
```

## 4. Associate

The LLM reads `index.md` and maybe `page_registry.json`, then decides where this belongs.

```markdown
## Candidate page updates

High confidence:

- [[Project Atlas]]
- [[Platform Team]]
- [[Infra Team]]
- [[Org Design]]

Medium confidence:

- [[Decision Latency]]
- [[Red Maps]]

Create new page?

- No. "Decision-boundary problem" can be added to [[Org Design]] for now.
```

This is how you avoid page explosion.

## 5. Compile

The LLM updates the relevant pages.

For example:

```markdown
## Important observations

- Atlas may not be primarily a velocity problem. A newer hypothesis is that it
  reflects unclear decision boundaries between platform and infra.
```

## 6. Update index and log

The system updates `index.md` if a page summary changed, and appends an entry to `log.md`.

## 7. Optional review

For sensitive notes, especially people/performance-related notes, the system writes to `inbox.md` first instead of directly updating a person page.

```markdown
# Inbox

## Needs review: possible update to [[Maya Rivera]]

Source: [[raw_2026-05-25_1432_voice]]

Proposed update:

- User expressed concern that Maya may be optimizing for team-local velocity over cross-team clarity.

Reason for review:

- This is a sensitive people/performance interpretation.
```

That gives you safety without making the whole system heavyweight.

---

# Minimal file types

I would start with only these.

## Raw file

```markdown
---
id:
created_at:
source_type:
status:
linked_pages: []
sensitivity: normal
---

# Raw input

# Cleaned transcript

# Extraction

# Processing notes
```

## Wiki page

```markdown
---
title:
aliases: []
tags: []
last_updated:
sources: []
---

# Title

## Current synthesis

## Important observations

## Open questions

## Related pages

## Source trail
```

## Index

Human-readable catalog.

## Log

Append-only operational history.

## Inbox

Pending review items.

That is enough.

---

# Optional state files

You may want a couple of machine-friendly files, but they should be derivative, not canonical.

## `page_registry.json`

```json
{
  "project-atlas": {
    "title": "Project Atlas",
    "path": "wiki/pages/project-atlas.md",
    "aliases": ["Atlas", "Atlas migration"],
    "tags": ["project"],
    "last_updated": "2026-05-25"
  }
}
```

## `aliases.json`

```json
{
  "Atlas": "Project Atlas",
  "platform org": "Platform Team",
  "red map": "Red Maps"
}
```

These help the app route content quickly, but the markdown remains the source of truth.

---

# Prompt stack

I would build the product around five prompts.

## 1. System prompt: identity and rules

Purpose: define the agent as a disciplined wiki maintainer.

Core instruction:

```markdown
You are the maintainer of a personal LLM Wiki. You operate on markdown files.
Your goal is to keep the wiki useful, compact, linked, current, and grounded in raw sources.
Prefer simple page updates over new schema.
Prefer synthesis over transcript dumping.
Prefer uncertainty labels over overconfident claims.
```

## 2. Ingest prompt

Purpose: process one raw source.

```markdown
Given a new raw source:

1. Read the raw source.
2. Extract atomic ideas, observations, open questions, and possible links.
3. Read index.md.
4. Identify existing pages that should be updated.
5. Decide whether any new page is needed.
6. Update relevant pages.
7. Update index.md if needed.
8. Append to log.md.
9. Put sensitive or ambiguous updates in inbox.md for review.
```

## 3. Query prompt

Purpose: answer questions using the wiki.

```markdown
When answering a user query:

1. Read index.md first.
2. Identify relevant pages.
3. Read those pages and their source trails if needed.
4. Answer using the wiki, not free-floating memory.
5. Cite pages and raw sources.
6. Offer to file valuable new synthesis back into the wiki.
```

The “file valuable new synthesis back into the wiki” point comes directly from the LLM Wiki idea: queries can produce useful analyses, comparisons, and connections that should not disappear into chat history. ([Gist][1])

## 4. Lint prompt

Purpose: periodically clean the wiki.

```markdown
Review the wiki for:

- Orphan pages
- Duplicate pages
- Missing links
- Stale claims
- Contradictions
- Pages that have become too long
- Important concepts that are mentioned repeatedly but lack a page
- Pages that should be merged
- Sensitive claims that need review
```

Karpathy includes “lint” as a core operation: the LLM periodically checks for contradictions, stale claims, orphan pages, missing cross-references, and gaps. ([Gist][1])

## 5. Research prompt

Purpose: add outside research without polluting personal memory.

```markdown
When researching:

1. Create a research note under /raw/research or /wiki/research.
2. Keep external claims separate from the user's own observations.
3. Summarize key findings with citations.
4. Identify which existing pages should be updated.
5. Propose updates rather than silently rewriting important personal conclusions.
6. Mark external research as external.
```

This keeps the wiki from blending “I think this” with “an article said this.”

---

# The product’s actual MVP behavior

The first version should do five things extremely well.

## 1. Voice note in, wiki update out

The user speaks naturally.

The system:

- Transcribes
- Cleans up
- Extracts ideas
- Links to existing pages
- Updates pages
- Adds source trail
- Updates index/log

## 2. Ask the wiki

The user asks:

> “What are my current thoughts on Atlas?”

The system reads:

- `index.md`
- `project-atlas.md`
- related pages
- source trail if needed

Then answers with a synthesis.

## 3. Prep mode

The user asks:

> “Prep me for my 1:1 with Maya.”

The system reads:

- `maya-rivera.md`
- recent logs
- related project pages
- open questions

Then produces a compact prep note.

This can be built without a “person object.” It is just a wiki page.

## 4. Research mode

The user asks:

> “Research decision latency in platform teams and connect it back to my org design notes.”

The system:

- Creates a research source
- Summarizes findings
- Updates `org-design.md`
- Links to `platform-team.md`
- Logs the operation

## 5. Weekly synthesis

The system creates:

```text
/wiki/reviews/2026-W22.md
```

With:

- Themes from the week
- Open questions
- Pages updated
- Repeated concerns
- Stale threads
- Suggested next investigations

This would make the system feel alive very quickly.

---

# What I would avoid in v0

I would avoid:

- A custom graph database
- Separate “decision” objects
- Separate “risk” objects
- Complex permissions model
- Team collaboration
- Always-on recording
- Automatic task manager
- Fine-grained ontology
- Fancy visual graph as a core feature
- Too many frontmatter fields
- Multiple page templates by default

Those things can come later. The first version should prove that the AI can reliably maintain a useful markdown wiki from messy voice input.

---

# A very simple “compiler” mental model

Think of the system as a compiler.

```text
Raw input = source code
Prompts/schema = compiler rules
Atomic ideas = intermediate representation
Wiki pages = compiled artifact
Index/log = build metadata
Lint = tests
```

This is the most useful framing.

And it matches the Karpathy pattern: Obsidian is the IDE, the LLM is the programmer, and the wiki is the codebase. ([Gist][1])

---

# Product spec v0

## Product name placeholder

**Threadbase**

## One-liner

A voice-first LLM Wiki that turns raw thoughts, conversations, and research into a living markdown knowledge base.

## User promise

> Talk naturally. The system keeps your personal wiki organized.

## Core input

```text
Voice note
Meeting transcript
Pasted text
Web clip
Research result
Uploaded document
```

## Core output

```text
Raw source file
Updated wiki pages
Updated index
Updated log
Optional review item
```

## Core surfaces

### Capture

A simple voice/text input.

Buttons:

- Capture thought
- Capture meeting reflection
- Add research/source
- Ask wiki

### Inbox

Shows proposed updates needing review.

Especially:

- People-sensitive notes
- Ambiguous associations
- Possible contradictions
- Newly proposed pages

### Wiki

Markdown pages with links.

### Ask

Chat over the wiki.

### Review

Weekly or daily synthesis.

---

# Suggested directory structure for your current prototype

```text
memory/
  AGENTS.md

  raw/
    voice/
      2026-05-25-1432-atlas-ownership.md
    meetings/
    research/
    clips/
    uploads/

  wiki/
    index.md
    log.md
    inbox.md

    pages/
      project-atlas.md
      platform-team.md
      org-design.md
      maya-rivera.md
      red-maps.md

    reviews/
      2026-W22.md

  prompts/
    ingest.md
    query.md
    lint.md
    research.md

  state/
    page_registry.json
    aliases.json
```

I would put most of the behavioral logic in `AGENTS.md`.

---

# Example `AGENTS.md`

```markdown
# Personal LLM Wiki Agent

You maintain a personal markdown wiki for the user.

## Core principle

The wiki is a compiled memory layer. Raw sources are immutable. Wiki pages are living synthesis.
The user wants lightweight structure, not a rigid ontology.

## Directory roles

- `/raw`: immutable inputs. Never edit raw transcript text except to append extraction metadata.
- `/wiki/pages`: living synthesized pages. You may create and update these.
- `/wiki/index.md`: catalog of important pages. Keep it current.
- `/wiki/log.md`: append-only history of operations.
- `/wiki/inbox.md`: proposed updates that need review.
- `/wiki/reviews`: periodic summaries.

## Ingest workflow

When processing a new source:

1. Read the source.
2. Create a cleaned summary.
3. Extract atomic ideas, observations, questions, and possible links.
4. Read `/wiki/index.md`.
5. Match the source to existing pages.
6. Create a new page only if the idea is likely to recur.
7. Update relevant pages.
8. Add links between pages.
9. Update `/wiki/index.md`.
10. Append an entry to `/wiki/log.md`.

## Page creation rules

Create a new page when:

- The concept appears repeatedly.
- The user explicitly names it as important.
- It is a person, project, team, or recurring thread.
- Existing pages would become muddy without it.

Do not create a new page when:

- It is a one-off thought.
- It can live as a bullet on an existing page.
- The naming is unclear.
- It is just a transient task.

## Page style

Pages should be concise and synthesis-oriented.

Default sections:

- Current synthesis
- Important observations
- Open questions
- Related pages
- Source trail

You may add sections when useful, but do not over-template.

## Sensitivity rules

People-related judgments, performance concerns, compensation, health, legal issues,
and interpersonal conflict should go to `/wiki/inbox.md` unless the user explicitly
asks you to update the page.

## Query workflow

When answering questions:

1. Read index first.
2. Read relevant pages.
3. Read raw sources only when needed.
4. Answer with citations to pages/sources.
5. Suggest useful wiki updates when the conversation creates new synthesis.

## Maintenance workflow

During lint:

- Find duplicate pages.
- Find orphan pages.
- Find stale claims.
- Find contradictions.
- Suggest merges.
- Suggest missing pages.
- Suggest pages that need review.
```

This is probably the heart of the product.

---

# The v0 ingestion algorithm

In plain English:

```text
For each new raw input:

1. Save raw input.
2. Generate cleaned transcript.
3. Extract atomic ideas.
4. Search/read index.
5. Select target pages.
6. Read target pages.
7. Propose edits.
8. Apply safe edits.
9. Send sensitive edits to inbox.
10. Update index.
11. Append log.
```

In pseudocode:

```python
def ingest(raw_source):
    save_raw(raw_source)

    extraction = llm.extract(
        raw_source,
        prompt="extract atomic ideas, questions, links, candidate pages"
    )

    index = read("wiki/index.md")
    candidate_pages = llm.match_pages(extraction, index)

    pages = read_pages(candidate_pages)

    edits = llm.propose_edits(
        raw_source=raw_source,
        extraction=extraction,
        pages=pages,
        index=index
    )

    safe_edits, review_edits = split_by_sensitivity(edits)

    apply_edits(safe_edits)
    append_to_inbox(review_edits)

    update_index()
    append_log()
```

That is enough for a functional prototype.

---

# The main trade-off

## Lightweight wiki vs structured database

I strongly agree with your bias toward lightweight structure first.

A rigid schema gives you cleaner UI and more deterministic behavior, but it forces the product to guess the ontology too early.

A wiki/prompt-first model gives you:

- Faster iteration
- More personalization
- More natural evolution
- Better compatibility with Obsidian/Markdown
- Less premature product design
- Less risk of building the wrong primitives

The cost is:

- Less deterministic querying
- Messier pages over time
- Harder collaboration later
- More dependence on prompt quality
- Need for periodic linting

That is a good trade for v0.

---

# The thing to obsess over first

Not the graph.

Not the UI.

Not the database.

The thing to obsess over is:

> **Can the agent take a messy spoken thought and update the right 3–7 files in a way that feels obviously useful and trustworthy?**

That is the core magic.

A good benchmark would be:

```text
Input: 3-minute messy voice note

Expected output:
- Raw note saved
- 5–12 atomic ideas extracted
- 2–5 existing pages updated
- 0–1 new pages created
- Index updated only if needed
- Log updated
- Sensitive claims placed in inbox
- User says: “Yes, that is exactly where that should have gone.”
```

If you can make that loop great, everything else can grow from it.

[1]: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f "llm-wiki · GitHub"
