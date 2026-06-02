---
type: matrix
created: 2026-05-27
updated: 2026-05-29
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
---

# Protocol adapter matrix

Per-protocol target map of how consumer surfaces (CLI, MCP, future HTTP /
voice / web) project from the planned `AbstractSurface` (per
[[wiki/specs/sdk-surface]] §"Consumer surfaces"). The CLI is shipped and
routes directly through the runtime today; MCP and `AbstractSurface` remain
additive target specs, not v1 acceptance gates. Engine-control operations such
as `sync` remain CLI-only in v1.

## The matrix

| Operation | AbstractSurface API | CLI (v1, primary) | MCP (target, additive) | HTTP (v2, designed-for) | Voice (v2, designed-for) |
|---|---|---|---|---|---|
| **Query adopted state** | `surface.query(input)` | `dome query <text>` | `dome.query` tool | `GET /query?q=...` | Speech-to-text query, response rendered as audio |
| **Read document** | `surface.read(path)` | `dome cat <path>` (deferred to v1.1; today: file read) | `dome.read_document` tool | `GET /documents/<path>` | "Read me my notes about X" routed through `dome.read_document` |
| **Resolve wikilink** | `surface.resolveWikilink(link)` | n/a (not a CLI surface) | `dome.resolve_wikilink` tool | `GET /wikilinks/<link>` | n/a |
| **Run command processor** | `surface.commands.<name>.invoke(args)` | Dedicated commands (`dome query`, `dome export-context`) plus hidden compatibility/debug commands (`dome lint`, daily wrappers, `dome run <name>`) | `dome.run_command` tool | `POST /commands/<name>` | Voice command → command processor (query / export-context / future typed views) |
| **Read resource** | `surface.readResource(uri)` | n/a (CLI reads paths, not URIs) | MCP resources at `dome://<scheme>/<path>` | `GET /<uri>` | n/a |
| **Get instructions** | `surface.instructions` | `dome inspect instructions` (v1.x subject) | MCP `serverInfo.instructions` | `GET /instructions` | Read at session start by voice client |
| **Get adoption status / attention** | `vault.getAdoptionStatus()` (engine, not AbstractSurface) | `dome status --json` / `dome check --json` | `dome://status` resource | `GET /status` | n/a |
| **Rebuild projection** | `vault.rebuild()` (engine) | `dome rebuild` | n/a (engine control, not exposed via MCP in v1) | `POST /rebuild` (auth-gated in hosted mode) | n/a |
| **Engine control (sync, init, resolve, advanced detail)** | (engine, not AbstractSurface) | `dome sync`, `dome init`, `dome resolve <id>`, plus advanced `dome inspect` / `dome doctor` / `dome answer` | n/a (engine control surface is CLI-only) | (hosted-only; v2+) | n/a |

## Architectural shape

```text
@dome/sdk core (engine + processors + projections + ledger + outbox)
  ↓
buildAbstractSurface(vault) → AbstractSurface (planned)
  ↓
@dome/sdk/cli         current direct runtime dispatch; future renderCli(surface, argv)
@dome/sdk/mcp         renderMcp(surface)            → MCP server (planned)
@dome/sdk/http (v2)   renderHttp(surface)           → HTTP handler
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
2. **Engine has no transitive dependency on protocol packages.** Pinned by [[wiki/invariants/ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY]] — `@dome/sdk` core doesn't import `@modelcontextprotocol/sdk`; a planned MCP companion would.
3. **Multi-surface coherence is structural.** Mobile, desktop, voice clients should all consume `AbstractSurface` via direct SDK import once that boundary ships. They construct their own UX over the same query / read / commands surface, while write/adoption flows remain Git-native — without per-shell back-and-forth at the engine.

## CLI as the v1 primary

The CLI is the v1 primary surface for agentic harnesses per [[wiki/specs/harnesses]] §"The compiler-boundary contract". MCP is preserved as an additive target surface for harnesses that prefer typed MCP routing, but the SDK's value-prop and Claude Code's usage pattern don't depend on MCP.

HTTP and Voice are designed-for in the AbstractSurface shape but not shipped in v1 — they ship when the native-shell roadmap reaches them.

## What goes only on the CLI surface

Three operations are CLI-only in v1 by deliberate scope:

- **`dome init`** — vault construction is interactive and one-time; doesn't benefit from protocol-routing.
- **`dome serve`** — daemon lifecycle is OS-process-level; not a Submit/Recall operation.
- **`dome doctor --repair`** (v1.x reserved flag) and **`dome resolve <id>` / `dome answer <id>`** — vault-maintenance and operational-decision channels are administrative; protocol-routing them could create accidental remote-administrator footguns.

The hosted-protected v1.5 mode may expose `init`/`serve`/`doctor` over HTTP with auth gating; v1 keeps them CLI-only.

## Related

- [[wiki/specs/sdk-surface]] §"Consumer surfaces"
- [[wiki/specs/harnesses]]
- [[wiki/specs/cli]]
- [[wiki/specs/mcp-surface]]
- [[wiki/invariants/ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY]]
- [[wiki/gotchas/transitive-llm-dependency]]
