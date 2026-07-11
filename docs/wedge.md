---
type: plan
tags:
  - wedge
  - roadmap
  - product
  - surfaces
created: 2026-06-09
updated: 2026-07-11
status: superseded
sources:
  - "[[v1]]"
  - "[[VISION]]"
  - "[[wiki/concepts/llm-wiki-pattern]]"
  - "[[wiki/syntheses/why-dome-vs-mem-tana-granola]]"
---

# Dome wedge plan — from engine to second brain

> [!NOTE]
> This was the product wedge plan of record on 2026-06-09. Its five phases
> shipped, but several named implementations were subsequently simplified.
> [[cohesive/plans/2026-07-11-productization-modernization]] is the current
> continuation plan. The material below is retained as decision history.

This plan did not replace [[v1]]; it re-sequenced the remaining work
**surface-in instead of engine-out** and added the missing product layer on
top of the shipped compiler.

## Diagnosis

Dome today is an engine without a product. The compiler core ([[v1]] §"Current
shipped foundation") is real and tested: adoption loop, capability broker,
projections, ledger, the deterministic bundles. But every differentiated
behavior is gated behind three gaps:

1. **No model provider ships.** Every LLM-backed processor
   (`dome.agent.ingest`, `dome.agent.consolidate`, `dome.warden.integrity`)
   silently no-ops unless the vault owner hand-writes a
   `.dome/model-provider.ts` speaking the stdio protocol. No scaffold exists.
2. **The daemon is not ambient.** Scheduled processors only fire while
   `dome serve` polls. There is no service-manager story; "runs in the
   background" currently means "runs in a tmux pane."
3. **No push surface closes the loop.** Capture goes in; nothing is guaranteed
   to come back out at a moment of use. The owner still manually prompts
   "prepare my morning doc" every day.

The research consensus (PKM landscape + 2024–2026 agent-memory literature) is
blunt about where second brains die: **retrieval, never capture**. Systems
survive when they *push* knowledge to the user at scheduled moments of use
(morning brief, meeting prep, weekly review) and the agent absorbs all
organizing ceremony. Systems die when value is structural and atemporal
(graphs, taxonomies) or deferred behind setup.

Key external validations of choices Dome already made — keep these:

- Markdown canonical + SQLite as disposable derived index (Anthropic memory
  tool, Karpathy LLM-wiki, memweave all converge here).
- Add-only knowledge with supersession over LLM write-time UPDATE/DELETE
  (Mem0's published pivot). `MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS` is
  vindicated, not too conservative.
- Propose-not-auto for meaning-level changes; git history as the trust/undo
  substrate (every agentic-memory paper's prerequisite for safe evolution).
- Engine has no LLM dependency; intelligence injected at the boundary.

Key external findings Dome has not yet acted on — build these:

- **Sleep-time compute**: precomputing predictable queries (a morning brief is
  the maximally predictable query) gives large accuracy/latency wins. The
  nightly consolidation + overnight brief is the evidence-backed engine loop.
- **Heartbeat/cron with silence as default**, three escalation levels only
  (notify / question / review); batch non-urgent surfacing into the brief
  ritual. Dome's question system is the right plumbing and has no surface.
- **MCP as the universal front-end contract** so every future surface (voice,
  phone, other agents) is a thin client.
- **The validated wedge loop**: raw capture → auto-organized → *appears in
  tomorrow's brief with extracted todos*. One loop, felt daily, zero
  methodology to learn.

## The strategic call

**Evolve, don't rebuild.** The four-concept core, the broker, and the
projection store stay. What changes is sequencing and defaults:

- **Keep**: markdown+git as truth; Proposal write path; rebuildable
  projections; capability discipline; the test harness and invariant lockstep;
  `dome.daily` as the temporal spine.
- **Demote**: engine generality work (new effect kinds, capability tiers,
  speculative protocol adapters) until the wedge ships. `dome.graph` remains
  retrieval plumbing, never a surface. `dome.warden` stays opt-in.
- **Reverse one default**: provider-neutrality stays as the escape hatch, but
  `dome init` must produce a vault where intelligence works on day one. A
  batteries-included Anthropic provider scaffold ships with the SDK.

## North-star daily experience

The wedge is done when this is true without opening a terminal:

> At 11pm you mumble a thought into your phone; it lands in `inbox/raw/`.
> Overnight, Dome ingests it into the vault, consolidates the day, reads
> tomorrow's calendar, and writes the morning brief into today's daily note.
> At 7am the brief is waiting: yesterday's loose ends, today's meetings with
> prep context, open loops ranked, and that 11pm thought filed with its todo
> on the list. Questions Dome couldn't settle are listed, one tap each.

## Phases

Phases 1–2 are enablers (small, unblock everything). Phases 3–4 are the wedge.
Phase 5 is the multiplier. Each phase follows repo discipline: spec edit first,
then implementation, then tests (AC3 lockstep where invariants are touched).

### Phase 1 — Ambient daemon (`dome install`)

The daemon must survive reboots and require zero babysitting.

- `dome install` / `dome uninstall`: generate and load a launchd LaunchAgent
  (macOS) running `dome serve` for the vault; idempotent; logs to
  `.dome/state/serve.log` (gitignored).
- `dome status` reports service state (installed / running / stale) and the
  scheduler's last-fired cursor so a dead daemon is visible, not silent.
  Shipped as `dome install --status` (installed/loaded probe; a loaded
  service also writes the serve heartbeat `dome status` already reads);
  surfacing installed-but-dead state directly inside `dome status` is
  deferred as a Phase 1 follow-up.
- Spec: [[wiki/specs/cli]] gains the command section; daemon lifecycle
  documented in [[wiki/specs/harnesses]] or a new `service` spec page.
- Acceptance: after `dome install`, a reboot later, the 06:00 daily-note
  schedule fires with no human action; `dome status` shows the service.

### Phase 2 — Batteries-included model provider

- Ship a first-party provider template (Anthropic Messages API with tool-use
  step support, cost caps honored) in `assets/`; `dome init
  --with-model-provider anthropic` scaffolds it into `.dome/model-provider.ts`
  and wires `.dome/config.yaml`.
- `dome doctor` (or `check`) gains a provider probe: configured? responds to a
  ping envelope? key present? Today's silent no-op becomes loud.
- Spec: model-provider scaffold + probe documented in [[wiki/specs/sdk-surface]]
  and the CLI spec.
- Acceptance: fresh `dome init --with-model-provider anthropic` + API key env
  → committing a file into `inbox/raw/` produces an ingest run visible in
  `dome inspect runs`, with no source-code reading required.

### Phase 3 — Capture loop

Make capture trivially cheap from anywhere, with guaranteed processing.

- `dome capture [--text|--file|stdin]`: writes a timestamped source file into
  `inbox/raw/`, commits it, returns immediately. The existing
  `dome.agent.ingest` + inbox-staleness diagnostics handle the rest.
- Document (and ship as a recipe) the phone path: iOS Shortcut / voice memo →
  transcription → file in `inbox/raw/` (git or file-drop). The engine treats
  it as an ordinary commit — no new engine surface needed.
- Ingest hardening from dogfood: every ingested capture must leave a trace in
  the daily note's open-loop section when it contains an actionable item
  (this is the "guaranteed re-entry into circulation" property).
- Maps to [[v1]] M3 (capture digestion loop) — unchanged in substance,
  promoted in priority.
- Acceptance: `echo "idea" | dome capture` → within one serve tick the
  capture is filed, linked, and any todo appears in today's open loops.

### Phase 4 — Nightly consolidation + morning brief

The flagship surface. Sleep-time compute aimed at the one perfectly
predictable query.

- **Nightly consolidation pass** (extends `dome.agent.consolidate`, moves from
  weekly to nightly with a tighter charter): dedupe → cluster related recent
  episodes → reflect/summarize into or onto concept/entity pages → construct
  wikilinks → mark superseded facts (supersession markers, never deletion).
  All meaning-level changes remain propose-not-auto per [[v1]] decision
  ledger.
- **Calendar as a source**: a fetch adapter lands tomorrow's agenda as an
  ordinary source file (e.g. `sources/calendar/YYYY-MM-DD.md`) via the outbox
  /external capability path. The engine never gains a calendar dependency;
  it's just another committed source.
- **Brief generation** (new `dome.agent.brief`, scheduled ~05:30): composes
  the daily note's generated blocks — yesterday's outcomes and unfinished
  threads, today's meetings each with a context packet digest (people, prior
  decisions, open questions), open loops ranked by staleness × salience, and
  the open Dome questions batch. Human-fragment + AI-scaffold: generated
  blocks only; the rest of the daily stays collaborative markdown ([[v1]]
  decision 1).
- Acceptance: for five consecutive dogfood days, the 7am daily note is
  complete enough that the manual "prepare my morning doc" Claude Code ritual
  is not needed.

### Phase 5 — MCP server

- Implement [[wiki/specs/mcp-surface]]: `capture`, `query`, `export_context`,
  `brief`, `tasks` (list/settle), `resolve` as MCP tools over the same
  runtime/view boundary the CLI uses (protocol adapter per
  [[wiki/matrices/protocol-adapter]]).
- Acceptance: a fresh Claude Code session with the Dome MCP server attached
  can capture a thought and pull the morning brief without shelling out.

## Metrics (dogfood)

Measure push, not capture:

- **Resurfaced-and-acted-on**: captures that later appear in a brief/daily and
  get settled or referenced. The only growth metric that matters.
- **Brief streak**: consecutive mornings the generated brief replaced the
  manual ritual.
- **Capture→circulation latency**: commit of `inbox/raw/` file → todo/link
  visible in a surface.
- **Question throughput**: open Dome questions resolved per week via the brief
  batch (vs. accumulating).

## Risks

- **Daemon reliability becomes the product surface.** A silent dead daemon now
  means no brief. Phase 1's status/probe work is load-bearing, not polish.
- **Trust burn from a bad brief.** One hallucinated "fact about you" costs
  more than a hundred good briefs earn. Brief blocks carry source refs;
  anything ungrounded renders as a question, not an assertion.
- **Consolidation overreach.** Nightly cadence multiplies the janitor's
  blast radius; ledger + propose-not-auto + per-run patch caps stay mandatory.
- **Prompt injection via captures.** Transcripts and clips are untrusted input
  to consolidation prompts; ingest charter must treat source content as data,
  not instructions.

## Decision ledger additions

1. **Evolve, don't rebuild** (2026-06-09). The bespoke processor runtime and
   broker stay; the Agent-SDK-rebuild alternative was considered and rejected
   because the capability/trust guarantees are the product.
2. **Anthropic is the shipped default provider**; neutrality remains via the
   existing command protocol.
3. **The brief is generated blocks in the daily note**, not a separate
   document (extends [[v1]] decision 1).
4. **Calendar enters as committed source files**, not as an engine
   integration.
5. **Graph and warden remain demoted** until the wedge metrics exist to argue
   otherwise.
