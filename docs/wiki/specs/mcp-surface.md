---
type: spec
created: 2026-05-25
updated: 2026-05-25
sources: ["[[cohesive/brainstorms/2026-05-25-dome-vision]]"]
---

# MCP surface

This spec is normative for Dome's MCP server — the protocol surface that exposes the SDK to any MCP-capable harness (Claude Code, Cursor, OpenCode, Codex CLI, and future agents). The MCP server is a *thin adapter*: each MCP tool is a 1:1 wrapper over an SDK Tool.

## Invocation

```bash
bun x @dome/sdk serve --vault <path> [--port <n>] [--stdio]
```

Two transports:

- **stdio** (default for Claude Code and Cursor): the MCP server speaks JSON-RPC over stdin/stdout. The harness spawns it as a child process.
- **HTTP / SSE** (for harnesses that need network access — future): bind a port and serve MCP over HTTP. v0.5 ships stdio first; HTTP follows in v0.5.1 once a use case demands it.

The server holds exactly one Vault open per invocation. To serve multiple vaults, run multiple MCP server instances (one per vault).

## Tool catalog (mirrors SDK)

The MCP server exposes one MCP tool per SDK Tool, name-preserving. The SDK has six Tools; the MCP surface has six matching MCP tools.

| MCP tool name | SDK Tool | Input schema | Output |
|---|---|---|---|
| `dome.read_page` | `readPage` | `{ path: string }` | Document (frontmatter, body, links_out) |
| `dome.write_page` | `writePage` | `{ path, body, frontmatter, reason?, sensitivity_classified? }` | `{ ok, effects }` or `{ ok: false, error }` |
| `dome.append_log` | `appendLog` | `{ verb, subject, body, refs }` | `{ ok }` |
| `dome.search_index` | `searchIndex` | `{ query, filters? }` | array of matches with paths and excerpts |
| `dome.wikilink_resolve` | `wikilinkResolve` | `{ link: string }` | Document or null |
| `dome.move_document` | `moveDocument` | `{ from, to, reason }` | `{ ok, effects }` or `{ ok: false, error }` |

Input schemas are Zod-derived JSON Schema; MCP clients (Claude Code, etc.) consume these to render the tool to the LLM. Output shapes preserve the SDK's `Result<T, E>` discrimination: errors come back as `{ ok: false, error: { kind, detail } }` so the harness can present them.

## Prompts exposed

The MCP server also exposes Dome's prompts as MCP *prompts* (a separate MCP concept from tools — MCP prompts are reusable templates a harness can offer to its user). Tier-2 shipped-default workflows always appear; tier-3 opt-in workflows appear only when the vault activates them.

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
| `dome.workflow.sensitivity_classify` | `sensitivity-classify` workflow | opt-in |
| `dome.workflow.clip_integrate` | `clip-integrate` workflow | opt-in |

Plugin and vault-local workflows automatically appear as MCP prompts following the same naming convention (`dome.workflow.<name>`).

## Resources exposed

The MCP server exposes vault content as MCP *resources*:

| Resource URI | Content |
|---|---|
| `dome://index` | `index.md` |
| `dome://log` | `log.md` (latest N entries; configurable) |
| `dome://page/<path>` | A specific page's content |
| `dome://vault/info` | Vault config + page-type-allowed list + invariants enabled |

Resources are read-only via MCP; mutation always flows through the `dome.write_*` tools. This preserves [[wiki/invariants/HOOKS_CANNOT_BYPASS_TOOLS]] (and the harness-equivalent: harnesses cannot bypass Tools).

## Session model

Each harness session connects fresh: opens the Vault (if not already open), reads the registry, exposes Tools + Prompts + Resources. The MCP server is *not* per-session; one server serves many concurrent harness sessions against the same vault. (For multi-harness concurrency see [[wiki/gotchas/concurrent-harness-write]].)

## Authentication

v0.5: none. The MCP server runs as a child process of the user's harness or on the user's loopback — there is no cross-machine access surface. Authentication enters when the SDK grows an HTTP transport (v0.5.1+) or a sync layer (v1+).

## Versioning

The MCP server reports its version via the standard MCP `serverInfo` field. Tool names are versioned via the `dome.` prefix; breaking changes (a Tool's input shape changes incompatibly) bump the package major version and rename the affected MCP tool (`dome.v2.write_page`) for the transition window. Plugin and vault-local Tools are not version-managed by Dome — plugin authors own their compatibility.

## Why MCP is the only protocol surface in v0.5

Other surfaces considered and deferred:

- **HTTP REST** — useful for web clients but unnecessary while there's no web client. Adds v0.5 scope without v0.5 consumer.
- **GraphQL** — same.
- **Direct SDK import** — the headless SDK loop already does this. Not "exposed"; just available to TS/JS code.
- **gRPC / Protobuf** — multi-language but Dome's first-class non-TS consumer is the future native mobile, which is far away.

MCP is the protocol that's already adopted by every harness Dome's v0.5 targets. Adding parallel protocols is premature.

## Related

- [[wiki/specs/sdk-surface]] — the Tool catalog this surface mirrors.
- [[wiki/specs/harnesses]] — which harnesses speak MCP and how they're configured.
- [[wiki/entities/mcp-protocol]] — what MCP is.
- [[wiki/specs/cli]] — the `dome serve` command starts this server.
