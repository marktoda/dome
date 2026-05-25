# Substrate Discovery — Dome vision and initial architecture

## Substrate discovered

### Empty-substrate verdict

**Empty-substrate verdict: yes**

Trivially empty across normative buckets: no `CLAUDE.md`, no `AGENTS.md`, no `README.md`, no tests, no CI, no linters, no package manifests. One design doc (`docs/ARCHITECTURE.md`) exists as the seed.

### Target change surface

- Subsystem: (repo-wide; greenfield vision)
- Main files likely involved: `docs/ARCHITECTURE.md` (seed); future `docs/VISION.md`, `docs/specs/**`, `docs/substrate/**`, and an SDK source tree yet to be decided
- Neighboring subsystems: none (no code yet)

### Relevant specs/docs

- `docs/ARCHITECTURE.md` — Frames Dome as **"a prompt-governed compiler from raw personal input into a living markdown wiki"** (line 7). Proposes a five-directory layout (`/raw`, `/wiki`, `/prompts`, `/state`, plus `/wiki/inbox.md`), four durable data types (raw source, wiki page, index, log), a single generic page schema, an ingestion pipeline (raw → cleaned → atomic extraction → page association → page updates → index/log updates → optional inbox review), and a five-prompt stack (system, ingest, query, lint, research). Names one explicit trade-off: lightweight wiki vs. structured database, picking lightweight.

### Behavior matrices

- Existing: none
- Missing but likely needed:
  - **Raw-source-type × ingestion handling.** ARCHITECTURE.md lines 63-75 enumerate at least 9 source types (voice, meeting transcript, ChatGPT/Claude export, web clip, PDF, Slack, email, manual note, research memo) but doesn't pin per-type behavior. Branchy at ingest.
  - **Sensitivity × write destination.** Sensitive content routes to inbox; safe content routes to pages (line 401-420, line 923). The boundary ("performance, compensation, HR, legal, health, interpersonal conflict" — line 923) is enumerated but not matrixed.
  - **Page operation × precondition.** Create / update / merge / split / link / unlink / archive — ARCHITECTURE.md names create/update rules but not the others. A future lint pass implies merge/split exist.

### Named invariants

- Existing: none
- Candidate invariants (implicit positions in ARCHITECTURE.md that should become named once spec'd):
  - **`RAW_IS_IMMUTABLE`** — `docs/ARCHITECTURE.md:76` — "Raw sources should be immutable. The AI can summarize and reference them, but should not rewrite them." The entire trust model depends on this. Needs structural enforcement (filesystem-level immutability flag, or git-checked, or a write-path linter).
  - **`MARKDOWN_IS_SOURCE_OF_TRUTH`** — `docs/ARCHITECTURE.md:518` — "the markdown remains the source of truth." State files (`page_registry.json`, `aliases.json`) are derivative-only. A future indexing optimization that violated this would be a silent corruption risk.
  - **`PAGES_USE_ONE_SCHEMA`** — `docs/ARCHITECTURE.md:124` — "all wiki pages use one generic format." The design *deliberately* refuses per-type schemas for person/project/team/decision/risk to avoid premature ontology. Any future "let's add a Decision type" PR violates this.
  - **`ATOMIC_IDEAS_ARE_INTERMEDIATE`** — `docs/ARCHITECTURE.md:232` — "atomic ideas do not need to be first-class files yet." The "yet" is a deferred decision — relevant for the brainstorm's "atomic-IR persistence" axis.
  - **`LOG_IS_APPEND_ONLY`** — `docs/ARCHITECTURE.md:481, 873` — operational history never mutates. Required for the "what was I thinking 6 weeks ago" use case.
  - **`SENSITIVE_GOES_TO_INBOX`** — `docs/ARCHITECTURE.md:923` — people/performance/comp/legal/health/interpersonal content writes to `inbox.md`, never directly to a page. The "no silent sensitive writes" trust principle from the brainstorm partner doc.
  - **`PAGE_CREATION_REQUIRES_RECURRENCE`** — `docs/ARCHITECTURE.md:887,893` — pages are created only when concepts will recur; one-off thoughts live as bullets. Prevents page explosion.
  - **`PROMPTS_ARE_CONTRACT`** — implicit throughout — the system's behavior is encoded in prompts (line 50: "the core product is the workflow encoded in prompts"). A future refactor that hardcodes behavior in TypeScript/Python without updating prompts violates the contract.

### Existing enforcement

- Tests: none
- Types: none
- Constraints: none
- CI checks: none
- Semantic linters: none

(This is a greenfield. Every enforcement story is a future-pressure question for the brainstorm.)

### Known gotchas / scars

- Existing in dedicated `gotchas/` dir: none
- Implicit in ARCHITECTURE.md prose:
  - **Page explosion** — `docs/ARCHITECTURE.md:382` — solved by the association step + page creation rules. A weak page-creation prompt would re-introduce.
  - **Sensitive-write creep** — `docs/ARCHITECTURE.md:401-420` — the LLM silently writing interpretive judgments to a person page is a trust-killing failure mode; inbox routing is the structural mitigation.
  - **Belief-vs-claim conflation** — `docs/ARCHITECTURE.md:610` — "Keeps the wiki from blending 'I think this' with 'an article said this.'" Research content must be marked external.
  - **Second-brain abandonment** — (from brainstorm partner doc, not ARCHITECTURE.md) — users abandon PKM tools due to maintenance burden. ARCHITECTURE.md's response is "the system should maintain structure, not demand structure" (principle line 1015) — the LLM does the maintenance.

### Locality boundaries

- No code yet; no boundaries to assess.
- Implicit seams ARCHITECTURE.md proposes:
  - `/raw` (immutable, user-provided) vs `/wiki` (synthesized, LLM-mutable) — the durability seam
  - markdown files (canonical) vs `/state` (derivative) — the source-of-truth seam
  - pages (synthesis) vs `inbox` (pending review) vs `log` (history) vs `index` (catalog) — different roles within the wiki
  - prompts (behavior contract) vs SDK code (mechanism) — the contract seam (not in ARCHITECTURE.md; load-bearing for the brainstorm)

### Package files (for library-native review)

- None. Language and runtime are undecided.

### Missing memory

**This is the highest-leverage section of this report.** ARCHITECTURE.md settles the *vault shape* but leaves the *engine shape* unspecified. The brainstorm should pressure-test these:

- **SDK boundary undefined** — `docs/ARCHITECTURE.md` (entire doc) — names a directory layout and a workflow but does not name the API surface that a future TUI / web / mobile / voice client calls into. There is no contract for "what does Dome expose to consumers?" The substrate that would close this: a spec naming the SDK's primary operations (capture, ingest, query, lint, research, export-context) and their input/output contracts. Without it, the TUI ships against an ad-hoc API and the web client later re-discovers a different one.

- **LLM-orchestration locus unsettled** — `docs/ARCHITECTURE.md:50, 277-282, 522-610` — the doc consistently frames "prompts are the contract" but doesn't resolve whether the SDK is (a) a deterministic compiler that loads prompts and makes LLM calls at fixed pipeline stages, (b) an agent runtime that hosts prompts as tools, or (c) a thin wrapper around an external agent harness (Claude Code / Cursor / similar). The substrate that would close this: a named invariant + spec naming the orchestration model, plus a gotcha doc on the rejected alternatives. This is the single biggest design fork.

- **Compilation model unspecified** — `docs/ARCHITECTURE.md:957-1006` — the ingest algorithm is one-shot per raw source. The doc does not address re-compilation when a related page changes later (does Atlas re-update if a Maya-Rivera page gains a relevant claim?), periodic lint passes (lint is named at line 941 but not scheduled), or temporal awareness ("what I was thinking 6 weeks ago"). The user's framing of "track and translate the entire brain over time" implies multi-pass compilation. The substrate that would close this: a behavior matrix for compilation-event × triggered-action, plus a spec on the lint cadence.

- **Atomic-IR persistence — "yet" is a deferred decision** — `docs/ARCHITECTURE.md:232` — "atomic ideas do not need to be first-class files yet." But the user's vision mentions "what I've changed my mind about," which is structurally an atomic-claim-evolution query. If atomic ideas stay purely intermediate, that query gets harder over time. The substrate that would close this: an explicit decision (with reasoning) on whether atomic ideas persist, and if so, in what shape (claim-with-provenance vs. graph-node vs. event-log entry).

- **TUI role unmentioned** — `docs/ARCHITECTURE.md` (entire doc) — the doc names voice as the canonical input channel (AirPods, walking, etc.) but says nothing about a terminal UI. The user has now stated TUI as the first interface. The substrate that would close this: a spec naming what the TUI does (capture only? capture + browse + query + research + lint + review?) and how it composes onto the SDK.

- **Multi-vault / namespace unaddressed** — `docs/ARCHITECTURE.md:822-849` — shows a single `/vault`. The brainstorm partner doc raised personal / work / management-private separation (a privacy primitive). The substrate that would close this: a decision (with reasoning) on single-vault vs. namespaced-vaults vs. tags-as-vaults.

- **External integration / context-packet export — entirely absent from ARCHITECTURE.md** — the brainstorm partner doc named "context router for every AI app" as a central differentiator (the antidote to pinned-thread chaos). MCP was named as a candidate protocol. ARCHITECTURE.md doesn't mention any of this. The substrate that would close this: a spec naming Dome's external surface (MCP server? CLI? files-on-disk?) and what a context-packet looks like.

- **Temporal awareness not structurally supported** — `docs/ARCHITECTURE.md:138` (frontmatter has `last_updated`) — pages carry a last-edit timestamp but no version history; superseded claims are kept "with source trail" (line 1019) but the mechanism is undefined. The "what was I thinking 6 weeks ago" / "what have I changed my mind about" queries need either git history exploitation, an explicit claim-event-log, or page-history pages. The substrate that would close this: a decision on the temporal model.

- **Language / runtime undecided** — no package manifests on disk. TypeScript / Python / Rust / Go are all candidates and shape the SDK's ergonomics. The substrate that would close this: an ADR-style decision.

- **Multi-device sync deferred but unstated** — local-first is a stated principle from the brainstorm partner doc; the user mentioned mobile/web later. The sync model (none → manual git → Syncthing → CRDT → cloud) shapes file-format and concurrency assumptions. The substrate that would close this: a deferred-decision doc naming sync as out-of-scope-for-v0 with a list of v0 choices that don't lock it out.

### Next

Brainstorm Dome's vision and initial SDK architecture, grounded in this discovery. *(`cohesive:brainstorm-design`.)* **Design question:** Where does the LLM-orchestration logic live (deterministic compiler vs. agent runtime vs. external-harness wrapper), and what SDK surface does that produce that the TUI + future web/mobile/voice clients all sit on without rewrite? Discovery report at this file's path.
