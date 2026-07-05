---
type: matrix
created: 2026-05-27
updated: 2026-07-02
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
  - "[[wiki/specs/task-lifecycle]]"
description: Crosses operations (capture, query, read, resolve...) with consumer surfaces (CLI/MCP/HTTP/voice), showing what each protocol exposes in v1.
---

# Protocol adapter matrix

Per-protocol map of how consumer surfaces (CLI, MCP, HTTP, future voice /
web) project from the same runtime/view boundary (per
[[wiki/specs/sdk-surface]] §"Consumer surfaces"). The CLI is shipped; the
MCP server shipped as wedge Phase 5 (`dome mcp`, [[wiki/specs/mcp-surface]]);
the HTTP surface shipped as the converged read+capture+converse+agent adapter (`dome http`,
[[wiki/specs/http-surface]]). The protocol adapters consume the public
`openVault` wrapper plus the CLI's data-returning collectors, so every
surface emits the same `dome.<verb>/v1` JSON. `AbstractSurface` remains the
planned internal aggregation. Engine-control operations such as `sync`
remain CLI-only in v1.

## The matrix

| Operation | AbstractSurface API (planned) | CLI (v1, primary) | MCP (shipped, wedge P5) | HTTP (shipped, converged) | Voice (v2, designed-for) |
|---|---|---|---|---|---|
| **Capture into inbox** | n/a (git-native ingress, not AbstractSurface) | `dome capture` | `capture` tool | `POST /capture` (shipped; `capture` capability) | Voice memo → transcription → `capture` |
| **Query adopted state** | `surface.query(input)` | `dome query <text>` | `query` tool | `GET /query?text=...` (shipped; `read` capability) | Speech-to-text query, response rendered as audio |
| **Export context packet** | `surface.commands["export-context"]` | `dome export-context <topic>` | `export_context` tool | `GET /context/<topic>` | n/a |
| **Read document** | `surface.read(path)` | `dome cat <path>` (deferred to v1.1; today: file read) | `brief` tool (daily note only; generic read deferred) | `GET /doc?path=...` (shipped; `read` capability; adopted ref) | "Read me my notes about X" |
| **Resolve wikilink** | `surface.resolveWikilink(link)` | n/a (not a CLI surface) | n/a (deferred with AbstractSurface) | `GET /wikilinks/<link>` | n/a |
| **Run command processor / today view** | `surface.commands.<name>.invoke(args)` | Dedicated commands (`dome query`, `dome export-context`) plus hidden compatibility/debug commands (`dome lint`, daily wrappers, `dome run <name>`) | `tasks` tool (the `today` view); other views not protocol-routed in v1 | `GET /tasks` (the `today` view; `read` capability; generic `POST /commands/<name>` v2+) | Voice command → command processor (query / export-context / future typed views) |
| **Cockpit HTML page** | n/a | `dome today --watch` | n/a | `GET /today` (shipped; renders `dome.daily.today` as phone-friendly HTML; `read` capability; `?token=` escape for browser nav) | n/a |
| **Hosted agent (converse)** | n/a (surface-level, not AbstractSurface) | n/a | n/a (MCP harnesses bring their own agent) | `POST /agent` (non-streaming; `converse` capability; `dome.ask/v1`), `POST /agent/stream` (SSE; same capability) — enabled by default; writes gated by `author` capability (`--allow-write`) | n/a |
| **Transcribe audio** | n/a | n/a | n/a | `POST /transcribe` (audio body; shell command or OpenAI-compatible cloud STT; `capture` capability; `dome.transcribe/v1`; 501 when unconfigured) | Native (voice client handles STT locally) |
| **Recent vault changes** | n/a | n/a | n/a | `GET /recents` (shipped; `read` capability; `dome.recents/v1`) | n/a |
| **Read resource** | `surface.readResource(uri)` | n/a (CLI reads paths, not URIs) | not shipped (deferred with AbstractSurface; tools cover the wedge surface) | `GET /<uri>` | n/a |
| **Get instructions** | `surface.instructions` | `dome inspect instructions` (v1.x subject) | `serverInfo.instructions` (shipped) | `GET /instructions` | Read at session start by voice client |
| **Get adoption status / attention** | `vault.getAdoptionStatus()` (engine, not AbstractSurface) | `dome status --json` / `dome check --json` | `status` / `check` tools | `GET /status` (shipped; `read` capability; `check` route v2+) | n/a |
| **Resolve a Dome question** | (engine, not AbstractSurface) | `dome resolve <id> [<value>]` | `resolve` tool | `GET /questions` + `POST /resolve` (shipped; `resolve` capability) | n/a |
| **Settle a task (by `^block-anchor`)** | n/a (git-native commit-or-nothing seam, not AbstractSurface) | `dome settle <block-id> <close\|defer\|keep> [--until <date>]` | `settle` tool | `POST /settle` (shipped; `resolve` capability — settling is a decision, same trust domain as resolve) | "Mark that done" / "push that to next week" |
| **Rebuild projection** | `vault.rebuild()` (engine) | `dome rebuild` | n/a (engine control, not exposed via MCP) | `POST /rebuild` (auth-gated in hosted mode) | n/a |
| **Engine control (sync, init, serve, advanced detail)** | (engine, not AbstractSurface) | `dome sync`, `dome init`, `dome serve`/`install`, plus advanced `dome inspect` / `dome doctor` / `dome answer` | n/a (engine control surface is CLI-only) | (hosted-only; v2+) | n/a |

## Architectural shape

```text
@dome/sdk core (engine + processors + projections + ledger + outbox)
  ↓
buildAbstractSurface(vault) → AbstractSurface (planned)
  ↓
@dome/sdk/cli         current direct runtime dispatch; future renderCli(surface, argv)
@dome/sdk/mcp         shipped: src/mcp/server.ts over openVault + collectors
                      (dome mcp, stdio); future renderMcp(surface)
@dome/sdk/http        shipped: src/http/server.ts over openVault + collectors
                      (dome http, Bun.serve); future renderHttp(surface)
@dome/sdk/voice (v2)  renderVoice(surface)          → voice handler
```

Each future renderer should be a *thin* protocol adapter — typically 100–200
lines. It maps protocol-specific input shapes to AbstractSurface calls and
translates AbstractSurface output to protocol-specific responses. The engine
work happens once, at the AbstractSurface boundary; renderers don't re-implement
query or command logic.

## Why the split

Three properties:

1. **Adding a new protocol is one file.** A v2 GraphQL adapter ships as `renderGraphql(surface)` in `@dome/sdk/graphql` — no changes to the engine, no changes to existing renderers.
2. **Engine has no transitive dependency on protocol packages.** Pinned by [[wiki/invariants/ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY]] — `@dome/sdk` core doesn't import `@modelcontextprotocol/sdk`; the shipped MCP companion (`src/mcp/`, reached only via the `dome mcp` verb's dynamic import) does.
3. **Multi-surface coherence is structural.** Mobile, desktop, voice clients should all consume `AbstractSurface` via direct SDK import once that boundary ships. They construct their own UX over the same query / read / commands surface, while write/adoption flows remain Git-native — without per-shell back-and-forth at the engine.

## CLI as the v1 primary

The CLI is the v1 primary surface for agentic harnesses per [[wiki/specs/harnesses]] §"The compiler-boundary contract". The MCP server (`dome mcp`) ships as the additive typed surface for harnesses that prefer MCP routing — or cannot shell out — but the SDK's value-prop and Claude Code's usage pattern don't depend on MCP.

HTTP and Voice are designed-for in the AbstractSurface shape but not shipped in v1 — they ship when the native-shell roadmap reaches them.

## What goes only on the CLI surface

Three operations are CLI-only in v1 by deliberate scope:

- **`dome init`** — vault construction is interactive and one-time; doesn't benefit from protocol-routing.
- **`dome serve`** — daemon lifecycle is OS-process-level; not a Submit/Recall operation.
- **`dome doctor --repair`** (v1.x reserved flag) and **`dome answer <id>`** — vault-maintenance and the advanced answer channel are administrative; protocol-routing them could create accidental remote-administrator footguns. `dome resolve` *is* exposed as the MCP `resolve` tool (wedge Phase 5): a locally-launched stdio server runs in the vault owner's own trust domain, the wedge's question-throughput loop needs a one-tap resolution surface, and the tool reuses the identical `answers.db` path. The footgun concern stays live for *remote* protocols — HTTP keeps resolve hosted-only.

The hosted-protected v1.5 mode may expose `init`/`serve`/`doctor` over HTTP with auth gating; v1 keeps them CLI-only.

## Related

- [[wiki/specs/sdk-surface]] §"Consumer surfaces"
- [[wiki/specs/harnesses]]
- [[wiki/specs/cli]]
- [[wiki/specs/mcp-surface]]
- [[wiki/invariants/ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY]]
- [[wiki/gotchas/transitive-llm-dependency]]
