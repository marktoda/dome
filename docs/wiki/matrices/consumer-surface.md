---
type: matrix
created: 2026-05-26
updated: 2026-05-26
sources: ["[[cohesive/reviews/2026-05-26-dome-v0.5-cohesion-architecture-review]]"]
---

# Consumer surface matrix

The canonical map of "what each consumer shell imports from the `@dome/sdk` package family." Rows are consumer shells (v0.5-shipped and v1+ anticipated); columns are exported symbol families. Each cell names the entrypoint the consumer reaches the symbol through, or marks the symbol unused for that shell.

The matrix is the structural realization of [[wiki/invariants/CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY]]: every cell that reads `core` carries no transitive Anthropic/MCP dependency; every cell that reads `workflows` or `mcp` opts into that dep explicitly.

## Entrypoint legend

- `core` — `@dome/sdk` (the package root: `src/index.ts`). No LLM, no MCP.
- `workflows` — `@dome/sdk/workflows`. Carries `@ai-sdk/anthropic` + `ai`.
- `mcp` — `@dome/sdk/mcp`. Carries `@modelcontextprotocol/sdk`.
- `cli` — `@dome/sdk/cli`. Carries `commander`.
- `core + <entrypoint>` — **compound cell.** The consumer reaches the symbol through more than one entrypoint (e.g., `Vault` from core + the `projectMcp(vault)` projection from `mcp`). The bundling-axiom test treats each named entrypoint as a separate transitive-dep contributor: a compound `core + mcp` cell pulls the MCP deps; `core + workflows` pulls the LLM deps. A cell labeled just `core` must reach its symbol through `core` *only*.
- `—` — symbol unused by this shell.

## Matrix

| Consumer shell ↓ \ Symbol family → | Vault (`openVault`, `Vault`) | Document (`makeDocument`) | Tools (`readDocument` … `deleteDocument`, `BoundToolSurface`) | Hook (`HookRegistry`, `HookDispatcher`, `HookContext`) | Reconcile + Watcher | Privileged writer (internal — `vault.rebuildIndex` seam only) | AI-SDK ToolSet (`projectAiSdk`) | Workflow runner (`runWorkflow`, `WorkflowRegistry`, `PromptLoader`) | MCP adapters (`projectMcp`, tool/prompt/resource adapters) | ConsumerSurface (`buildConsumerSurface`) | `DomeMcpServer` | CLI shell (`runCli`, `dome*` commands, `CliError`, `renderCliError`) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **CLI** (v0.5 — `dome` binary) | `core` | `core` | `core` (via `vault.tools`) | `core` (event projection, hook quarantine) | `core` (reconcile + watcher) | `core` (`vault.rebuildIndex`) | `workflows` (for `dome lint` / `migrate` / `export-context`) | `workflows` | — | — | — | `cli` |
| **MCP server** (v0.5 — invoked by `dome serve`) | `core` | `core` | `core + mcp` (`vault.tools` from core; `projectMcp(vault)` from mcp) | `core` | `core` (reconcile at startup) | — | — | `workflows` (the MCP server exposes Dome's workflows as MCP prompts; their resolution needs the workflow registry) | `mcp` | `mcp` (the server consumes a `ConsumerSurface`) | `mcp` | — |
| **Headless agent loop** (v0.5 — invoked by intake hooks + `dome lint`) | `core` | `core` | `core` (via `vault.tools`) | — | — | — | `workflows` (`projectAiSdk` produces the AI-SDK tool set) | `workflows` (`runWorkflow` IS this loop) | — | — | — | — |
| **Future mobile** (v1+ — read-only browse + structured write) | `core` | `core` | `core` | — | — | — | — (mobile UI doesn't drive workflows; voice/agent surfaces do) | — | — | — | — | — |
| **Future desktop** (v1+ — Electron/Tauri shell over the SDK) | `core` | `core` | `core` | `core` (long-running Vault lifecycle; see `vault.close()`) | `core` | — | `workflows` (when the user invokes lint/research/etc.) | `workflows` | — | `mcp` (when a desktop-side MCP adapter is added) | `mcp` (optional) | — |
| **Future voice** (v1+ — AirPods → `inbox/voice/` writes) | `core` | `core` | `core` (only `writeDocument` for the inbox capture) | — | — | — | — | — | — | — | — | — |
| **Future HTTP** (v1+ — web-app backend) | `core` | `core` | `core` (a future `projectHttp(vault)` in `@dome/sdk/http` would extend `mcp`-shape parsers to HTTP envelopes — see the MCP server row for the analog) | — | — | — | — | `workflows` (if the web app surfaces workflows) | `mcp` (or a future `@dome/sdk/http` companion when HTTP-specific adapters justify a split) | `mcp` (`buildConsumerSurface` lives there today; a future `@dome/sdk/http` could expose its own `buildHttpSurface(vault)` returning the same four kinds via HTTP envelopes) | — | — |
| **Plugin SDK** (v0.5+ — custom Tool authors) | `core` (types only) | `core` (types only) | `core` (types only) | `core` (registration types) | — | — | `workflows` (when the plugin wants an AI-SDK-shaped Tool) | — | — | — | — | — |
| **Eval suite** (internal — `src/eval/`) | `core` | `core` | `core` | — | — | — | `workflows` (replay drives `runWorkflow`) | `workflows` | — | — | — | — |

## Reading the matrix

- **A consumer whose row has only `core` and `—` cells** transitively pulls only the dependencies in [[wiki/specs/sdk-surface]] §"Dependencies" entrypoint-scope `core`: `isomorphic-git`, `chokidar`, `zod`, `gray-matter`, `p-queue`, `yaml`, `zod-to-json-schema`. No LLM, no MCP, no Commander. The bundle-deps test pins this for the `@dome/sdk` entrypoint itself; a consumer that respects the cell labels gets the same guarantee transitively.
- **A row with a `workflows` cell or a `core + workflows` compound cell** adds `@ai-sdk/anthropic` + `ai`. The mobile and voice rows deliberately omit this — they capture-and-store, they don't drive the LLM loop.
- **A row with an `mcp` cell or a `core + mcp` compound cell** adds `@modelcontextprotocol/sdk`. The CLI and eval rows omit it — the CLI invokes the headless agent loop directly; eval doesn't speak MCP.
- **Compound cells (`core + <entrypoint>`)** mean the consumer's import of that symbol family spans two entrypoints. Example: the MCP server's Tools cell reads `core + mcp` because the server holds a `BoundToolSurface` from core (`vault.tools`) AND reaches `projectMcp(vault)` from `mcp` for the raw-input parsers. Both deps stack.
- **Speculative entrypoints in cell text** (`future-http`) are intentionally non-normative annotations: the matrix says "when this entrypoint exists, this is where the symbol would live" without committing v0.5 to ship it. They are not in the legend; they ride as inline annotations only.

## Why the matrix exists

The architecture review found that pre-Phase-B, every consumer shell pulled Anthropic + MCP whether they used the LLM-driven surface or not (see [[wiki/gotchas/transitive-llm-dependency]]). The matrix is the substrate-shape pin that makes the entrypoint split legible: a reader asking "should `runWorkflow` live in core?" reads the column, sees that only the CLI, MCP server, headless loop, and eval suite need it, notices the mobile/voice/HTTP rows don't, and concludes the workflow runner belongs in `@dome/sdk/workflows`.

The matrix is also the input the [[wiki/invariants/CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY]] bundle-deps test asserts against: any cell that reads `core` for an LLM-or-MCP-adjacent symbol family would be a contradiction.

## Cells that may grow

- **A new shell** (e.g., a CLI-but-not-the-built-in dome CLI, like a `dome-todo` companion) adds a row. The author follows the cell pattern: import only what you use.
- **A new entrypoint** (e.g., `@dome/sdk/http`) adds a column or replaces a "future" annotation. The split criterion: new entrypoints land when they (a) add a meaningful transitive dependency that consumers should opt into, OR (b) bundle a new four-kind aggregation pattern parallel to `@dome/sdk/mcp`.
- **A new symbol family** (e.g., a future plugin-discovery API) adds a row of cells. The default cell value is `core` unless the symbol has consumer-affecting deps.

## Related

- [[wiki/invariants/CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY]] — the axiom this matrix realizes
- [[wiki/specs/sdk-surface]] §"Distribution" + §"Consumer surfaces"
- [[wiki/specs/harnesses]] §"Future-harness pressure" (the v1+ rows)
- [[wiki/gotchas/transitive-llm-dependency]] — the scar
- [[wiki/specs/mcp-surface]] (the MCP-row consumer's spec)
- [[wiki/specs/cli]] (the CLI-row consumer's spec)
