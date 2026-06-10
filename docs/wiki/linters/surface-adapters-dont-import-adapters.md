---
type: linter
created: 2026-06-10
updated: 2026-06-10
sources:
  - "[[cohesive/reviews/2026-06-10-oop-abstraction-layers-architecture-review]]"
---

# surface-adapters-dont-import-adapters

**Status:** v1 substrate; the structural fence behind [[wiki/specs/sdk-surface]] §"Consumer surfaces".

**Statement:** Protocol adapters never import other protocol adapters, and the shared surface layer never imports an adapter. Concretely: no file under `src/mcp/` or `src/http/` imports from `src/cli/` or from each other; no file under `src/cli/` imports from `src/mcp/` or `src/http/` except the host shims `src/cli/commands/mcp.ts` and `src/cli/commands/http.ts` (each exists to host its verb and is loaded via dynamic import by the Commander dispatcher, keeping the CLI's static graph adapter-free); no file under `src/surface/` imports from `src/cli/`, `src/mcp/`, or `src/http/`.

## What it checks

A static import-graph walk over `src/{surface,cli,mcp,http}/**/*.ts`:

1. **MCP is adapter-clean** — every import in `src/mcp/**` resolves outside `src/cli/`.
2. **CLI is adapter-clean** — every import in `src/cli/**` resolves outside `src/mcp/` and `src/http/`, with the host shims `src/cli/commands/mcp.ts` and `src/cli/commands/http.ts` as the tolerated files: each imports its adapter's server module to host the verb, and the Commander dispatcher reaches them only via dynamic import so the CLI's *static* graph stays adapter-free (for MCP, per [[wiki/invariants/ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY]]).
3. **The surface layer is below adapters** — every import in `src/surface/**` resolves outside `src/cli/`, `src/mcp/`, and `src/http/`.
4. **HTTP is adapter-clean** — every import in `src/http/**` resolves outside `src/cli/`, and `src/mcp/` / `src/http/` never import each other.

## Why this exists

The MCP adapter originally imported its data path from `src/cli/commands/*` — adapter-imports-adapter. That worked for one consumer but taxes every future surface: each would either import the CLI too, or re-derive the `dome.<verb>/v1` documents in parallel. The HTTP adapter ([[wiki/specs/http-surface]]) shipped against `src/surface/` from day one, validating the boundary. The 2026-06-10 architecture review surfaced the mis-homing; the collectors now live in `src/surface/` and this fence keeps the dependency direction from regressing. The failure mode it prevents: a convenience import from a new adapter into an existing one quietly turns one surface into infrastructure for another, and the "thin adapter over one shared boundary" property dissolves.

## Exempt contexts

1. **Test files** under `tests/**` may import anything.
2. **The host shims `src/cli/commands/mcp.ts` and `src/cli/commands/http.ts`** (rule 2 above).

## Implementation

```ts
// tests/integration/surface-adapter-imports.test.ts
// Walks src/{surface,cli,mcp,http}/**/*.ts, resolves every relative import,
// and asserts the direction rules above.
```

## Related

- [[wiki/specs/sdk-surface]] §"Consumer surfaces" — the surface-layer contract this fence protects
- [[wiki/specs/mcp-surface]] §"Architecture" — the thin-adapter shape
- [[wiki/linters/engine-import-direction]] — the sibling direction fence inside `src/engine/`
- [[wiki/invariants/ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY]] — why the MCP entrypoint stays off the core static graph
