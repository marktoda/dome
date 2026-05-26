---
type: spec
created: 2026-05-25
updated: 2026-05-25
sources: ["[[cohesive/brainstorms/2026-05-25-dome-vision]]"]
---

# Harnesses

This spec is normative for how external agentic environments mount Dome. A *harness* is a runtime that hosts an agent loop and consumes Dome's Tools. The harness is the SDK's user, not part of it. Dome ships no harness in v0.5 except a minimal headless loop for scheduled and batch workflows.

## What a harness is

A harness:

- Maintains a conversation (or batch input) with an LLM.
- Discovers Dome's Tools (typically via MCP — see [[wiki/specs/mcp-surface]]) and exposes them to the LLM as callable.
- Loads Dome's prompts as system prompts or workflow prompts.
- Returns the LLM's output to the user (or to the next stage of a batch).

The harness is responsible for the agent loop: prompt → LLM call → tool calls → results → next prompt. Dome is not in this loop; Dome provides the Tools the loop invokes.

## Supported v0.5 harnesses

### Claude Code

The default v0.5 harness. Configured by adding Dome's MCP server to the user's Claude Code MCP config:

```json
{
  "mcpServers": {
    "dome": {
      "command": "bun",
      "args": ["x", "@dome/sdk", "serve", "--vault", "${VAULT_PATH}"]
    }
  }
}
```

Once configured, every Claude Code session in the configured vault directory has:

- Dome's Tools available as MCP tools.
- Dome's system prompt loaded (via Claude Code's `CLAUDE.md` mechanism — the SDK ships a `CLAUDE.md` template the user can copy into their vault).
- Dome's workflow prompts available (the system prompt instructs Claude Code to switch into the appropriate workflow based on user intent).

Claude Code is treated as a *first-party* harness in v0.5 because the user's existing workflow is already there. Upgrading to Dome means changing what tools Claude Code calls, not changing what the user does.

### Headless SDK loop (for `dome lint`, `dome export-context`, intake hooks)

Dome ships a minimal headless agent loop in `@dome/sdk` for non-interactive contexts:

- Scheduled workflows (e.g., daily `lint` via cron).
- Intake hook handlers (when a declarative hook invokes a workflow against a dropped file).
- CLI commands that map to workflows (`dome lint`, `dome export-context <topic>`).

This loop uses `@ai-sdk/anthropic` directly. It loads the named workflow prompt, binds the listed Tools, runs the loop until the LLM produces a stop turn, then returns. It is intentionally minimal — not a chat surface; not interactive; one workflow per invocation.

### Other MCP-capable harnesses (Cursor, OpenCode, Codex CLI, future)

Any harness that mounts the Dome MCP server gains Dome-awareness automatically. The Dome MCP server (see [[wiki/specs/mcp-surface]]) is the universal contract. Per-harness instructions are documented in `docs/wiki/sources/<harness>-setup.md` (not in this spec) as the ecosystem stabilizes.

## Future-harness pressure (v1+, non-normative integration points)

These are aspirational integration points the v0.5 SDK design accommodates without committing to:

- **Native mobile app** — imports from `@dome/sdk` core (no LLM, no MCP) for typed markdown read/write. Voice or research-style intake routes through `@dome/sdk/workflows` only when the user invokes an LLM-driven workflow.
- **Native desktop app** — same shape as mobile; likely an Electron / Tauri / Wails shell. Holds a long-running Vault via `openVault` → use → `vault.close()` per [[wiki/specs/sdk-surface]] §"Vault lifecycle".
- **Voice client** — captures speech via OS-native dictation, writes to `inbox/voice/*`, lets the intake hook run async ingest. The capture shell needs only `@dome/sdk` core (`writeDocument`); the ingest workflow runs server-side in `@dome/sdk/workflows`.
- **Web app** — Bun's server capabilities let the SDK serve as an HTTP backend the web client speaks to. v1+ decision; an `@dome/sdk/http` companion entrypoint may add HTTP-specific protocol adapters when the use case justifies a split (mirroring `@dome/sdk/mcp`).

**Future harness shells construct against `AbstractSurface` + a protocol renderer.** Per [[wiki/specs/sdk-surface]] §"Consumer surfaces", every protocol adapter (current MCP server; future HTTP/voice/mobile-IPC server) is split into two layers: `buildAbstractSurface(vault)` in `@dome/sdk` core produces the protocol-agnostic four-kind aggregation; a per-protocol `renderXxx(surface)` in the protocol's companion entrypoint projects each kind to wire format. The MCP server's chain — `renderMcp(buildAbstractSurface(vault))` from `@dome/sdk/mcp` — is the canonical example. A future HTTP server's chain — `renderHttp(buildAbstractSurface(vault))` from `@dome/sdk/http` — reuses `buildAbstractSurface` unchanged and ships only the HTTP-shaped projection.

The two-layer split means a new protocol adapter is a ~50-line `renderXxx` file in a new entrypoint, not a re-implementation of the four-kind aggregation. The per-Vault work (prompt-directory scan, instructions composition, hook-dispatch wrap) lives once in core; per-protocol shaping lives in the renderer.

None of these change the SDK contract; they change the harness shape above it. The [[wiki/matrices/consumer-surface]] matrix names which entrypoint each future shell reaches its symbols through; the [[wiki/invariants/CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY]] axiom + [[wiki/gotchas/transitive-llm-dependency]] gotcha together guarantee a v1+ mobile/voice/web shell pays for only the deps it actually uses; [[wiki/invariants/HOOK_DISPATCH_IS_VAULT_BOUND]] guarantees every renderer's mutating Tool invocations route through the single-source hook-dispatch wrap.

## What's NOT a harness

- Obsidian. Obsidian is a *browser* over the vault — it reads markdown directly, without going through Dome's Tools. This is by design (`MARKDOWN_IS_SOURCE_OF_TRUTH`). Obsidian-side edits are *out-of-band* writes; `dome doctor` detects drift introduced by direct edits. See [[wiki/gotchas/out-of-band-vault-edits]].
- `git`, `vim`, the filesystem. Same as Obsidian — these are vault-readers and vault-editors that bypass Tools by design. Dome tolerates this; the markdown is still canonical.

## Mounting Dome in a harness — what the harness needs

A harness needs four things:

1. **MCP connection** to Dome's MCP server (or a direct SDK import, for embedded harnesses).
2. **The system prompt** loaded — points the LLM at the wiki-maintainer ethos and the workflow-switching pattern.
3. **(Optional) Workflow prompts** loaded on demand when the agent routes to a specific workflow.
4. **A vault path** in environment or config.

All four are user-configured. The SDK does not auto-configure any harness; that would create version-coupling between Dome and the harness.

## Why this design

The interface-agnostic principle — Dome works with *any* MCP-capable agent harness — is what makes Dome durable across the agentic-tool churn. When a better harness ships (Cursor's growth, OpenCode's adoption, Claude Desktop's arrival, whatever ships in 2027), the user adopts it. Dome's value doesn't drop — the vault and the SDK are durable; only the harness changes.

This has three structural payoffs:

- **No lock-in to one vendor.** Dome doesn't ship its own chat surface in v0.5. It mounts wherever the user already lives.
- **Multi-harness usage is natural.** Same vault, Claude Code on one machine and Cursor on another. Both speak MCP; both see the same Tools.
- **The SDK is the contract** — even when the user invokes a Tool from inside Dome's own headless agent loop (for `dome lint` or `dome export-context`), the path is the same: harness → MCP → SDK Tool. No "internal" path that skips the protocol.

System prompts are markdown files, not harness-specific code. Every harness loads `system-base.md` the same way. Dome ships a `CLAUDE.md` template for Claude Code; other harnesses have their equivalents (referenced in this spec's table). Per-harness setup is documentation, not SDK code — the SDK doesn't auto-configure anything; that would create harness-version coupling.

For v1+, this design lets native mobile / desktop / web / voice clients sit on the same SDK contract via MCP (or direct SDK import for embedded contexts). The mobile app doesn't embed an agent harness; it speaks MCP to a Dome server (local or remote). Cross-AI handoff (`dome export-context`) extends the same principle to "send context to a different agent product entirely."

## Related

- [[wiki/specs/sdk-surface]] — the Tool contract harnesses consume.
- [[wiki/specs/mcp-surface]] — the MCP server harnesses connect to.
- [[wiki/specs/prompts-and-workflows]] — the prompts harnesses load.
- [[wiki/gotchas/concurrent-harness-write]] — two harnesses in one vault race.
