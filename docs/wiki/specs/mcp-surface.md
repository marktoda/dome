---
type: spec
created: 2026-05-27
updated: 2026-05-29
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]", "[[v1]]"]
---

# MCP surface

This spec is normative for Dome's MCP (Model Context Protocol) adapter. The MCP server is **one protocol adapter** over [[wiki/specs/sdk-surface]] §"AbstractSurface" — the same surface the CLI consumes, expressed in MCP wire format.

## Status in v1

The MCP server is **preserved as a non-primary surface**. The compiler-boundary contract per [[wiki/specs/harnesses]] (CLAUDE/AGENTS orientation + CLI + compiler host + adopted ref) is the load-bearing path for agentic harnesses in v1. The MCP design remains useful, but the complete Claude Code v1 plan does not depend on it for value delivery, and Claude Code users do not need it mounted to use Dome effectively. Until `AbstractSurface` and the MCP adapter are implemented, this page is a target protocol spec rather than a v1 acceptance gate; see [[wiki/syntheses/v1-claude-code-vault-plan]].

The planned MCP surface earns its keep in two scenarios:

1. **Harnesses without robust shell-execution.** A sandboxed agent that cannot invoke `Bash` reaches Dome via typed MCP tools instead. MCP becomes the only path.
2. **Workflows that benefit from typed argument validation.** Some agent interactions prefer Zod-typed structured inputs over CLI argument strings. MCP routes the same operations with stronger schema enforcement.

For v1's primary path (Claude Code with full shell access), MCP is additive future work — not required.

## Architecture

```text
@dome/sdk core
  ↓
buildAbstractSurface(vault) → AbstractSurface
  ↓
@dome/sdk/mcp
  ↓
renderMcp(surface) → McpSurface  ──── DomeMcpServer (MCP protocol)
```

The MCP server is a thin protocol adapter. It does not embed Dome's Recall or processor execution; it forwards to the AbstractSurface's `query`, `read`, and `commands` callbacks. v1.0 does not expose Proposal submission over MCP; adoption catch-up is Git + CLI-native.

Pinned by [[wiki/invariants/ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY]] (the `@dome/sdk` core has no MCP dependency; a planned MCP adapter must live outside the core entrypoint) and [[wiki/gotchas/transitive-llm-dependency]] (the bundle-deps test catches re-exports that would defeat the separation).

## MCP tools

The MCP server exposes Dome's Recall and view-command surfaces as MCP tools under the `dome.*` prefix:

| MCP tool | Maps to | Purpose |
|---|---|---|
| `dome.query` | `AbstractSurface.query` | Full-text + structured query against adopted state. |
| `dome.read_document` | `AbstractSurface.read` | Read a single document at the adopted commit. |
| `dome.resolve_wikilink` | `AbstractSurface.resolveWikilink` (via vault) | Resolve a `[[wikilink]]` to a document. |
| `dome.run_command` | `AbstractSurface.commands.<name>` | Invoke a view-phase command processor (`query` / `lint` / `export-context` today; planned examples include `stats`). |

Tool names are derived from the Recall/view surface — no parallel naming catalog. Adding a new view-phase command processor extends `dome.run_command`'s command list automatically.

### `dome.query`

```yaml
description: Query adopted state. Returns matches with SourceRefs.
inputSchema:
  type: object
  properties:
    text:                  { type: string, description: "FTS query" }
    filters:               { type: object, properties: { category, type, tags } }
    revision:              { type: string, description: "default: adopted ref" }
    includeFacts:          { type: boolean, default: true }
    includeDiagnostics:    { type: boolean, default: false }
    includeQuestions:      { type: boolean, default: false }
    includeSourceSnippets: { type: boolean, default: true }
    requireEvidence:       { type: boolean, default: false }
```

### `dome.run_command`

```yaml
description: Invoke a view-phase command processor by name.
inputSchema:
  type: object
  required: [name]
  properties:
    name:  { type: string, description: "Command processor name (query/lint/export-context today; planned examples include stats)" }
    args:  { type: object, description: "Command-specific arguments" }
```

The available command names are enumerated by `AbstractSurface.commands` at server startup; the MCP server registers the full list. Adding a command-triggered processor in any bundle extends the surface automatically.

## MCP resources

The MCP server exposes vault contents under URI schemes:

| URI scheme | Maps to | Returns |
|---|---|---|
| `dome://page/<path>` | `AbstractSurface.readResource` | Markdown body of `<path>` at adopted commit |
| `dome://log` | `AbstractSurface.readResource` | `log.md` at adopted commit once the optional `dome.log` projection ships |
| `dome://index` | `AbstractSurface.readResource` | `index.md` at adopted commit once the optional `dome.index` projection ships |
| `dome://search?q=<query>` | `AbstractSurface.readResource` | Top-N FTS matches for `<query>` |
| `dome://status` | (engine call) | `AdoptionStatus` JSON |

The resource URI map is the read-side counterpart to the tool map.

## MCP prompts

The MCP prompt surface is speculative. If it ships, it should expose deliberate read/view prompts, not the old workflows-as-prompts model or garden processors directly.

```yaml
# Example: dome.view.dome.search.query
name: dome.view.dome.search.query
description: Build an adopted-state query prompt.
arguments:
  - name: text
    description: "Query text"
    required: true
```

Garden-LLM processors define their own prompts internally; MCP should not become a privileged way to run or mutate through them.

## Mount lifecycle

The MCP server boots when the harness mounts it (typically via the harness's MCP config). On boot:

1. `openVault(path)` constructs the Vault and the engine.
2. `buildAbstractSurface(vault)` constructs the surface.
3. `renderMcp(surface)` constructs the McpSurface.
4. `DomeMcpServer(McpSurface)` starts the MCP server, registering tools, resources, prompts.
5. On shutdown (harness disconnect, vault close): current `vault.close()` releases SQLite handles. The planned v1.x drain-integrated close path will first drain queued/running garden/view processor work, then release handles.

The MCP server is **single-vault per process**. Multi-vault MCP setups run multiple MCP server processes, one per vault.

## What the MCP server does not have

To keep the surface minimal:

- **No write tools.** No `dome.submit`, no `dome.write_document`, no `dome.move_document`, no `dome.delete_document`. External writes are Git-native and adoption catch-up is CLI/compiler-host-driven in v1.0.
- **No privileged operations.** No way to advance the adopted ref directly, no way to bypass capability checks, no way to write the projection store.
- **No multi-vault routing.** One vault per server process.
- **No engine-internal queries.** No way to read the run ledger directly through MCP (use `dome inspect runs` via CLI when needed).

These are intentional. The MCP server is a Recall + view-command adapter, not a privileged escape hatch.

## Related

- [[wiki/specs/sdk-surface]] §"Consumer surfaces" — the planned AbstractSurface this adapter will render.
- [[wiki/specs/harnesses]] — when MCP earns its keep vs the CLI path.
- [[wiki/specs/proposals]] — how the engine constructs Proposals internally.
- [[wiki/specs/processors]] §"Phase × trigger matrix" — `dome.run_command` invokes command-triggered view-phase processors.
- [[wiki/invariants/ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY]] — core/MCP separation.
- [[wiki/gotchas/transitive-llm-dependency]] — the dep-fence that catches MCP leak into core.
- [[wiki/matrices/protocol-adapter]] — MCP as one row in the protocol-adapter map.
