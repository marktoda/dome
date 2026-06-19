---
type: spec
created: 2026-05-27
updated: 2026-06-12
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
  - "[[v1]]"
  - "[[wedge]]"
description: "dome mcp stdio adapter: eight typed tools mirroring CLI --json documents over shared collectors; engine import graph stays MCP-free"
---

# MCP surface

This spec is normative for Dome's MCP (Model Context Protocol) adapter — the `dome mcp` stdio server. The MCP server is **one protocol adapter** over the same runtime/view boundary the CLI consumes (per [[wiki/matrices/protocol-adapter]]), expressed in MCP wire format.

## Status

**Shipped** as wedge Phase 5 ([[wedge]] §"Phase 5 — MCP server"). The compiler-boundary contract per [[wiki/specs/harnesses]] (CLAUDE/AGENTS orientation + CLI + compiler host + adopted ref) remains the load-bearing path for harnesses with full shell access; the MCP server is the typed front-end contract for everything else. It earns its keep in three scenarios:

1. **Harnesses without robust shell-execution.** A sandboxed agent that cannot invoke `Bash` reaches Dome via typed MCP tools instead.
2. **Flows that benefit from typed argument validation.** MCP routes the same operations with Zod-validated structured inputs instead of CLI argument strings.
3. **MCP as the universal front-end contract** (per [[wedge]]): every future surface — voice, phone, other agents — is a thin client over the same tool set.

## Architecture

```text
@dome/sdk core (engine + projections + ledger + outbox)
  ↓  (the same shared dispatch boundary the CLI uses)
src/surface/* collectors + src/engine/host/view-command.ts
  ↓
src/mcp/server.ts — createDomeMcpServer({ vaultPath, bundlesRoot }) → McpServer
  ↓
dome mcp   (stdio transport; one vault per process)
```

The adapter is deliberately thin and **consumes data-returning boundaries — it does not duplicate logic and it never captures console output**:

- `capture` calls `performCapture` (the data core behind `dome capture`) and renders the shared `dome.capture/v1` document via `captureJsonDocument`.
- `query` / `export_context` / `tasks` dispatch their view processors through the public `vault.runView` surface (`openVault` → `src/engine/host/view-command.ts`), with the same expected-view/schema validation the CLI wrappers enforce.
- `status` / `check` call `buildStatusSnapshot` / `buildCheckReport` (the data collectors behind `dome status --json` / `dome check --json`) and return the identical documents.
- `resolve` calls `vault.resolve` (durable answer + answer-handler dispatch — the same path as `dome resolve`) and renders `dome.answer/v1` via the shared `src/surface/answer.ts` mappers.
- `brief` runs the today view to locate the daily note (config-aware path template), then reads its content at the adopted commit via the git read boundary.

Nothing in a tool call prints, so stdout stays exclusively the MCP protocol channel — load-bearing for a stdio server. A tool mutex still serializes calls: each call opens and closes its own `Vault`/runtime exactly like one CLI invocation, so at most one set of SQLite handles is open against the vault at a time and none is held between calls.

The planned `AbstractSurface` + `renderMcp(surface)` split ([[wiki/specs/sdk-surface]] §"Consumer surfaces") remains the target internal shape. The shipped adapter consumes `openVault` plus the protocol-neutral collectors in `src/surface/` — the home of the v1 surface contract (the `dome.<verb>/v1` schemas); it imports nothing from `src/cli/` per [[wiki/linters/surface-adapters-dont-import-adapters]]. When `AbstractSurface` lands, the adapter swaps its internals without changing the tool contract.

### Dependency fence

`@modelcontextprotocol/sdk` ships in `package.json`, but the engine never sees it: `src/mcp/` is a companion entrypoint (exposed as `@dome/sdk/mcp` and the `dome mcp` verb) that is **not** reachable from the static import graph of `src/index.ts`, and the CLI dispatcher loads `src/cli/commands/mcp.ts` via dynamic import so the CLI's static graph stays MCP-free too. Pinned by [[wiki/invariants/ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY]] (the fence is the core entrypoint's static import graph) and [[wiki/gotchas/transitive-llm-dependency]] (the bundle-deps test catches re-exports that would defeat the separation).

## MCP tools

MCP tool names are bare verbs — harness clients already namespace by server name (Claude Code exposes them as `mcp__dome__capture` etc.). MCP tool results mirror the JSON the CLI's `--json` mode emits; there is no parallel schema catalog.

| MCP tool | Same path as | Result schema | Purpose |
|---|---|---|---|
| `capture` | `dome capture --json` | `dome.capture/v1` | Write a thought into `inbox/raw/` and commit it on the current branch. |
| `query` | `dome query --json` | `dome.search.query/v1` | FTS + structured query against adopted state, with SourceRefs. |
| `export_context` | `dome export-context --json` | `dome.search.export-context/v1` | Portable source-backed context packet for a topic. |
| `status` | `dome status --json` | status snapshot (stable keys) | Vault pulse: attention codes, `next_actions`, serve state, counts. |
| `check` | `dome check --json` | `dome.check/v1` | Explain attention: engine health, content diagnostics, open decisions. |
| `resolve` | `dome resolve --json` | `dome.answer/v1` | Answer a Dome-raised question by id; omit `value` to read the question. |
| `tasks` | `dome run today --json` | `dome.daily.today/v1` | Source-backed open loops / followups / questions for a day. |
| `brief` | today view + adopted-commit read | `dome.mcp.brief/v1` | Today's daily note content — the morning-brief read surface. |

### Input schemas

Zod raw shapes, summarized:

```yaml
capture:        { text: string (required), title?: string }
query:          { text: string (required), limit?: int>0, category?: string, type?: string }
export_context: { topic: string (required), limit?: int>0 }
status:         {}
check:          { engine?: bool, content?: bool, decisions?: bool, attention?: bool, limit?: int>0 }
resolve:        { id: int>0 (required), value?: string }
tasks:          { date?: "YYYY-MM-DD", limit?: int>0 }
brief:          { date?: "YYYY-MM-DD" }
```

### Result envelope

Every tool returns one `text` content block containing the JSON document the corresponding CLI `--json` invocation prints. A non-zero handler exit code maps to `isError: true` with the handler's JSON error payload (the CLI emits structured error objects under `--json`), so clients see the same error vocabulary the CLI uses.

### `brief` (`dome.mcp.brief/v1`)

The only MCP-minted schema — a thin composition of two existing read paths:

```yaml
schema: dome.mcp.brief/v1
date: "YYYY-MM-DD"          # the requested or local-today date
path: wiki/dailies/<date>.md # config-aware daily path (dome.daily template)
exists: boolean              # whether the daily note exists in adopted state
content: string | null       # the note body at the adopted commit
counts: { openTasks, followups, questions }  # from dome.daily.today
```

`content` is read at the **adopted commit**, not the working tree — the brief is an adopted-state surface like every other read tool.

## Writes and lifecycle

The MCP server is a **read/capture surface over an existing vault** (no hosted model — the MCP surface brings typed tools for harnesses that already carry their own agent; the HTTP surface's `POST /agent` is the co-located agent path). It runs no adoption loop, no scheduler, and no garden processors — the daemon (`dome serve`, kept alive by `dome install`, per [[wedge]] §"Phase 1") owns compilation. The two write-shaped tools reuse existing non-engine write channels unchanged:

- **`capture`** lands an ordinary human commit via the same single-file commit path as `dome capture` (no `Dome-*` trailers; the daemon constructs the Proposal from branch drift, per [[wiki/invariants/PROPOSALS_ARE_THE_ONLY_WRITE_PATH]]). The payload's `compile_pending` / `serve_status` fields tell the caller whether a daemon will pick it up.
- **`resolve`** records an answer durably in `answers.db` and dispatches answer handlers via the identical `answerQuestionDurably` path `dome resolve` uses.

An earlier draft of this spec said "no write tools." Wedge Phase 5 deliberately amends that: `capture` and `resolve` are the validated wedge loop's ingress and decision channels, both already designed as non-engine write paths, and an MCP server launched locally by the vault owner sits in the same trust domain as the owner's CLI.

**Composition with `dome serve`:** run both. The MCP server gives an agent typed read/capture access; the daemon compiles what the agent captures. Captures and resolutions made over MCP are durable immediately and compile on the daemon's next tick (or the next `dome sync`). The MCP server stays correct with no daemon running — reads serve the last-adopted state and `capture` reports `compile_pending: true` — it just goes stale.

**Mount lifecycle:** `dome mcp` validates the vault (git repo + `.dome/config.yaml`), builds the server, and serves stdio until the client disconnects. Disconnect detection watches stdin `end`/`close` directly — the SDK's `StdioServerTransport` fires `onclose` only from an explicit `close()`, never from stdin EOF — and the shutdown handlers are registered before `connect()` so an instant disconnect cannot race them and hang the process. Per tool call, the underlying handler opens and closes its own runtime; shutdown therefore needs no drain. Single-vault per process — multi-vault setups run one `dome mcp` per vault. The tool-execution mutex (one runtime open at a time; the MCP SDK does not serialize overlapping tool calls) is per-server closure state, not module state, so two servers in one process don't share it.

## Registration recipe (Claude Code)

```bash
claude mcp add dome -- dome mcp --vault /path/to/vault
```

Or in `.mcp.json` / project MCP config:

```json
{
  "mcpServers": {
    "dome": {
      "command": "dome",
      "args": ["mcp", "--vault", "/path/to/vault"]
    }
  }
}
```

The server's `instructions` field carries cold-start orientation (the daily loop, which tool to reach for, the capture→brief contract), so a fresh session can use the vault without reading this spec.

## What the MCP server does not have

To keep the surface minimal:

- **No engine control.** No `sync`, `serve`, `init`, `install`, `rebuild` tools. Daemon lifecycle and adoption catch-up stay CLI/git-native.
- **No document mutation beyond `capture`'s inbox ingress.** No `write_document`, no `move_document`, no `delete_document`. External writes are git-native. This is also why `tasks` is list-only: settling a task is a markdown edit (check the box, commit), and no existing non-engine write channel covers targeted document edits. A `tasks settle` verb waits for a designed write path, not an ad-hoc one.
- **No privileged operations.** No way to advance the adopted ref, bypass capability checks, or write the projection store.
- **No engine-internal queries.** No run-ledger access (use `dome inspect runs` when needed).
- **No multi-vault routing.** One vault per server process.
- **No MCP resources or prompts in v1.** The `dome://page/<path>` / `dome://search?q=` resource URI map from the earlier draft remains target work for the `AbstractSurface.readResource` era; tools cover the wedge surface.
- **No remote transport, and no per-device tokens.** v1 `dome mcp` is stdio-only: the server is launched locally by the vault owner and inherits the owner's trust domain (above), so it carries no network auth of its own. The remote MCP transport (streamable-HTTP / `mcp-remote` bridge over a bearer token) is deferred per [[cohesive/brainstorms/2026-06-11-dome-v1-plan]] §WS3, and so is per-device token issuance/rotation — single shared bearer is the v1 contract for the network surfaces, recorded normatively at [[wiki/specs/http-surface]] §"One shared bearer token (the v1 contract)". Issuance/rotation lands with or before remote MCP, the multi-device driver.

## Related

- [[wedge]] §"Phase 5 — MCP server" — why this shipped and the acceptance bar.
- [[wiki/specs/cli]] §"dome mcp" — the CLI verb that hosts the server.
- [[wiki/specs/sdk-surface]] §"Consumer surfaces" — the planned AbstractSurface this adapter will converge with.
- [[wiki/specs/harnesses]] — when MCP earns its keep vs the CLI path.
- [[wiki/specs/capture]] — the capture loop the `capture` tool feeds.
- [[wiki/specs/processors]] §"Phase × trigger matrix" — `query`/`export_context`/`tasks` invoke command-triggered view-phase processors.
- [[wiki/invariants/ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY]] — core/MCP separation.
- [[wiki/gotchas/transitive-llm-dependency]] — the dep-fence that catches MCP leak into core.
- [[wiki/matrices/protocol-adapter]] — MCP as one row in the protocol-adapter map.
