# Dome first-principles product review

**Date:** 2026-07-09
**Validation update:** 2026-07-10, after the first redesign pass
**Scope:** SDK repository, design substrate, tests, shipped extensions and
surfaces, and a read-only audit of the live work vault
**Verdict:** keep the engine; narrow and deepen the product

## Executive summary

Dome has a real, unusually trustworthy engine and an incomplete product.

The engine's strongest ideas are worth preserving: Git-backed markdown as the
source of truth, an adopted semantic cursor, fixed-point compilation, effects
as the only processor output, capability enforcement at one chokepoint,
source refs, and rebuildable projections. The implementation and test suite
show that these are not slogans. They are mechanical properties.

The product problem is elsewhere. Dome currently equates successful
maintenance activity with useful memory. It can prove that processors ran,
effects were authorized, projections are current, and a maintenance-loop
group has no attributed failure. It cannot yet prove that an obvious question
about a person will retrieve the right page, that a later decision obsoletes an
old question, that an oversized page can actually be compacted, or that the
morning surface contains the few things worth acting on.

That is why Dome feels like many useful little things rather than one useful
product. Its implementation model is coherent; its user outcome is not yet the
unit the system closes around.

The recommended product thesis is:

> **Dome turns the evidence you already create into a small, current,
> source-backed working set for whatever you are doing next, and keeps the
> underlying vault coherent over time.**

An even shorter promise is:

> **Your second brain should get smaller and more useful as it grows.**

The next release should prove four end-to-end journeys before adding more
surface area:

1. Start the day from a genuinely prioritized brief.
2. Walk into a meeting with the right people, commitments, decisions, and
   unresolved questions.
3. Debrief a meeting into source evidence, canonical memory updates, and
   reviewable follow-through.
4. Ask or brainstorm in natural language and get a current, grounded answer
   that can be saved back without creating parallel stale prose.

The highest-priority work is therefore not another extension, protocol, or
app panel. It is an outcome evaluation suite, a reliable recall module,
question obsolescence, deterministic memory compaction, and radical reduction
of machine-created noise in attention, Git history, and the run ledger.

## What was reviewed

This was a repository-wide structural and product review, not a claim that
every one of roughly 94,000 production TypeScript lines received equal
line-by-line attention.

The review covered:

- the canonical substrate from `docs/index.md`, including the current V1,
  wedge, memory, daily-surface, client-model, compiler, and extension plans;
- all 355 production TypeScript modules under `src/` and
  `assets/extensions/` through file inventory, import/fan-in analysis,
  exported interfaces, manifests, and implementation tracing;
- line-level reads of the core types, adoption loop, compiler host, processor
  runtime, garden and schedule routing, capability broker, projection and
  ledger stores, public Vault wrapper, surface adapters, query/context
  ranking, daily processors, autonomous agents, HTTP/MCP/assistant paths, and
  page-splitting machinery;
- all shipped manifests: 65 processors across 9 enabled first-party bundles,
  plus 31 CLI commands;
- the test and evaluation shape, including the harness scenarios and the one
  current model-backed golden eval;
- a read-only audit of the live work vault: instructions, configuration,
  history, aggregate content structure, current daily surfaces, status/check,
  proposals, maintenance-loop state, recall probes, and operational stores;
- a current market and agent-memory scan, using primary product sources and
  research papers where possible.

`bun run typecheck` and the full `bun test` suite passed during the review.
That is important evidence: the gaps below are mostly product-contract gaps,
not an unstable engineering baseline.

Private work-vault examples are anonymized here so this document can safely
live in the SDK repository.

## Validation after the first redesign pass

The first implementation pass following this review made the codebase smaller
and conceptually better. It removed roughly 13,400 tracked lines while adding
about 4,100, retired several overlapping maintenance pipelines, and added four
deep seams: lexical query analysis, derived owner attention, derived agent
work, and a replaceable foreground-agent runtime. Typecheck and the full test
suite pass on the resulting working tree.

That work validates the review's direction, but it does not yet close the four
release journeys. The distinction matters:

| Recommendation | Current state | Product judgment |
| --- | --- | --- |
| Fix strict-AND lexical recall | Implemented with shared minimum-match analysis and three work-derived canaries | A real fix to candidate generation; still not the planned memory benchmark, temporal recall, answer synthesis, or deep Recall interface |
| Bound owner attention | Implemented as one derived three-item queue over owner questions and proposals | Correctly removes diagnostics, tasks, and agent work from the decision budget; aging hides requests but does not make semantic obsolescence true |
| Make agent-safe work evidence-backed | Implemented as derived revisioned packets with first-answer-wins completion | A strong trust seam; it resolves decisions, not the larger capture-to-current-memory or task-closure journey |
| Consolidate semantic maintenance | Sweep, patrol, and consolidate became one deterministic gardening compiler plus proposal-only executor | Much more coherent; the hardest large-page operation remains impossible because the model still receives only the first 20,000 characters while lossless split validation requires every original line |
| Make the foreground agent replaceable | Implemented session runtime plus generic installed-view discovery | Good platform architecture; view discovery is mechanism, not a user journey, and the app remains a Today panel plus unconstrained chat |
| Compress Git and audit amplification | Not implemented | Still a public-release blocker |
| Make maintenance settlement outcome-based | The new garden view reports unresolved opportunities, but generic maintenance-loop settlement remains | Partly improved in one domain; the general interface still equates processor health with goal truth |
| Build the outcome benchmark | Seeded with three lexical canaries | Useful regression fence, far short of the 30–50 temporal, multi-source, update, citation, abstention, and writeback cases needed for product claims |

### Live-vault evidence on 2026-07-10

The updated SDK was opened against the same work vault read-only. The current
numbers make the next bottleneck clearer:

- 1,007 markdown files totaling about 7.65 MB;
- 763 open checkbox lines, with 91 files over 20,000 characters and 7 over
  40,000;
- one 91-line current daily containing 17 source-backed open loops, while the
  `prep` view independently reports 290 open tasks, including 273 backlog
  items;
- 1,745 commits in the trailing 30 days, 1,417 of them per-effect
  `engine(applyPatch)` commits (81.2%);
- a 2.0 GB `runs.db` containing 172,853 runs and 8,048,739 capability-use
  rows; graph and search projection writes account for about 7.99 million of
  those rows;
- a point-in-time resident size of roughly 3.4 GB for the work-vault compiler
  process;
- 29 doctor findings: an oversized ledger, missing grants for the new garden
  proposal memory, six grant-starvation cases, eleven duplicate task anchors,
  and recurring timeouts across nine processors;
- a work-vault config that still names retired patrol/sweep artifacts and
  lacks new garden grants, without a first-class upgrade plan.

The lexical fix does recover an obvious person-and-compensation page that the
old candidate seam missed. A generic `focus today` FTS probe, however, still
prefers old pages containing those literal terms. Downstream temporal
injection can force today's daily into the result set, but that is not the
same as answering what deserves attention now.

The daily-note file and the `prep` view also disagree about the effective
working set. This is more than presentation drift. It means Dome has no single
definition of an active commitment: a checkbox that remains open in an old
daily or source page can continue to count as present work even when it was
never carried into today's intentional surface.

### New P0: incremental document compilation

At the live-vault size, performance is now part of product correctness. A
second-brain gardener that times out and consumes gigabytes as the brain grows
contradicts its core promise.

Several processors independently walk and parse the same adopted markdown for
frontmatter, links, claims, tasks, search sections, lint, and gardening. The
next deep module should be a **blob-keyed Document Compiler**:

```text
Git blob OID
  -> one lossless MarkdownDocument parse
  -> reusable per-document artifacts
       { frontmatter, headings/ranges, links, claims, tasks, search sections }
  -> changed-artifact deltas
  -> affected processors and projection updates only
```

The cache is recomputable and never truth. A normal adoption compiles only new
blob OIDs and deletes artifacts for removed paths. A rebuild streams all blobs
through the same compiler. This seam should also provide range reads and exact
range moves, enabling the deterministic large-page split described below.

This is not a fifth core concept or a plugin category. It is the hidden
implementation that lets Proposal/Processor/Effect scale. It should replace
per-processor whole-vault scans, not merely add another cache beside them.

### Clarify the task contract without adding a Task primitive

An unchecked box is syntax, not automatically a current commitment. Dome can
keep tasks as markdown conventions while defining when they enter the working
set:

1. A task has one canonical origin anchor.
2. Current-daily tasks and canonical-page `Open threads` are active sources.
3. A historical-daily task is active only if anchor continuity carries it
   into the current surface; the old line remains evidence, not a second
   backlog row.
4. Source-page checkboxes, templates, and historical captures do not become
   commitments merely because they are unchecked.
5. `deferred`, `waiting`, and `someday` are explicit visibility states derived
   from markdown metadata or section context, not synonyms for “old.”
6. The opening daily surface selects at most three outcome-changing bets;
   inventory remains available behind expansion.

The product invariant should be:

> Every item shown as current work has one canonical origin, a visible reason
> it is current now, and a mechanically observable settlement path.

### Add vault upgrades to the product contract

The work vault demonstrates that bundle evolution and vault configuration are
one deployed system. Replacing processors in the SDK while silently retaining
retired per-processor overrides, file grants, and maintenance artifacts in the
vault leaves a partially upgraded product.

Before public release, `dome doctor` or a dedicated `dome upgrade --plan`
should detect retired processor ids and config keys, propose the exact
source-controlled config migration, preserve explicit user narrowing, and
show which old markdown/state artifacts become inert. Upgrade acceptance
belongs in the same dogfood journey as installation.

## First principles: what a second-brain product must do

A second brain is valuable only when it changes the quality or cost of a real
decision. Storage, links, graphs, summaries, and agents are means.

The irreducible cycle is:

```text
evidence
  -> canonical current memory
  -> a small working set for this moment
  -> answer / decision / action
  -> outcome evidence
  -> canonical current memory
```

Each arrow has a distinct quality bar:

| Transition | Required property | Typical failure |
| --- | --- | --- |
| Evidence -> memory | source-preserving integration | captures pile up or summaries invent facts |
| Memory -> current memory | reconciliation over time | append-only rot, duplicates, contradictions |
| Current memory -> working set | high-recall, low-noise retrieval | obvious pages are missed or context is flooded |
| Working set -> intervention | prioritization and synthesis | a report is technically complete but not useful |
| Intervention -> outcome | reviewable action | extracted tasks remain descriptions of work |
| Outcome -> evidence | closure and temporal update | old questions and commitments remain “open” forever |

Dome has strong machinery around the first arrow and the safety of every
write. It is weakest in the middle three arrows: currentness, retrieval, and
closure.

This suggests a clean separation of mental models:

- **Developer model:** Vault, Proposal, Processor, Effect. Keep it.
- **Operator model:** compiler state, maintenance work, recovery. Keep it out
  of the normal product experience.
- **User model:** tell Dome something, ask Dome something, or review what Dome
  wants to change. Make this the product.

“Compiler” remains an excellent implementation metaphor. It should not be the
primary user promise. Users want a trustworthy companion and a current memory,
not a build system they have to operate.

## What is already excellent

### 1. The trust substrate is real

The adoption and capability path is a deep module. Callers hand it a Proposal
and processor results; it owns convergence, authorization, routing,
provenance, and adopted-ref advancement. Deleting that module would scatter
dangerous knowledge across every extension and surface. It earns its seam.

Source refs, Git history, capability uses, run records, and proposal review
also make a compelling trust story. Dome can usually answer “what changed,
why, and from what source?” better than most AI knowledge products.

### 2. Markdown ownership is a product advantage

The live vault remains usable in Obsidian, Git, shell tools, and foreground
agents. The user is not trapped inside a proprietary chat transcript or
database. This is especially valuable for sensitive management and product
thinking where inspecting and correcting the source matters.

### 3. The engine/client separation is directionally right

The foreground agent is the point-in-time collaborator; Dome is the ambient
memory-maintenance runtime. The engine should not absorb every interactive
routine. The existing `src/surface/` collectors and view-contract work are
good steps toward a protocol-neutral product interface.

### 4. The live vault contains real compounding value

The work vault is not a toy dataset. It contains rich longitudinal people,
project, strategy, meeting, and decision context. Recent synthesis pages show
the intended payoff: several sources are combined into a decision-ready read
that would be difficult to reconstruct from Slack and meeting notes alone.

The product opportunity is to make that quality routine and retrievable, not
to replace it with a more rigid object database.

## Where the product breaks today

### 1. “Loop settled” does not mean the goal is true

Maintenance loops are currently descriptive groups over processors. Their
`settlement.noOpWhen` field is prose. The evaluator applies the same five
generic checks to every loop:

- required processors active;
- no attention diagnostics;
- no drift diagnostics;
- no open questions;
- no recent problem runs.

None of those checks evaluates the loop's named desired condition.

The live context-packet loop reported `quiet` and `settled` while an obvious
natural-language person/context query returned zero entries. The processors
were active and error-free, but the product outcome failed.

This is a false interface. It looks like a domain settlement contract but is
actually a health-group summary. Either call it that, or make settlement
machine-evaluable with loop-specific evidence and canaries.

### 2. Natural-language recall is brittle at the candidate-generation seam

`src/projections/search.ts` converts every whitespace-separated query token
into a quoted FTS term and joins them with implicit AND semantics. The shared
projection-recall matcher similarly requires every normalized term to appear.

As a result, natural questions containing intent words such as “outcome,”
“priorities,” or “open threads” can miss pages that clearly contain the person
and subject. Ranking sophistication cannot recover a page that never became a
candidate.

The live probes showed:

- an obvious promotion-outcome query returned no matches;
- a natural person + compensation + open-threads context packet returned no
  entries;
- a “what should I focus on today?” query found the daily only because of a
  special temporal recall rule, then returned a title-level snippet and large
  amounts of projection detail rather than an answer.

The app assistant inherits this weakness because its charter requires
`search_vault` first and that tool delegates to the same query view.

This is the most important product defect because recall is on the critical
path for morning use, meeting prep, people questions, brainstorming, and the
new app.

### 3. The vault is growing faster than Dome can make it current

The read-only vault inventory found approximately:

- 1,002 markdown files and 7.55 million characters outside operational state;
- 693 wiki pages, 155 loose notes, and more than 18,000 wikilinks;
- 740 open checkboxes across the scanned markdown;
- 88 files over 20,000 characters and 5 over 40,000 characters;
- entity pages at roughly 106k, 68k, and 43k characters;
- 644 generated “Current facts” bullets across 78 pages.

Some generated current-facts blocks occupy 25–43% of the whole page. They
often repeat prose already present below and render every anchored claim as
current even when keys collide or newer evidence changes the interpretation.

This makes the live page less useful while increasing search and model input
noise. “Current facts” needs to be a compact temporal view, not a second copy
of the page's claim history.

### 4. Oversized-page repair is impossible by construction in the hardest case

The patrol correctly flags pages over 600 lines and the consolidator can call
`proposeSplit`. The split validator correctly requires lossless multiset line
accounting.

But `readPage` caps every model read at 20,000 characters, and the consolidator
has no range- or heading-based read tool. A 68k or 106k page cannot be fully
observed by the model, while the validator requires the model to return every
original line across the hub and sub-pages.

The safety check is good; the seam is wrong. A model should choose a
structural split plan over a parsed outline. A deterministic markdown module
should move exact source ranges and build the lossless patch. The model should
not reproduce an entire 100k-character document in tool arguments.

The same 20k limit causes the sweep to refuse integration into large
destinations. Those pages then grow stale precisely because they are large,
creating a self-reinforcing failure mode.

### 5. Question continuity preserves chores, not uncertainty

The daily and prep surfaces currently lead with a backlog of old owner-needed
“close, defer, or keep?” questions. In at least one live case, later vault
evidence recorded the outcome, but the original stale-task question remained
open and still recommended `keep`.

The question lifecycle handles deduplication, durable answers, processor
liveness, and answer dispatch. It does not robustly handle semantic
obsolescence from newer evidence. Yet the V1 contract explicitly says a
question remains alive until answered, **obsoleted**, or dismissed.

Owner attention is the scarcest resource in this product. A question that the
vault can already answer is more damaging than a missing diagnostic because it
teaches the user to ignore the surface.

### 6. The daily surface is a bounded dump, not yet a priority function

The current daily looked clean at first glance, but `today --prep` found 65
open tasks, including 53 backlog items, plus 10 old owner-needed questions.
The first planning slots were dominated by stale-question cleanup rather than
the day's current work.

Twelve generated open loops is better than hundreds, but a fixed row cap is
not prioritization. The surface needs an explicit objective such as:

> Maximize the probability that the owner notices the few commitments,
> decisions, and meetings where their attention changes today's outcome.

That requires urgency, consequence, freshness, calendar relevance, explicit
owner priority, and dependency/blocking signals. Graph degree and mere
unresolvedness are insufficient.

### 7. Operational exhaustiveness is overwhelming the human substrate

In the trailing 30 days, the live vault recorded roughly 1,426 engine commits
and 358 non-engine commits: about 80% of Git history was machine-authored, with
some days producing more than 200 engine commits.

The operational state was about 2.0 GB for a markdown vault of roughly 7.5 MB.
The run ledger contained approximately:

- 178k runs;
- 7.84 million capability-use rows;
- 3.85 million capability rows from link extraction alone;
- 3.01 million from search indexing.

The ledger is faithfully recording each authorized projection effect, but the
audit representation is much more granular than the useful audit question.
For a run that emits thousands of homogeneous link facts, the useful record is
“graph.write allowed for this resource set, N effects, hashes/sample here,”
not N nearly identical permission rows.

Likewise, adoption currently advances the candidate by creating plumbing
commits per patch effect. The intended closure transaction leaks into raw Git
history as pass-level implementation detail.

This is not just storage cost. Git history is one of Dome's human trust and
activity surfaces. Machine dominance makes that surface harder to inspect and
weakens the claim that Git is the clear narrative of what happened.

### 8. Engineering tests are broad; product evaluations are narrow

The test suite is substantial and passed. It is strongest on state machines,
invariants, routing, persistence, capability enforcement, schemas, protocol
parity, and deterministic processor behavior.

The model evaluation suite currently has one golden case, for the morning
brief. There is no first-class benchmark for the core product questions:

- Did recall find the right current page when phrasing changed?
- Did it distinguish an old fact from its update?
- Did it combine evidence across meetings?
- Did it abstain when the vault lacked the answer?
- Did a new source update one canonical record instead of creating a parallel
  one?
- Did a surfaced action actually close after later evidence?

This explains how all engineering gates can pass while the context loop is
“settled” and a basic person query returns nothing.

## Architecture review through the deep-module lens

### Deep modules worth keeping

- **Adoption engine:** high leverage behind a bounded Proposal interface;
  convergence and trusted-state advancement stay local.
- **Capability broker:** one real seam with many effect kinds and grant
  adapters; enforcement locality is excellent.
- **Protocol-neutral surface collectors:** increasingly useful shared
  behavior behind CLI, MCP, HTTP, and app adapters.
- **Git and SQLite boundaries:** complex correctness and migration behavior
  sit behind reusable interfaces with realistic test adapters.

### Shallow or misplaced interfaces to deepen

#### Recall

`query` and `export-context` each orchestrate candidate collection, recall
signals, graph expansion, fusion, ranking, related-row joins, and bounding.
They share helpers but still expose the search mechanism's constraints to
every caller.

Create one deep **Recall module** whose interface expresses intent and returns
a source-backed working set. Query, context export, meeting prep, the assistant,
and future app views should cross that seam.

Conceptually:

```ts
recall({
  question,
  moment: "general" | "today" | "meeting",
  scope?,
  budget,
}): RecallResult
```

The implementation owns query analysis, entity/time expansion, lexical and
semantic channels, graph traversal, reranking, deduplication, temporal
preference, and abstention evidence. The interface should not make callers
learn how many FTS terms must match.

#### Markdown structure

Tasks, claims, wikilinks, generated blocks, frontmatter, headings, and daily
sections are parsed by several related scanners with characterized grammar
differences. Build a deep **MarkdownDocument module** over a lossless parsed
representation. Consumers ask for claims, tasks, links, sections, or safe
edits; the module owns fenced-code exclusions, source ranges, marker blocks,
and rendering.

This directly enables safe range-based split/move operations and reduces the
number of processors that rewrite whole documents from partial understanding.

#### Adoption transaction

Introduce a deep **AdoptionTransaction module** that accumulates authorized
tree edits and projection operations for one causal Proposal, then creates one
human-inspectable closure commit. Run/effect provenance stays in the ledger and
can map many run ids to one closure.

The exact batching boundary needs design work, but the invariant should be:

> Pass-level convergence is visible in `dome explain` and the ledger; causal
> user/maintenance changes are visible in Git.

#### Attention

Questions, diagnostics, proposals, failed runs, and stale tasks currently
converge only at rendering time. Create a protocol-neutral **Attention view
module** with a common item shape: importance, policy, age, source, recommended
action, lifecycle, and obsolescence evidence.

This is a view model, not a fifth engine primitive. It should power the daily,
app review queue, `status`, and `check`, while the underlying stores remain
separate.

## Recommended product model

### One product, three user verbs

The primary product can be explained with three verbs:

- **Tell** — capture a thought, debrief a meeting, or correct Dome.
- **Ask** — recall, prepare, brainstorm, or decide using the current vault.
- **Review** — accept, reject, resolve, or edit the few changes that need
  judgment.

Everything else is an operator or extension concern.

The current HTTP assistant is close to this product seam, but it should be
lifted out of the HTTP adapter into a protocol-neutral **Companion module**.
The CLI, app, MCP, and future clients should invoke the same conversational
turn and action-review behavior.

Do not add a new core primitive for “conversation,” “workflow,” or “meeting.”
Those are intents over the same Companion and Recall modules.

### Four release journeys

#### 1. Start day

The morning surface should answer, in order:

1. What changed since I last looked?
2. What are the 1–3 things most likely to matter today?
3. What meetings need preparation, and why?
4. What decision genuinely needs me?
5. What can Dome or a foreground agent handle without me?

The full task inventory belongs behind expansion, not in the opening working
set.

#### 2. Prepare for a meeting

Selecting a calendar event or asking “prep me for X” should produce:

- the people and their current roles/context;
- the last relevant interactions and decisions;
- commitments in both directions;
- current project state and changes since the last meeting;
- unresolved tensions or questions;
- a short proposed agenda.

This must work from natural language without teaching the user exact search
terms.

#### 3. Debrief a meeting

After a meeting, the Companion should conduct a short, adaptive debrief:

- What changed?
- What was decided?
- What did you commit to?
- What did the other person commit to?
- What remains uncertain?

It then lands one source note and proposes a coherent update set: current
person/project memory, tasks, and superseded claims. The owner reviews the
meaningful delta, not a raw transcript or a dozen independent patches.

This is the missing bridge between capture and action. It is also the best
wedge against meeting-note products: Dome should maintain the longitudinal
record the meeting changes.

#### 4. Ask and brainstorm

The assistant should answer first, show concise evidence, expose uncertainty,
and offer a writeback:

- save the conclusion as a synthesis;
- update an existing canonical page;
- record a decision;
- create or settle follow-through;
- do nothing.

The writeback should reuse source refs from the retrieval trace and prefer
editing current owned prose over appending another dated section.

## Prioritized roadmap

### P0 — prove outcome quality before expanding

#### A. Build a work-derived memory benchmark

Create 30–50 anonymized or synthetic cases derived from real work-vault use.
Use a held-constant answer model and evaluate the memory system separately.
Cover the five useful LongMemEval categories:

- extraction;
- multi-session reasoning;
- temporal reasoning;
- knowledge updates;
- abstention.

Add Dome-specific cases for meeting prep, open-loop closure, source citation,
canonical-page selection, and safe writeback.

Track at minimum:

- target-page recall at 5 and 10;
- answer correctness;
- current-over-stale selection;
- citation support;
- abstention correctness;
- context size and latency.

No retrieval or memory feature should ship without moving this suite.

#### B. Fix candidate generation, then add hybrid recall

Implement a retrieval cascade:

1. exact path/title/alias/entity resolution;
2. BM25 over significant terms with OR/minimum-match fallback;
3. time-aware query expansion and explicit current/superseded preference;
4. graph/open-loop/decision expansion;
5. semantic embeddings as another recomputable channel;
6. lightweight reranking of the bounded candidate set for Companion answers.

The live misses are now enough evidence to reopen the embeddings gate, but
embeddings should not hide the strict-AND defect. Fix lexical recall first and
measure each added channel independently.

#### C. Put an owner-attention budget into the product

- Show at most three owner-needed items in the default daily surface.
- Rank by consequence, time sensitivity, and confidence, not age alone.
- Auto-handle agent-safe work in the background and report the result.
- Move aging low-consequence decisions to a weekly review.
- Add semantic obsolescence: newer decisions, completed events, and superseding
  claims can close or reframe old questions with source-backed evidence.
- Never recommend `keep` merely because the system lacks resolution evidence.

#### D. Make compaction deterministic at the mutation seam

- Add outline/range reads to the MarkdownDocument module.
- Let the model propose a split plan using headings and summaries.
- Move exact source ranges deterministically.
- Render a compact hub and 2–6 focused pages.
- Validate losslessness mechanically and present one reviewable proposal.
- Replace “Current facts” duplication with a bounded latest-by-key view; block
  or surface collisions before rendering them as current.

#### E. Reduce audit and Git amplification

- Aggregate capability uses per run by capability, outcome, and resource set,
  retaining counts and hashes/samples.
- Batch authorized adoption edits into one causal closure commit.
- Group garden cascades caused by one scheduled/source event into one
  human-facing change where safety permits.
- Run retention and vacuum automatically, with a hard size budget and growth
  forecast.
- Make `dome log` the detailed pass view and keep raw Git legible.

### P1 — deepen the Companion and app around the four journeys

- Lift the assistant from the HTTP adapter into a protocol-neutral Companion
  module.
- Give it the deep Recall result rather than a brittle raw search tool.
- Add conversational continuity scoped to the vault and current task.
- Make Today, Ask, and Review the three primary app locations.
- Treat “meeting prep” and “debrief” as intent shortcuts, not new subsystems.
- Render inline evidence and reviewable diffs consistently across app, CLI,
  and MCP.
- Add an explicit “this was wrong / stale / missing” correction path that
  records benchmarkable feedback, not just free-text retrieval misses.

### P2 — only after the wedge is reliable

- richer connectors and source subscriptions;
- semantic memory channels beyond embeddings;
- LSP/Obsidian live diagnostics;
- extension marketplace and third-party operator contributions;
- hosted/multi-user trust domains;
- broader app workflows.

These are valuable, but they multiply an experience that is not yet closed.

## What not to build next

- Another top-level CLI command.
- Another user-visible maintenance loop.
- More page types or a heavier ontology.
- A generic workflow primitive.
- A graph visualization as the main product.
- Embeddings without an evaluation harness.
- More app panels that directly expose diagnostics, processors, or stores.
- A marketplace before first-party loops meet their own outcome contracts.
- An LSP before natural-language recall and meeting workflows work.

## Make maintenance-loop settlement real

Keep maintenance loops as product/design language, but replace generic
settlement with typed, domain-specific observations.

Examples:

| Loop | Useful settlement evidence |
| --- | --- |
| Capture digestion | raw captures awaiting disposition; oldest age; integration success rate |
| Open-loop continuity | unresolved source tasks missing from current surface; duplicate identities; closure propagation lag |
| Context packet | canary query pass rate; target recall@k; stale/current errors; packet budget |
| Question continuity | open owner questions; semantically obsolete questions; median age; auto-resolution precision |
| Meaning integration | unsettled material/destination pairs; oldest age; blocked-by-size count |
| Daily edition | brief present or explicit fallback; calendar coverage; owner-attention count; user edits preserved |

The status names should describe actual state:

- `settled` — desired condition currently holds;
- `pending` — bounded work exists and the system is progressing;
- `blocked` — work cannot continue without owner/external action;
- `degraded` — a fallback is serving, but quality is below target;
- `inactive` — intentionally disabled.

“Quiet” should not mean both “nothing is wrong” and “we did not measure the
outcome.”

## Public-release gates

The existing two-week soak is directionally right but has only one complete
counted workday despite extensive vault activity. The evidence process has
become easier to test than to use.

Replace or supplement it with automatic outcome telemetry and a short owner
rating. A public V1 should require:

- at least 10 real workdays across two weeks;
- each of the four release journeys used successfully on multiple days;
- benchmark targets met for recall, temporal updates, citations, and
  abstention;
- no lost source edits and no manual operational-state repair;
- capture-to-integrated p90 under 24 hours;
- no semantically obsolete owner question surviving more than one daily
  cycle when resolving evidence exists;
- default daily owner attention at or below three items;
- no destination permanently blocked by the system's own read-size limit;
- engine commits reduced to a small multiple of causal human/source events;
- bounded operational-state growth, with a 30-day 1,000-page vault far below
  the current multi-gigabyte footprint;
- a fresh user can install, connect one source, capture one item, and receive a
  useful recalled result in under 15 minutes.

## Positioning after the current market scan

Several features that once looked differentiating are now category table
stakes:

- Granola supports cross-meeting chat, citations, reusable recipes, and MCP
  access to external agents.
- Mem offers agentic chat, note updates, version history, semantic retrieval,
  and MCP/Claude connectivity.
- Notion searches connected work sources and produces cited answers and
  research reports.
- Tana explicitly positions around connected records, meeting prep, and
  reviewable actions rather than isolated summaries.
- Letta now describes Git-backed context repositories, sleep-time reflection,
  and memory defragmentation that splits and reorganizes large files.

Therefore Dome should not lead with “AI chat over your notes,” “MCP for your
second brain,” “Git-backed memory,” or “nightly agents.” Those are no longer
enough.

Dome's strongest combined position is:

1. It mounts under the user's existing human-readable vault.
2. It treats sources, current memory, projections, and operational state as
   different classes with explicit durability rules.
3. It enforces provenance and write authority mechanically.
4. It continuously reconciles memory toward currentness instead of merely
   accumulating searchable records.
5. It can serve any foreground client without making that client the memory
   owner.

The defensible phrase is **memory homeostasis for a user-owned knowledge
base**. The public product language should translate that into outcomes:

> Dome keeps the knowledge you already own current, useful, and ready for the
> next conversation.

## Relevant external references

- [LongMemEval](https://arxiv.org/abs/2410.10813) — evaluates extraction,
  multi-session reasoning, temporal reasoning, knowledge updates, and
  abstention; its time-aware query and indexing findings map directly to
  Dome's recall gaps.
- [Mem0 paper](https://arxiv.org/abs/2504.19413) — evidence for dynamic
  extraction/consolidation and hybrid structured memory, with explicit
  accuracy/latency evaluation.
- [Zep temporal knowledge graph paper](https://arxiv.org/abs/2501.13956) —
  relevant to current-vs-historical relationship retrieval.
- [Letta context repositories](https://www.letta.com/blog/context-repositories/)
  — Git-backed memory, background reflection, and defragmentation are now an
  adjacent design space, not a unique Dome claim.
- [Granola cross-meeting chat](https://docs.granola.ai/help-center/getting-more-from-your-notes/chatting-with-your-meetings)
  and [Granola MCP positioning](https://www.granola.ai/ai-note-taker) — meeting
  recall and external-agent context are table stakes.
- [Tana's connected-record/action argument](https://tana.inc/blog/why-ai-notetakers-fail-to-drive-action-2026)
  — a useful articulation of why summaries and extracted tasks do not close
  the work loop.
- [Mem 2.0](https://get.mem.ai/blog/introducing-mem-2-0) — recall,
  resurfacing, agentic note updates, and rollback in the current notes market.
- [Notion Enterprise Search](https://www.notion.com/product/enterprise-search)
  — connected-source answers and citations are mainstream product
  expectations.

## Final recommendation

Do not rewrite the engine. Do not release the current breadth as if breadth is
the product.

Freeze new primitives, extensions, commands, and app panels for one focused
cycle. Build the outcome evals, fix recall, make questions and claims temporal,
make oversized-page compaction structurally possible, compress machine noise,
and prove the four journeys in the real work vault.

If that succeeds, the existing engine becomes a formidable advantage: many
clients and features can sit on a trusted memory substrate whose quality is
measured in user outcomes. If it does not, more clients will only make the
current incoherence easier to encounter.
