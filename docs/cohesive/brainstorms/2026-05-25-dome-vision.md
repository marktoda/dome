# Brainstorm — Dome vision and initial architecture

### Current scope

- Vision doc + initial architecture for Dome (a personal LLM-wiki second brain).
- Backend SDK as the first deliverable; v0.5 demo uses Claude Code + Obsidian as harnesses (no proprietary UI in v0.5).
- v1+ ships native mobile / web / voice clients over the same SDK contract.

### Future pressure (not current scope)

- Voice/AirPods capture via streaming-audio client.
- Native mobile + web + desktop clients sitting on the SDK.
- Deep research that writes back into the wiki.
- Context-packet export / MCP-based handoff to ChatGPT / Cursor / etc.
- Temporal queries ("what was I thinking 6 weeks ago", "what have I changed my mind about").
- Multi-device sync (the vault is portable markdown; sync layer is plug-in).
- Mass-market on-ramp via `dome migrate` from existing markdown vaults.

### Non-goals (v0.5)

- Hardware, always-on listening, team collaboration.
- Manager-specific wedge framing (we target the manager *use case* via the audience-first-wedge sequencing, but the product is general-purpose by design).
- Custom graph DB, separate decision/risk entity types.
- Replacing Notion / Obsidian / Granola.
- A proprietary TUI or chat surface — Claude Code is the v0.5 harness; Obsidian is the browser.

## Design options

### Option A1: Deterministic compiler with fixed pipelines (rejected)

**Summary:** SDK exposes deterministic operations (`ingest`, `query`, `lint`, `research`, `export-context`); each is a fixed pipeline that loads prompts and makes LLM calls at known stages.
**Substrate changes required:** Specs for each pipeline; behavior matrices for stage transitions; invariants enforced at pipeline boundary.
**Locality impact:** Centralizes orchestration logic in the SDK; each new behavior requires a new pipeline.
**Future fit:** Multi-client API is clean (each pipeline → MCP tool). Bad fit for conversational workflows where query flows into update.
**Initial risks:** Workflow mismatch with observed usage (substrate evidence in `~/vaults/work/log.md`: 47 update vs. 15 ingest operations over 62 entries — 3:1 ratio).

### Option A2 (refined): Agent-runtime SDK with typed tool surface (chosen)

**Summary:** SDK exposes typed tools (`read_page`, `write_page`, `append_log`, `search_index`, `wikilink_resolve`, `route_sensitive_to_inbox`, `do_research`, `propose_lint_fixes`, etc.), each enforcing invariants at call site. Workflows live in prompts the agent composes against the tools. Quick-capture is the one deterministic side door (talk → dump raw → async-trigger ingest).
**Substrate changes required:** Spec for SDK tool surface; spec for prompt library; named invariants per tool's enforcement contract; behavior matrices for tool × invariant × failure-mode.
**Locality impact:** Orchestration lives in prompts (not SDK code); SDK is the typed I/O layer; invariants enforced at tool boundary.
**Future fit:** Excellent. Any MCP-capable harness becomes Dome-aware. New workflows = new prompts. v1+ native apps mount the same tools.
**Initial risks:** Agent prompt regression can produce semantically-wrong page updates that pass structural invariants.

### Option A3: Pure harness-extension (rejected)

**Summary:** No SDK runtime; just a vault + prompts + MCP tools mounted in Claude Code.
**Substrate changes required:** Prompts only.
**Locality impact:** All orchestration locked to whatever harness mounts the MCP server.
**Future fit:** Blocked — no path to web/mobile/voice clients as independent surfaces.
**Initial risks:** No separable SDK means the user's "polished version" never becomes its own product.

## Decision dialog

### Axes walked

- **Axis A (LLM-orchestration locus):** agent originally picked A1 (compiler-core); user redirected to A2 on conversational-workflow grounds, citing existing Claude Code usage and the desire for query↔update fluidity. Re-decided to **A2 (refined)** after deeper substrate review of `~/vaults/work/` (137 entities / 90 concepts / 57 sources / 12 syntheses; CLAUDE.md is structurally an agent prompt contract; log shows 3:1 update:ingest). Substrate evidence: `~/vaults/work/CLAUDE.md:64-103` defines tool-shaped operations Claude Code composes; `~/vaults/work/log.md` shows multi-page-touch updates with judgment-laden "framing decisions" prose.

- **Axis B (TUI shipping window — became "proprietary UI at all"):** initial agent pick was "v0.5 layered chat + power-user TUI"; user redirected to "no proprietary UI in v0.5, use Claude Code + Obsidian." Substrate evidence: user's vault has `.obsidian/` directory + active Obsidian usage; user explicitly framed Dome v0.5 as a "demo" with mass-market v1+ as the destination.

### Sub-decisions

| # | Sub-decision | Tag | Outcome | Notes |
|---|---|---|---|---|
| 1 | Proprietary UI in v0.5 | Pick | None — Claude Code + Obsidian + small CLI | User framing: "no reason to have our own TUI; should hook into Claude Code / OpenCode / Codex / other agentic things." Mass-market UI work deferred to v1+. |
| 2 | Language / runtime | Pick — re-decided 2026-05-25 | **TypeScript (Node.js 22+ or Bun, TBD in spec rewrite)** | Pivoted from Python after user pushback. TS type system is actually richer for the SDK's tool contracts (discriminated unions, branded path types, exhaustiveness checking on event taxonomies). Same-language alignment with v1+ web client (mandatory TS) and potential React Native mobile (shared Zod schemas). Anthropic + MCP both first-class in TS. Whisper / Python ML concern is not a v0.5 issue — voice ingestion is v1+, and transcription is OS-native before it reaches Dome. The TUI-via-Textual argument collapses because v0.5 has no TUI; v1+ has Ink available if needed. |
| 3 | Page schema | Confirm | `PAGE_TYPE_BY_DIRECTORY` — four types (entity / concept / source / synthesis) | Substrate evidence: `~/vaults/work/CLAUDE.md:49-56` defines four types via directory; ARCHITECTURE.md's "one generic schema" claim contradicted by user's actual vault. Retire `PAGES_USE_ONE_SCHEMA` candidate invariant. |
| 4 | Atomic-IR persistence | Confirm | Skip in v0.5; agent extracts atoms internally; nothing materialized | Add `wiki/claims/` + `claim` tool later if "what have I changed my mind about" pressure arrives. Hybrid graft (claim IDs in markdown comments) considered — flagged as optional in Phase 4 graft check. |
| 5 | Compilation model | Confirm | Tool-composed (no fixed pipelines). Quick-capture = async-deterministic side door. Lint = its own prompt+command. | Re-compilation on related-page change deferred to v1+. |
| 6 | MCP timing | Confirm | Ship v0.5 | Claude Code is the v0.5 harness; MCP is load-bearing for that. |
| 7 | Vault model | Confirm | Vault-agnostic SDK (one invocation = one vault root) | Multi-vault achieved by not being multi-vault-aware; honors user's existing `~/vaults/work` and `~/vaults/personal` separation. |
| 8 | CLI surface | Confirm | 8 commands: `dome init`, `dome migrate`, `dome capture`, `dome lint`, `dome inbox`, `dome doctor`, `dome export-context`, `dome serve` | `dome migrate` is the v1+ on-ramp for existing markdown vaults. |

### Cross-branch graft check (Phase 4 opening, conv-mode)

- **Hybrid candidate surfaced?** Yes. Graft from B3 (claim-event-log) branch: have ingest prompt emit stable claim IDs as HTML comments in page markdown (`<!-- claim: c_2026-05-25_1432_001 -->`). v0.5 cost: one prompt rule. v1+ benefit: a future `dome claims --evolution <topic>` tool reconstructs claim lifecycle by parsing the IDs, without forklifting the page schema.
- **Cleared?** Flagged in recommendation as an optional v0.5 polish item, not load-bearing for the leaf. User can include or defer at spec-rewrite time.

## Pressure test summary

| Aspect | A2 refined (chosen) | A1 (rejected) | A3 (rejected) |
|---|---|---|---|
| Cohesion | High — tool boundary enforces invariants structurally; prompts evolve independently | Medium — pipelines bake workflow assumptions | Low — no SDK contract; agent-discipline-bound |
| Substrate delta | Medium — new tool-spec, prompt-spec, ~9 named invariants, 2 matrices | Large — per-pipeline specs, per-stage invariants | Small — prompts only |
| Future fit | ✓ Multi-harness, multi-client; native apps reuse SDK | ✓ Multi-client but each new workflow needs new pipeline | ✗ Locked to one harness |
| Locality | Good — SDK / prompts / harness cleanly separated | Centralizes flow in SDK | Locks flow to harness |
| Main risk | Agent prompt regression silently miswriting | Pipeline rigidity blocks fluid use | No path to mass market |

## Breakage analysis

### Option A2 (refined) — the chosen leaf

- **Docs that would change:** `docs/ARCHITECTURE.md` (mark superseded; preserve as historical seed) — three positions revised: one-generic-schema → four-typed-pages-by-directory; atoms-as-IR-in-raw-files → atoms-agent-internal (skipped in v0.5); inbox-as-file → inbox-as-tool-routed-destination.
- **New docs required (v0.5 scope):**
  - `docs/VISION.md` (written this session) — north-star vision.
  - `docs/specs/sdk-surface.md` — typed tool surface, I/O contracts, invariant contracts per tool.
  - `docs/specs/page-schema.md` — four-type schema, frontmatter contract, wikilink convention.
  - `docs/specs/vault-layout.md` — directory structure, ownership rules per directory.
  - `docs/specs/mcp-surface.md` — MCP tool catalog (one per SDK tool).
  - `docs/specs/cli.md` — 8-command CLI spec.
  - `docs/specs/prompts.md` — prompt library structure, override rules (SDK defaults vs per-vault overrides).
  - `docs/specs/harnesses.md` — how Claude Code, future Cursor/OpenCode/Codex, and native apps mount Dome.
- **Existing assumptions that break:**
  - `PAGES_USE_ONE_SCHEMA` (proposed in ARCHITECTURE.md `:124`) retired in favor of `PAGE_TYPE_BY_DIRECTORY`.
  - `ATOMIC_IDEAS_ARE_INTERMEDIATE` (ARCHITECTURE.md `:232`) tightened to "agent-internal; not on disk in v0.5."
  - `/wiki/inbox.md` as a destination becomes `route_sensitive_to_inbox` as a tool the agent calls; the file is still there but the routing is tool-enforced.
- **Behavior matrix impact:**
  - **Tool × invariant × enforcement-mechanism** matrix (new) — one row per tool, columns naming which invariants the tool enforces.
  - **User-intent × prompt × tool-composition** matrix (new) — captures which prompt loads for what kind of conversation, and which tools that prompt composes.
- **Invariant impact:** Nine candidate invariants to name:
  - `RAW_IS_IMMUTABLE` — write tools refuse writes to `raw/`.
  - `MARKDOWN_IS_SOURCE_OF_TRUTH` — derived indexes are rebuildable from markdown.
  - `LOG_IS_APPEND_ONLY` — `append_log` is the only mutation primitive for `log.md`.
  - `PAGE_TYPE_BY_DIRECTORY` — page type is determined by immediate subdirectory of `wiki/`; only `entities/`, `concepts/`, `sources/`, `syntheses/` allowed.
  - `SENSITIVE_GOES_TO_INBOX` — sensitive-flagged content routes through `route_sensitive_to_inbox` tool, never direct `write_page` to person/entity pages.
  - `EVERY_WRITE_IS_LOGGED` — every page mutation produces an `append_log` call within the same agent turn.
  - `WIKILINKS_ARE_FULLPATH` — `[[wiki/entities/x]]` not `[[x]]`; `wikilink_resolve` enforces.
  - `PROMPTS_ARE_CONTRACT` — system behavior changes go through prompt edits, not code edits.
  - `PAGE_CREATION_REQUIRES_RECURRENCE` — `write_page` for a new page requires a `reason: recurring | named_explicitly | structural` field, enforced at tool boundary.
- **Test guarantee impact:** New test categories required:
  - Per-tool invariant enforcement (unit tests with mocked filesystem).
  - Vault round-trip tests (write through tool → read raw markdown → re-parse).
  - MCP tool-surface tests (each MCP tool invokes its SDK tool with correct arg mapping).
  - `dome migrate` against fixture vaults (existing-vault on-ramp safety).
  - Lint-pass tests (seeded violations → expected detections).
  - Behavior eval suite (recorded representative conversations + expected page-touch assertions; catches prompt and model regressions).
- **Gotchas triggered:**
  - Multi-page transactional partial failure (agent updates pages 3-of-7, then fails). v0.5 strategy: collect-and-apply (the agent gathers all proposed writes; tool layer applies them atomically; partial failures roll back via git).
  - Out-of-band edits by Obsidian / vim writing direct to `wiki/` without going through SDK tools. v0.5 strategy: `dome doctor` detects invariant violations on next run; user owns their markdown so we don't lock.
  - Concurrent writes (two Claude Code sessions in same vault). v0.5 strategy: timestamp-based optimistic locking on `write_page`; conflict = fail with diff; user resolves.
  - Prompt / model regression after Anthropic ships a new Sonnet/Opus. v0.5 mitigation: behavior eval suite runs against fixtures; user runs after every model upgrade.
- **Locality / centralization concerns:** None significant. SDK / MCP / prompts / CLI / agent-harness cleanly separated.
- **Easy invalid change still possible:** A new contributor adds a `wiki/decisions/` directory and starts writing pages there. `PAGE_TYPE_BY_DIRECTORY` invariant + `write_page` enforcement catches at runtime; `dome doctor` catches in retrospect. Add semantic linter rule for `wiki/` subdirs.

## Architectural core (added after Phase 5 deepening)

### The four-concept core

The SDK's data layer has exactly four concepts. Everything else is a pattern built on these.

| Concept | Shape | Role |
|---|---|---|
| **Vault** | Directory + config. Knows path, allowed page types (defaults + extensions), registered hooks, plugins, enabled invariants. | The unit of "your brain." Single instance per process per path. |
| **Document** | Any markdown file in a Vault. Carries `path`, `category` (raw / wiki / log / inbox / notes / extension), `type` (entity / concept / source / synthesis / vault-extension), `frontmatter`, `body`, `links_out`. | The unifying read/write abstraction. Everything readable or writable is a Document. |
| **Tool** | Typed function over Vault + Documents. Enforces invariants at call site. Returns a Result; emits Effects (writes) and Events (hook triggers). The only legitimate mutation path. | Where invariants live. An agent that wants to violate `RAW_IS_IMMUTABLE` calls `write_page` for a raw path; the tool refuses. |
| **Hook** | Handler registered against an event pattern (`document.written`, `tool.invoked`, etc.). Observes; can propose follow-on Tool calls; cannot mutate directly. | The extension surface. Every future feature is a Hook, not a core change. |

Patterns built on the four concepts (not concepts themselves):

- **Prompts** — markdown files loaded from `dome/prompts/` (SDK defaults) and `<vault>/.dome/prompts/` (overrides). Plain text.
- **Workflows** — named (prompt, available tools, entry condition) triples. Configuration in YAML.
- **Agents** — external runtimes that compose Tools (Claude Code, Cursor; an SDK-shipped minimal Python loop for headless cases).
- **Plugins** — packages that register Tools / Hooks / page types / workflows / CLI commands via the standard plugin protocol.

### Extensibility channels (revised 2026-05-25 — intakes collapse into hooks)

1. **Hooks — with two registration forms.** Hooks observe events and may propose follow-on Tool calls; they never write directly (`HOOKS_CANNOT_BYPASS_TOOLS`). Two registration forms:
   - **Programmatic** — Python files in `<vault>/.dome/hooks/*.py` calling `register_hook(event_pattern, handler)`. For arbitrary logic.
   - **Declarative** — YAML files in `<vault>/.dome/hooks/*.yaml` declaring `event_pattern` + `workflow_name` (+ optional `path_pattern` filter). For the common pattern "when X happens, run workflow Y on the document."
   - The **drop-zone intake pattern** is a use case of declarative hooks: a hook YAML filtered on `document.written` with `path_pattern: "inbox/<bucket>/*"` that invokes a named workflow. Examples: `inbox/raw/` (generic ingest), `inbox/voice/` (transcribe + ingest), `inbox/research/` (research workflow), `inbox/clip/` (web-clip integrate), `inbox/review/` (sensitive items awaiting human — replaces `wiki/inbox.md`). `dome capture` becomes "write to `inbox/raw/<ts>.md`" — no special CLI logic needed; the declarative hook YAML does the routing.
   - Other on-write hook use cases (programmatic or declarative): auto-cross-reference, contradiction-detection, sync-trigger, notify.
2. **Custom page types.** `<vault>/.dome/page-types.yaml` extends the default four. `PAGE_TYPE_BY_DIRECTORY` becomes parametric — `write_page` accepts (default ∪ vault-extension). For the Dome project's docs vault: `spec`, `invariant`, `matrix`, `gotcha`.
3. **Per-vault overrides.** `<vault>/.dome/` mirrors SDK structure: `prompts/` overrides defaults, `hooks/` adds vault-local handlers (programmatic + declarative), `tools/` adds vault-local tools, `config.yaml` enables/disables invariants.
4. **Plugin packages.** Shipped plugins as npm packages declaring a `dome.plugins` entry in `package.json` (or a similar manifest convention TBD in spec rewrite); vault-local `.ts` / `.js` files in `.dome/hooks/` for ad-hoc extension. Protocol: `registerTools`, `registerHooks`, `registerWorkflows`, `registerPageTypes`, `registerCliCommands`.

### Hook execution model (ratified 2026-05-25)

**Async via event queue.** Hooks run in a background worker. Writes return immediately. Hook failures don't block tool calls. Tradeoff accepted: a read immediately following a write may not see hook-proposed follow-on changes yet. Sync-mode escape hatch available for testing and for hooks that must complete before user-visible state changes (e.g., a sensitivity-classifier hook that gates whether content goes to `inbox/review/` or `wiki/`).

### Docs-as-Dome (ratified 2026-05-25 — restructure now, hand-bootstrap)

This repo's `docs/` directory IS a Dome vault. Both validates the design against a real vault from day one and proves Dome's generality (project-design substrate is structurally the same problem as personal-knowledge substrate).

```
docs/                       # vault root
  VISION.md                 # vault-root special (north star)
  README.md                 # vault-root special (orient new readers)
  index.md                  # vault catalog
  log.md                    # vault activity log
  raw/                      # immutable seeds
    original-architecture.md       # was docs/ARCHITECTURE.md
    brainstorm-partner-analysis.md
    karpathy-llm-wiki-gist.md
  notes/                    # hand-written design notes
  wiki/
    entities/               # Claude Code, Obsidian, Karpathy, Anthropic, MCP, Textual, etc.
    concepts/               # llm-wiki-pattern, brain-companion, four-concept-core, hook-extensibility, drop-zone-intake, etc.
    sources/                # summaries of papers/blogs/gists read
    syntheses/              # cross-cutting design memos
    specs/                  # extension type: sdk-surface, page-schema, vault-layout, mcp-surface, cli, prompts, harnesses, hooks-and-events
    invariants/             # extension type: RAW_IS_IMMUTABLE, etc. (now 11 invariants)
    matrices/               # extension type: tool-invariant-enforcement, intent-prompt-tools, event-types-and-payloads
    gotchas/                # extension type: agent-prompt-regression, multi-page-partial-write, out-of-band-vault-edits, concurrent-harness-write, hook-cycle, async-read-after-write-staleness
  .dome/
    page-types.yaml         # declares: spec, invariant, matrix, gotcha as extension types
    config.yaml             # project-specific config
    prompts/                # project-specific prompt overrides (e.g., design-synthesis.md)
    hooks/                  # (empty for v0.5; dev repo, not personal vault) — *.py programmatic, *.yaml declarative (incl. drop-zone intakes)
```

### Updated invariants list (10 total — `INTAKES_REGISTER_DECLARATIVELY` dropped after intakes collapsed into hooks)

- `RAW_IS_IMMUTABLE` — `write_page` refuses writes to `raw/`.
- `MARKDOWN_IS_SOURCE_OF_TRUTH` — derived indexes are rebuildable from markdown.
- `LOG_IS_APPEND_ONLY` — `append_log` is the only mutation primitive for `log.md`.
- `PAGE_TYPE_BY_DIRECTORY` — page type determined by immediate subdirectory of `wiki/`; allowed = defaults ∪ vault-extension.
- `SENSITIVE_GOES_TO_INBOX` — sensitive-flagged content routes through `route_sensitive_to_inbox` tool to `inbox/review/`, never direct `write_page`.
- `EVERY_WRITE_IS_LOGGED` — every page mutation produces an `append_log` call within the same agent turn.
- `WIKILINKS_ARE_FULLPATH` — `[[wiki/entities/x]]` not `[[x]]`; `wikilink_resolve` enforces.
- `PROMPTS_ARE_CONTRACT` — system behavior changes go through prompt edits, not code edits.
- `PAGE_CREATION_REQUIRES_RECURRENCE` — `write_page` for a new page requires `reason: recurring | named_explicitly | structural`.
- **`HOOKS_CANNOT_BYPASS_TOOLS`** — hook handlers (programmatic *or* declarative) observe events and may propose follow-on Tool calls, but never write to the vault directly. All mutations flow through the Tool layer. This single invariant covers all hook registration forms including the declarative drop-zone-intake pattern.

### Updated matrices list

- `tool-invariant-enforcement` — tool × invariant × enforcement mechanism.
- `intent-prompt-tools` — user-intent × prompt-loaded × tool-composition.
- `event-types-and-payloads` (new) — event name × emitting tool × payload schema × example hook handlers.

### Updated CLI surface (likely shrinks to 4-6 commands)

Because intakes generalize quick-capture, the CLI gets smaller:

- `dome init <path>` — bootstrap a new vault.
- `dome migrate <existing-vault>` — convert an existing markdown vault to Dome shape.
- `dome serve --vault <path>` — start the MCP server + intake watcher daemon.
- `dome lint` — run lint workflow.
- `dome doctor` — diagnose invariant violations.
- `dome export-context <topic>` — produce a markdown blob for cross-AI handoff.

`dome capture` becomes a one-liner shell idiom (`echo "..." > $VAULT/inbox/raw/$(date -u +%Y%m%d-%H%M%S).md`) — no dedicated CLI surface needed. `dome inbox` opens `inbox/review/` in `$EDITOR` if we want it as a shortcut, but it's not load-bearing.

## Recommendation

**Direction:** Dome v0.5 = a TypeScript SDK (Node.js 22+ or Bun, TBD) with a four-concept core (Vault, Document, Tool, Hook) and four extensibility channels (hooks with both programmatic and declarative registration forms — drop-zone intakes being the most common declarative use case; custom page types; per-vault overrides; plugin packages). Tools enforce 10 named invariants at call site; hooks run async via event queue. MCP server makes Claude Code (and any MCP-capable harness) Dome-aware. Small CLI (4-6 commands) for side-doors. No proprietary UI in v0.5; the mass-market mobile/web product (v1+) ships proprietary clients over the same SDK contract. The project's own `docs/` is restructured as a Dome vault — dogfood from day one, proof of generality.

**Main risk:** Agent orchestration owns the page-write flow; a prompt regression or model-behavior drift can produce semantically-wrong page updates that pass structural invariants (e.g., updating the wrong person's page with content of the right shape).

**Structural mitigation:** Five-layer defense — (1) every SDK tool enforces its invariants at call site; (2) every write goes through `append_log` with diff captured; (3) vault is git-backed so `git revert` is universal undo; (4) `dome lint` runs a prompt-checked drift pass detecting orphans, missing cross-refs, and contradictions; (5) a behavior eval suite of representative captures + expected-page-touch assertions catches prompt and model regressions before they affect a live vault.

**Required substrate before implementation:**

- **Specs:**
  - `docs/VISION.md` (this session)
  - `docs/specs/sdk-surface.md`
  - `docs/specs/page-schema.md`
  - `docs/specs/vault-layout.md`
  - `docs/specs/mcp-surface.md`
  - `docs/specs/cli.md`
  - `docs/specs/prompts.md`
  - `docs/specs/harnesses.md`
- **Matrices:**
  - `docs/substrate/matrices/tool-invariant-enforcement.md`
  - `docs/substrate/matrices/intent-prompt-tools.md`
- **Named invariants:** Nine, listed in Breakage Analysis above.
- **Tests / checks:**
  - Per-tool invariant unit tests (planned, not v0.5 blocker).
  - Vault round-trip integration tests.
  - MCP surface tests.
  - `dome migrate` fixture tests.
  - Behavior eval suite (small in v0.5; the schema for it is load-bearing).
- **Gotchas (to write as docs after spec rewrite):**
  - `docs/substrate/gotchas/agent-prompt-regression.md`
  - `docs/substrate/gotchas/multi-page-partial-write.md`
  - `docs/substrate/gotchas/out-of-band-vault-edits.md`
  - `docs/substrate/gotchas/concurrent-harness-write.md`
- **Semantic linters (proposed):**
  - `dome-lint-wiki-subdirs` — reject new top-level `wiki/<subdir>/` that isn't one of the four allowed types.
  - `dome-lint-wikilink-fullpath` — fail builds that introduce `[[shorthand]]` wikilinks.
  - `dome-lint-write-without-log` — fail when a write tool is called without a corresponding `append_log` in the same agent turn.

### Next

Lock the direction into specs by rewriting the docs into a Dome-shaped `docs/` vault. *(`cohesive:rewrite-specs`.)* **Files to edit:** (1) Bootstrap the vault structure — create `docs/{raw,notes,wiki/{entities,concepts,sources,syntheses,specs,invariants,matrices,gotchas}}/`, `docs/.dome/{page-types.yaml,config.yaml,prompts/,intakes/}`, `docs/{index.md,log.md}`; (2) move `docs/ARCHITECTURE.md` → `docs/raw/original-architecture.md` (preserve as immutable seed); (3) write 8 spec docs at `docs/wiki/specs/` (sdk-surface, page-schema, vault-layout, mcp-surface, cli, prompts, harnesses, hooks-and-events); (4) write 11 named-invariant docs at `docs/wiki/invariants/`; (5) write 3 matrices at `docs/wiki/matrices/`; (6) write 6 gotcha docs at `docs/wiki/gotchas/`; (7) seed initial wiki content — entities (Claude Code, Anthropic, MCP, Obsidian, Karpathy), concepts (llm-wiki-pattern, brain-companion, four-concept-core, hook-extensibility, drop-zone-intake), syntheses (why-dome-is-not-mem-tana-granola); (8) update `docs/VISION.md` to reference the four-concept core and extensibility ethos as durable claims. Slug: `dome-v0.5-foundation`. Classification: Pure design (no implementation in this rewrite — the SDK code is the next chain after Lock).
