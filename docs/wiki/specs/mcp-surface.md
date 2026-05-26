---
type: spec
created: 2026-05-25
updated: 2026-05-25
sources: ["[[cohesive/brainstorms/2026-05-25-dome-vision]]"]
---

# MCP surface

**Status in v0.5: non-primary surface.** The MCP server is preserved in the codebase as a future-investment surface but is not load-bearing for v0.5 value delivery. Dome's canonical interaction model on the Claude Code harness is: per-vault `AGENTS.md` for orientation, the CLI (`dome lint`, `dome lint --apply <id>`, `dome stats`, `dome doctor`, etc.) for explicit operations, and `dome serve` running as a background compiler daemon for passive reconciliation. Claude Code uses its native `Read` / `Grep` / `Write` / `Edit` for filesystem operations; the watcher catches those writes and the compiler reconciles. The MCP tools and prompts described below are functional and tested, but the agent is not expected to reach for them when native tools suffice. See [[VISION]] §"Two surface patterns" and [[wiki/specs/harnesses]] §"The compiler-boundary contract" for the architectural framing.

**When MCP re-earns its keep:** future agent harnesses without shell access (so they can't invoke `dome` CLI commands directly) or harnesses that benefit from explicitly-typed structured operations would reach for these tools. Mobile (which imports the SDK core directly per [[wiki/specs/sdk-surface]] §"Consumer surfaces") and Web (which would speak HTTP via a future `@dome/sdk/http` companion) do not need the MCP surface — they use the protocol most natural to their shell. The MCP exists for the harness class that lives between "embedded SDK consumer" and "shell-capable harness."

This spec is normative for the MCP server's *implementation* — when a consumer does mount it, the contract below holds. The MCP server is a **thin protocol adapter over [[wiki/specs/sdk-surface]] §"Consumer surfaces" `McpSurface`**: it consumes the four-kind MCP-rendered shape `renderMcp` produces from the protocol-agnostic `AbstractSurface`.

The MCP server lives in `@dome/sdk/mcp` (not `@dome/sdk` core). A consumer that wants only Vault + Tools without speaking MCP imports from `@dome/sdk` and pays no MCP dependency cost — see [[wiki/invariants/CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY]].

## Construction

`DomeMcpServer` consumes an `McpSurface` produced by rendering an `AbstractSurface`:

```ts
import { openVault, buildAbstractSurface } from "@dome/sdk";
import { renderMcp, DomeMcpServer } from "@dome/sdk/mcp";

const vaultR = await openVault(path);
if (!vaultR.ok) throw vaultR.error;
const surface = await buildAbstractSurface(vaultR.value);
const mcp = renderMcp(surface);
const server = new DomeMcpServer({ surface: mcp });
await server.serveStdio();
```

The chain has three steps. `buildAbstractSurface(vault)` (in `@dome/sdk` core; async because it scans `<vault>/.dome/prompts/` and reads `AGENTS.md`) produces the protocol-agnostic four-kind aggregation per [[wiki/specs/sdk-surface]] §"Consumer surfaces". `renderMcp(surface)` (synchronous; in `@dome/sdk/mcp`) projects each kind to MCP shape: `surface.tools` (a `BoundToolSurface`) becomes `ReadonlyArray<ToolAdapter>` with `dome.*` snake_case names and the MCP handler signature; `surface.prompts` (a list of `PromptDescriptor`) becomes `ReadonlyArray<McpPromptAdapter>` with the `dome.workflow.<name>` / `dome.system_prompt` naming convention; `surface.resources` (a list of `ResourceDescriptor`) becomes a `ResourceAdapter` registering `dome://` URIs against the MCP request layer; `surface.instructions` passes through unchanged. `DomeMcpServer({ surface: McpSurface })` adapts the rendered surface to the MCP wire protocol.

A future `@dome/sdk/http` companion entrypoint ships `renderHttp(surface): HttpSurface` parallel to `renderMcp` — same `surface` input, different wire format. The aggregation logic in `buildAbstractSurface` is reused; only the renderer changes.

## Invocation

```bash
bun x @dome/sdk serve --vault <path> [--port <n>] [--stdio]
```

Two transports:

- **stdio** (default for Claude Code and Cursor): the MCP server speaks JSON-RPC over stdin/stdout. The harness spawns it as a child process.
- **HTTP / SSE** (for harnesses that need network access — future): bind a port and serve MCP over HTTP. v0.5 ships stdio first; HTTP follows in v0.5.1 once a use case demands it.

The server holds exactly one Vault open per invocation. To serve multiple vaults, run multiple MCP server instances (one per vault).

## Tool catalog (mirrors SDK)

The MCP server exposes one MCP tool per SDK Tool, name-preserving (snake_case in MCP, camelCase in the SDK). The SDK has seven Tools; the MCP surface has seven matching MCP tools.

| MCP tool name | SDK Tool | Input schema | Output (the inner `Result<T,E>`) |
|---|---|---|---|
| `dome.read_document` | `readDocument` | `{ path: string }` | Document (frontmatter, body, links_out) |
| `dome.write_document` | `writeDocument` | `{ path, body, frontmatter, expected_mtime?, opts?: { create?, reason?, sensitivity_classified? } }` — `expected_mtime?` threads the optimistic-locking snapshot from a prior `dome.read_document`; see [[wiki/specs/sdk-surface]] §"Tool signatures" and §"Concurrency" for the canonical shape | created/updated Document, or `ToolError` |
| `dome.append_log` | `appendLog` | `{ verb, subject, body, refs }` | appended `LogEntry`, or `ToolError` |
| `dome.search_index` | `searchIndex` | `{ query, filters? }` | array of matches with paths and excerpts |
| `dome.wikilink_resolve` | `wikilinkResolve` | `{ link: string }` | Document or null |
| `dome.move_document` | `moveDocument` | `{ from, to, reason, expected_mtime? }` — `expected_mtime?` per [[wiki/specs/sdk-surface]] §"Concurrency" | moved Document, or `ToolError` |
| `dome.delete_document` | `deleteDocument` | `{ path, reason, expected_mtime? }` — `expected_mtime?` per [[wiki/specs/sdk-surface]] §"Concurrency" | void, or `ToolError` |

Input schemas are Zod-derived JSON Schema; MCP clients (Claude Code, etc.) consume these to render the tool to the LLM. Output shapes preserve the SDK's `Result<T, E>` discrimination: success is JSON-encoded into MCP's `content` array; errors set MCP's `isError: true` with the structured `ToolError` JSON in `content[0].text` so the harness can present them. The Tool's `effects` from `ToolReturn<T>` are *not* serialized over the wire — the Tool already applied them side-effectfully (writes, hook dispatch) before the adapter returns.

## Prompts exposed

The MCP server also exposes Dome's prompts as MCP *prompts* (a separate MCP concept from tools — MCP prompts are reusable templates a harness can offer to its user). Shipped-default workflows always appear; opt-in workflows appear only when the vault activates them.

| MCP prompt name | Underlying workflow prompt | Tier |
|---|---|---|
| `dome.system_prompt` | `system-base.md` (the wiki-maintainer system prompt; harness loads at session start) | shipped default |
| `dome.workflow.ingest` | `ingest` workflow | shipped default |
| `dome.workflow.query` | `query` workflow | shipped default |
| `dome.workflow.lint` | `lint` workflow | shipped default |
| `dome.workflow.migrate` | `migrate` workflow | shipped default |
| `dome.workflow.export_context` | `export-context` workflow | shipped default |
| `dome.workflow.research` | `research` workflow | opt-in (visible only when activated) |
| `dome.workflow.voice_ingest` | `voice-ingest` workflow | opt-in |
| `dome.workflow.clip_integrate` | `clip-integrate` workflow | opt-in |

Plugin- and vault-local workflows automatically appear as MCP prompts following the `dome.workflow.<name>` convention.

## Resources exposed

The MCP server exposes vault content as MCP *resources*:

| Resource URI | Content |
|---|---|
| `dome://index` | `index.md` |
| `dome://log` | `log.md` (latest N entries; configurable) |
| `dome://page/<path>` | A specific page's content |
| `dome://vault/info` | Vault config + page-type-allowed list + invariants enabled |

Resources are read-only via MCP; mutation always flows through the `dome.write_*` tools when a consumer is interacting via the MCP surface. (Consumer shells with native filesystem access — Claude Code, vim, Obsidian — write directly to the vault and the watcher catches those writes per the compiler-boundary contract in [[VISION]] §"Two surface patterns". [[wiki/invariants/HOOKS_CANNOT_BYPASS_TOOLS]] governs Dome's *internal* dispatcher / hook / tool chain, not consumer-shell behavior.)

## Session model

Each harness session connects fresh: opens the Vault (if not already open), reads the registry, exposes Tools + Prompts + Resources. The MCP server is *not* per-session; one server serves many concurrent harness sessions against the same vault. (For multi-harness concurrency see [[wiki/gotchas/concurrent-harness-write]].)

## Authentication

v0.5: none. The MCP server runs as a child process of the user's harness or on the user's loopback — there is no cross-machine access surface. Authentication enters when the SDK grows an HTTP transport (v0.5.1+) or a sync layer (v1+).

## Versioning

The MCP server reports its version via the standard MCP `serverInfo` field. Tool names are versioned via the `dome.` prefix; breaking changes (a Tool's input shape changes incompatibly) bump the package major version and rename the affected MCP tool (`dome.v2.write_document`) for the transition window. Plugin and vault-local Tools are not version-managed by Dome — plugin authors own their compatibility.

## Why MCP is the only protocol-server surface in v0.5

MCP is the only *protocol-server* surface implemented in v0.5 — alongside it, the canonical consumer-shell paths are: direct SDK import (used by `dome serve` itself, by future native mobile/desktop, by any embedded consumer) and the CLI (any shell, including Claude Code's `Bash`).

Other protocol-server surfaces considered and deferred:

- **HTTP REST / SSE** — useful for web clients and remote-vault mobile shells. Deferred until either lands; an `@dome/sdk/http` companion entrypoint with `renderHttp(surface)` parallel to `renderMcp` is the planned home.
- **GraphQL** — same.
- **gRPC / Protobuf** — multi-language; Dome's first-class non-TS consumer is future native mobile, which currently consumes the SDK directly.

MCP is preserved as the protocol-server surface for the harness class between "embedded SDK consumer" (mobile, desktop) and "shell-capable harness" (Claude Code via Bash). Currently that class is empty in real-world use; the surface is preserved against future-pressure rather than for current value delivery.

## Related

- [[wiki/specs/sdk-surface]] — the Tool catalog this surface mirrors.
- [[wiki/specs/harnesses]] — which harnesses speak MCP and how they're configured.
- [[wiki/entities/mcp-protocol]] — what MCP is.
- [[wiki/specs/cli]] — the `dome serve` command starts this server.
