---
type: matrix
created: 2026-05-27
updated: 2026-07-11
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
  - "[[wiki/specs/task-lifecycle]]"
  - "[[wiki/specs/agent-host]]"
description: Crosses Dome operations with the protocol adapters and the replaceable foreground-agent seam.
---

# Protocol adapter matrix

CLI, MCP, and HTTP are transports over the same `Vault` and `src/surface/`
operation boundaries. They are not separate engines. `AgentRuntime` is a
different seam: it owns conversational sessions and gives an agent access to
the same vault operations (or, in an external harness, the native filesystem
and CLI).

There is no `AbstractSurface` aggregation. Shared behavior is extracted as a
small operation when two real adapters need it; protocol-only mechanics stay
in the adapter.

## The matrix

| Operation | Core/shared seam | CLI | MCP | HTTP | Built-in agent |
|---|---|---|---|---|---|
| Capture | `performCapture` | `dome capture` | `capture` | `POST /capture` | `capture_note` |
| Discover plugin views | `Vault.listViews` / `collectViews` | `dome views` | `views` | `GET /views` | commands injected into charter |
| Invoke any plugin view | `runInstalledView` → `Vault.runView` | `dome run <command>` | `run_view` | `POST /views/:command` | `run_view` |
| Query adopted state | `dome.search` view | `dome query` | `query` | `GET /query` | generic `run_view` |
| Export context | `dome.search` view | `dome export-context` | `export_context` | — | generic `run_view` |
| Read an adopted document | `Vault.readDocument` / exact adopted-source reader | native file read (or future `cat`) | daily `brief` only | `GET /doc`; exact citation `GET /source?path&commit` | `read_document` |
| Status / attention | `Vault.attention` + status/check collectors | `dome status` / `dome check` | `attention` / `status` / `check` | `GET /attention`, `GET /status` | action tools as needed |
| Resolve a question | `Vault.resolve` | `dome resolve` | `resolve` | `POST /resolve` | `resolve_question` |
| Investigate agent work | `Vault.agentWork/completeAgentWork` + `attemptAgentWork` | `dome agent-work` | `agent_work` / `complete_agent_work` | `GET /agent-work`, `POST /agent-work/complete`, `POST /agent-work/drain` | `list_agent_work` / `complete_agent_work` |
| Settle a task | `performSettle` | `dome settle` | `settle` | `POST /settle` | `settle_task` |
| Review proposals | proposal collectors | `dome proposals/apply/reject` | `proposals` / `apply_proposal` / `reject_proposal` | `GET /proposals`, `POST /apply`, `POST /reject` | same three action tools |
| Converse | `AgentRuntime` (outside engine) | external harness such as Claude Code | harness brings its own agent | session protocol: create / message SSE / close | provider adapter behind `AgentRuntime` |
| Engine control | `Vault.sync/rebuild` + host internals | `dome sync/serve/rebuild` | — | — | — |

## Boundary rules

- `Vault` is the in-process compiler handle. New in-process clients start
  there.
- `src/surface/` owns shared operations and stable documents, not transport
  concepts. Adapters own argv, auth, status codes, SSE, and MCP registration.
- A plugin adds read capability by registering a command-triggered view
  processor. Discovery and generic invocation make it available to CLI, MCP,
  HTTP, and the built-in agent without editing those adapters.
- Direct deterministic operations remain first class. A client should not
  invoke an LLM merely to capture, read status, settle a known task, or run a
  known view.
- Engine control remains local/CLI-oriented. Remote protocols do not become
  administrators by accident.
- The engine imports no agent, HTTP, or MCP package. Protocol and provider
  dependencies point inward toward `Vault` and operations, never the reverse.

## Related

- [[wiki/specs/sdk-surface]] §"Consumer surfaces: operations, not an aggregate object"
- [[wiki/specs/agent-host]]
- [[wiki/specs/harnesses]]
- [[wiki/specs/cli]]
- [[wiki/specs/mcp-surface]]
- [[wiki/specs/http-surface]]
- [[wiki/invariants/ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY]]
