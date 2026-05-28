---
type: spec
created: 2026-05-27
updated: 2026-05-27
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]", "[[v1]]"]
---

# MCP surface

This spec is normative for Dome's MCP (Model Context Protocol) adapter. The MCP server is **one protocol adapter** over [[wiki/specs/sdk-surface]] §"AbstractSurface" — the same surface the CLI consumes, expressed in MCP wire format.

## Status in v1

The MCP server is **preserved as a non-primary surface**. The compiler-boundary contract per [[wiki/specs/harnesses]] (AGENTS.md + CLI + daemon + adopted ref) is the load-bearing path for agentic harnesses in v1. The MCP surface ships in the codebase and works correctly when mounted, but the SDK does not depend on it for value delivery, and Claude Code users do not need it mounted to use Dome effectively.

The MCP surface earns its keep in two scenarios:

1. **Harnesses without robust shell-execution.** A sandboxed agent that cannot invoke `Bash` reaches Dome via typed MCP tools instead. MCP becomes the only path.
2. **Workflows that benefit from typed argument validation.** Some agent interactions prefer Zod-typed structured inputs over CLI argument strings. MCP routes the same operations with stronger schema enforcement.

For v1's primary path (Claude Code with full shell access), MCP is additive — available, not required.

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

The MCP server is a thin protocol adapter. It does not embed Dome's Submit, Recall, or processor execution; it forwards to the AbstractSurface's `submit`, `query`, `read`, and `commands` callbacks.

Pinned by [[wiki/invariants/ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY]] (the `@dome/sdk` core has no MCP dependency; `@dome/sdk/mcp` lives in a separate entrypoint) and [[wiki/gotchas/transitive-llm-dependency]] (the bundle-deps test catches re-exports that would defeat the separation).

## MCP tools

The MCP server exposes Dome's Submit and Recall surfaces as MCP tools under the `dome.*` prefix:

| MCP tool | Maps to | Purpose |
|---|---|---|
| `dome.submit` | `AbstractSurface.submit` | Construct and submit a Proposal. |
| `dome.query` | `AbstractSurface.query` | Full-text + structured query against adopted state. |
| `dome.read_document` | `AbstractSurface.read` | Read a single document at the adopted commit. |
| `dome.resolve_wikilink` | `AbstractSurface.resolveWikilink` (via vault) | Resolve a `[[wikilink]]` to a document. |
| `dome.run_command` | `AbstractSurface.commands.<name>` | Invoke a view-phase command processor (`lint`, `stats`, `query`, etc.). |

Tool names are derived from a single source (the canonical processor + Submit/Recall surface) — no parallel naming catalog. Adding a new view-phase command processor extends `dome.run_command`'s command list automatically.

### `dome.submit`

```yaml
description: Submit a proposal to the engine. Returns AdoptionResult.
inputSchema:
  type: object
  properties:
    patch:        { type: string, description: "UnifiedDiff patch; if absent, working-tree HEAD is used" }
    sourceKind:   { type: string, enum: ["client", "agent", "garden", "manual", "import"] }
    metadata:
      type: object
      properties:
        title:      { type: string }
        authoredAt: { type: string, format: date-time }
        reason:     { type: string }
```

Returns:

```yaml
{
  proposalId: string,
  adopted: boolean,
  adoptedRef: string,
  diagnostics: [{ severity, code, message, sourceRefs }, ...],
  closureCommitOid: string | null,
  iterations: number,
}
```

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
    name:  { type: string, description: "Command processor name (lint, stats, query, export-context, etc.)" }
    args:  { type: object, description: "Command-specific arguments" }
```

The available command names are enumerated by `AbstractSurface.commands` at server startup; the MCP server registers the full list. Adding a command-triggered processor in any bundle extends the surface automatically.

## MCP resources

The MCP server exposes vault contents under URI schemes:

| URI scheme | Maps to | Returns |
|---|---|---|
| `dome://page/<path>` | `AbstractSurface.readResource` | Markdown body of `<path>` at adopted commit |
| `dome://log` | `AbstractSurface.readResource` | `log.md` at adopted commit |
| `dome://index` | `AbstractSurface.readResource` | `index.md` at adopted commit |
| `dome://search?q=<query>` | `AbstractSurface.readResource` | Top-N FTS matches for `<query>` |
| `dome://status` | (engine call) | `AdoptionStatus` JSON |

The resource URI map is the read-side counterpart to the tool map.

## MCP prompts

The MCP server exposes the view-phase processor names as MCP prompts under `dome.workflow.<processor-id>`. The MCP prompt's `getMessages(args)` callback constructs the prompt by invoking the processor with the supplied args and returning the rendered prompt text.

```yaml
# Example: dome.workflow.dome.intake.extract-capture
name: dome.workflow.dome.intake.extract-capture
description: Compile a raw capture into wiki updates.
arguments:
  - name: capture_path
    description: "Path to the raw capture file"
    required: true
```

Note: MCP prompts here are *prompts about processors*, not the workflows-as-prompts pattern v0.5 had. The garden-LLM processors define their own prompts internally; the MCP prompt surface exposes them as MCP-protocol prompts for harnesses that want to invoke a processor's prompt without running the processor itself.

## Mount lifecycle

The MCP server boots when the harness mounts it (typically via the harness's MCP config). On boot:

1. `openVault(path)` constructs the Vault and the engine.
2. `buildAbstractSurface(vault)` constructs the surface.
3. `renderMcp(surface)` constructs the McpSurface.
4. `DomeMcpServer(McpSurface)` starts the MCP server, registering tools, resources, prompts.
5. On shutdown (harness disconnect, vault close): `vault.close()` drains processors and releases SQLite handles.

The MCP server is **single-vault per process**. Multi-vault MCP setups run multiple MCP server processes, one per vault.

## What the MCP server does not have

To keep the surface minimal:

- **No write tools beyond `dome.submit`.** No `dome.write_document`, no `dome.move_document`, no `dome.delete_document`. All writes go through Proposals.
- **No privileged operations.** No way to advance the adopted ref directly, no way to bypass capability checks, no way to write the projection store.
- **No multi-vault routing.** One vault per server process.
- **No engine-internal queries.** No way to read the run ledger directly through MCP (use `dome inspect runs` via CLI when needed).

These are intentional. The MCP server is a Recall + Submit adapter, not a privileged escape hatch.

## Related

- [[wiki/specs/sdk-surface]] §"Consumer surfaces" — the AbstractSurface this adapter renders.
- [[wiki/specs/harnesses]] — when MCP earns its keep vs the CLI path.
- [[wiki/specs/proposals]] — what `dome.submit` constructs.
- [[wiki/specs/processors]] §"Phase × trigger matrix" — `dome.run_command` invokes command-triggered view-phase processors.
- [[wiki/invariants/ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY]] — core/MCP separation.
- [[wiki/gotchas/transitive-llm-dependency]] — the dep-fence that catches MCP leak into core.
- [[wiki/matrices/protocol-adapter]] — MCP as one row in the protocol-adapter map.
