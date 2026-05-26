---
type: matrix
created: 2026-05-26
updated: 2026-05-26
sources: ["[[cohesive/reviews/2026-05-26-dome-v0.5-cohesion-architecture-review-pass-2]]"]
---

# Consumer surface matrix

The canonical map of "what each consumer shell imports from the `@dome/sdk` package family." Rows are consumer shells (v0.5-shipped and v1+ anticipated); columns are exported symbol families. Each cell names the entrypoint the consumer reaches the symbol through, or marks the symbol unused for that shell.

The matrix is the structural realization of [[wiki/invariants/CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY]]: every cell that reads `core` carries no transitive Anthropic/MCP dependency; every cell that reads `workflows` or `mcp` opts into that dep explicitly.

The matrix also realizes the two-layer aggregation introduced in [[wiki/specs/sdk-surface]] §"Consumer surfaces": **`AbstractSurface`** (protocol-agnostic, in core) + **per-protocol renderers** (`renderMcp` in mcp; future `renderHttp` in http; future `renderVoice` in voice). A consumer that aggregates the four kinds (tools, prompts, resources, instructions) for one consumer reaches the abstract layer through `core` and the protocol-specific rendering through the protocol's entrypoint.

## Entrypoint legend

- `core` — `@dome/sdk` (the package root: `src/index.ts`). No LLM, no MCP. Carries `AbstractSurface`, `buildAbstractSurface(vault)`, `PromptDescriptor`, `ResourceDescriptor`.
- `workflows` — `@dome/sdk/workflows`. Carries `@ai-sdk/anthropic` + `ai`.
- `mcp` — `@dome/sdk/mcp`. Carries `@modelcontextprotocol/sdk`. Carries `renderMcp(surface)`, `McpSurface`, `ToolAdapter`, `McpPromptAdapter`, `ResourceAdapter`, `DomeMcpServer`.
- `cli` — `@dome/sdk/cli`. Carries `commander`.
- `core + <entrypoint>` — **compound cell.** The consumer reaches the symbol through more than one entrypoint (e.g., `AbstractSurface` from core + `renderMcp` from mcp). The bundling-axiom test treats each named entrypoint as a separate transitive-dep contributor: a compound `core + mcp` cell pulls the MCP deps; `core + workflows` pulls the LLM deps. A cell labeled just `core` must reach its symbol through `core` *only*.
- `—` — symbol unused by this shell.
- Speculative entrypoints (`future-http`, `future-voice`) appear inline as non-normative annotations only — they are not in the legend; they ride as parenthetical hints in cell text where the future surface is anticipated.

## Matrix

| Consumer shell ↓ \ Symbol family → | Vault (`openVault`, `Vault`) | Document (`makeDocument`) | Tools (`readDocument` … `deleteDocument`, `BoundToolSurface`) | Hook (`HookRegistry`, `HookDispatcher`, `HookContext`) | Reconcile + Watcher | Privileged writer (internal — `vault.rebuildIndex` seam only) | AI-SDK ToolSet (`projectAiSdk`) | Workflow runner (`runWorkflow`, `WorkflowRegistry`, `PromptLoader`) | AbstractSurface (`buildAbstractSurface`, `PromptDescriptor`, `ResourceDescriptor`) | Protocol renderer (`renderMcp`; future `renderHttp`, `renderVoice`) | `DomeMcpServer` | CLI shell (`runCli`, `dome*` commands, `CliError`, `renderCliError`) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **CLI** (v0.5 — `dome` binary) | `core` | `core` | `core` (via `vault.tools`) | `core` (event projection, hook quarantine) | `core` (reconcile + watcher) | `core` (`vault.rebuildIndex`) | `workflows` (for `dome lint` / `migrate` / `export-context`) | `workflows` | — | — | — | `cli` |
| **MCP server** (v0.5 — invoked by `dome serve`) | `core` | `core` | `core` (via `surface.tools`, which is `vault.tools`) | `core` | `core` (reconcile at startup) | — | — | `workflows` (the MCP server exposes Dome's workflows as MCP prompts; their resolution needs the workflow registry) | `core` (the server's `surface` argument is built via `buildAbstractSurface`) | `mcp` (`renderMcp(surface)` produces the `McpSurface` the server consumes) | `mcp` | — |
| **Headless agent loop** (v0.5 — invoked by intake hooks + `dome lint`) | `core` | `core` | `core` (via `vault.tools`) | — | — | — | `workflows` (`projectAiSdk(vault)` produces the AI-SDK tool set) | `workflows` (`runWorkflow` IS this loop) | — | — | — | — |
| **Future mobile** (v1+ — read-only browse + structured write) | `core` | `core` | `core` | — | — | — | — (mobile UI doesn't drive workflows; voice/agent surfaces do) | — | — | — | — | — |
| **Future desktop** (v1+ — Electron/Tauri shell over the SDK) | `core` | `core` | `core` | `core` (long-running Vault lifecycle; see `vault.close()`) | `core` | — | `workflows` (when the user invokes lint/research/etc.) | `workflows` | `core` (if the desktop shell aggregates the four kinds for an in-process protocol bridge) | `mcp` (when a desktop-side MCP adapter is added) or `future-voice` (a desktop voice control surface would call `renderVoice(surface)`) | `mcp` (optional) | — |
| **Future voice** (v1+ — AirPods → `inbox/voice/` writes) | `core` | `core` | `core` (only `writeDocument` for the inbox capture) | — | — | — | — | — | `core` (a voice-control variant that aggregates the four kinds builds against `AbstractSurface`) | `future-voice` (a `renderVoice(surface)` in `@dome/sdk/voice` would project the four kinds to voice-control wire format) | — | — |
| **Future HTTP** (v1+ — web-app backend) | `core` | `core` | `core` (via `surface.tools`; a future `renderHttp` would wrap the same `BoundToolSurface` as REST handlers) | — | — | — | — | `workflows` (if the web app surfaces workflows) | `core` (the abstract aggregation layer the HTTP shell consumes) | `future-http` (a `renderHttp(surface)` in `@dome/sdk/http` would project the four kinds to HTTP envelopes) | — | — |
| **Plugin SDK** (v0.5+ — custom Tool authors) | `core` (types only) | `core` (types only) | `core` (types only) | `core` (registration types) | — | — | `workflows` (when the plugin wants an AI-SDK-shaped Tool) | — | — | — | — | — |
| **Eval suite** (internal — `src/eval/`) | `core` | `core` | `core` | — | — | — | `workflows` (replay drives `runWorkflow`) | `workflows` | — | — | — | — |

## Reading the matrix

- **A consumer whose row has only `core` and `—` cells** transitively pulls only the dependencies in [[wiki/specs/sdk-surface]] §"Dependencies" entrypoint-scope `core`: `isomorphic-git`, `chokidar`, `zod`, `gray-matter`, `p-queue`, `yaml`, `zod-to-json-schema`. No LLM, no MCP, no Commander. The bundle-deps test pins this for the `@dome/sdk` entrypoint itself; a consumer that respects the cell labels gets the same guarantee transitively.
- **A row with a `workflows` cell or a `core + workflows` compound cell** adds `@ai-sdk/anthropic` + `ai`. The mobile and voice-capture rows deliberately omit this — they capture-and-store, they don't drive the LLM loop.
- **A row with an `mcp` cell or a `core + mcp` compound cell** adds `@modelcontextprotocol/sdk`. The CLI and eval rows omit it — the CLI invokes the headless agent loop directly; eval doesn't speak MCP.
- **The AbstractSurface column is always `core` or `—`.** That's the structural shape the entrypoint split makes possible: the protocol-agnostic aggregation lives in core, so every shell that aggregates the four kinds reaches it through `core` regardless of which protocol it renders to.
- **The Protocol renderer column names which renderer the consumer uses.** `mcp` (live in v0.5), `future-http`, `future-voice` (anticipated, non-normative). A consumer that doesn't aggregate the four kinds has `—` here.
- **Compound cells (`core + <entrypoint>`)** mean the consumer's import of that symbol family spans two entrypoints. Example: the MCP server's overall consumer-surface posture is `core` (for `AbstractSurface`) + `mcp` (for `renderMcp` and `DomeMcpServer`) — the abstract layer comes from core; the protocol projection comes from mcp.
- **Speculative entrypoints in cell text** (`future-http`, `future-voice`) are intentionally non-normative annotations: the matrix says "when this entrypoint exists, this is where the symbol would live" without committing v0.5 to ship it.

## Why the matrix exists

The architecture review found that pre-Phase-B, every consumer shell pulled Anthropic + MCP whether they used the LLM-driven surface or not (see [[wiki/gotchas/transitive-llm-dependency]]). The matrix is the substrate-shape pin that makes the entrypoint split legible: a reader asking "should `runWorkflow` live in core?" reads the column, sees that only the CLI, MCP server, headless loop, and eval suite need it, notices the mobile/voice/HTTP rows don't, and concludes the workflow runner belongs in `@dome/sdk/workflows`.

The matrix is also the input the [[wiki/invariants/CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY]] bundle-deps test asserts against: any cell that reads `core` for an LLM-or-MCP-adjacent symbol family would be a contradiction.

The **two-layer split** (`AbstractSurface` in core; per-protocol renderers in their entrypoints) is the structural shape that makes v1+ multi-surface work cheap. A new protocol adapter ships as a single `renderXxx(surface): XxxSurface` function in its own entrypoint; the aggregation logic is reused. Without the split, every new protocol would re-implement the four-kind aggregation against `Vault` directly — and would inevitably duplicate the per-Vault prompt-directory scan, the hook-dispatch wrap, and the instructions composition.

## Cells that may grow

- **A new shell** (e.g., a CLI-but-not-the-built-in dome CLI, like a `dome-todo` companion) adds a row. The author follows the cell pattern: import only what you use; aggregate via `AbstractSurface` + a renderer if applicable.
- **A new entrypoint** (e.g., `@dome/sdk/http`) adds a renderer column entry and may replace a "future-" annotation. The split criterion: new entrypoints land when they (a) add a meaningful transitive dependency that consumers should opt into, OR (b) introduce a new protocol renderer parallel to `renderMcp`.
- **A new symbol family** (e.g., a future plugin-discovery API) adds a column of cells. The default cell value is `core` unless the symbol has consumer-affecting deps.

## Related

- [[wiki/invariants/CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY]] — the axiom this matrix realizes
- [[wiki/invariants/HOOK_DISPATCH_IS_VAULT_BOUND]] — the per-protocol-renderer pin (every renderer projects from `surface.tools`, never re-binds the registry)
- [[wiki/specs/sdk-surface]] §"Distribution" + §"Consumer surfaces"
- [[wiki/specs/harnesses]] §"Future-harness pressure" (the v1+ rows)
- [[wiki/gotchas/transitive-llm-dependency]] — the scar
- [[wiki/specs/mcp-surface]] (the MCP-row consumer's spec)
- [[wiki/specs/cli]] (the CLI-row consumer's spec)
