---
type: invariant
created: 2026-05-27
updated: 2026-07-17
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
description: The @marktoda/dome root entrypoint's static import graph pulls in no LLM or MCP packages; enforced by tests/integration/bundle-deps.test.ts
enforced_by:
  - tests/integration/bundle-deps.test.ts
tier: axiom
---

# ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY

**Tier:** Axiom — non-disable-able.

**Statement:** The `@marktoda/dome` root entrypoint (engine, processors runtime, projection store, run ledger, outbox, capability broker, the four core types) does not statically import `@ai-sdk/anthropic`, `ai`, or `@modelcontextprotocol/sdk` anywhere in its transitive module graph — the fence is the **static import graph of `src/index.ts`**. The shipped assistant HTTP/agent host under `src/assistant/` and the MCP protocol adapter live outside that graph. The MCP adapter ships as a companion entrypoint (`src/mcp/`, exposed as `@marktoda/dome/mcp` and the `dome mcp` CLI verb, per [[wiki/specs/mcp-surface]]); it is not exported from the package root, and the CLI dispatcher reaches it only via dynamic import. The single npm package still installs `ai` and `@ai-sdk/anthropic` for the assistant host and `@modelcontextprotocol/sdk` for MCP; dependency installation is not what this invariant fences. The first-party vault command-provider asset uses plain `fetch` and adds no SDK dependency.

This invariant replaces v0.5's `CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY`. The renaming is precise: in v1 the entrypoint is "the engine" — the four core types plus the adoption machinery — not "the SDK core entrypoint." The substrate fence is the same; the name now reflects what the boundary protects.

**Why:** Future native shells (mobile, desktop, voice, web) construct against `@marktoda/dome` core for read + Submit. Their root module graph and application bundle should pay only for the engine — no statically reachable `ai` package or MCP machinery. The npm installation may contain those packages for other entrypoints; the protected property is reachability from the root entrypoint, not installation footprint.

The same property protects test isolation: integration tests for the engine run without LLM credentials. Adoption-loop tests, capability-enforcement tests, projection-rebuild tests — none of them require model access.

**Structural enforcement:**

1. **The fence is the core entrypoint's static import graph, not the dependency manifest** *(scoped 2026-06-09, wedge Phase 5)*. `package.json` lists `ai` and `@ai-sdk/anthropic` for the shipped assistant HTTP/agent host, and `@modelcontextprotocol/sdk` for the MCP companion entrypoint. What the invariant protects is that the **engine** stays MCP/LLM-free: a consumer importing `@marktoda/dome` through `src/index.ts` must not make those packages statically reachable in its application graph. The earlier phrasing ("the `dependencies` list excludes …") conflated install inventory with module reachability; this invariant makes no dependency-manifest or install-size claim.
2. **`tests/integration/bundle-deps.test.ts` walks the transitive import graph of `src/index.ts` and asserts no `node_modules` path under those package names.** A re-export from `src/index.ts` that pulls in `ai` (e.g., re-exporting `projectAiSdk` from workflows) fails the test.
3. **`tests/integration/public-surface-shape.test.ts` asserts the symbols exported from `src/index.ts` match an allowlist** that excludes any LLM/MCP-flavored types. Adding an `@ai-sdk` symbol to the public surface fails the test.
4. **A future v1.x semantic linter `no-engine-internal-llm-import`** (proposed; not yet authored as a spec file) would grep `src/engine/`, `src/processors/`, `src/projections/`, `src/ledger/`, `src/outbox/`, `src/capabilities/` for any import from the LLM/MCP package names; until that linter ships, the bundle-deps test is the enforcement.

**Off-matrix lockstep convention:** The lockstep test at `tests/invariants/engine-has-no-llm-or-mcp-dependency.test.ts` uses the delegating-stub shape:

```ts
import { describe, test } from "bun:test";

describe("ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY (off-matrix)", () => {
  test("enforced by tests/integration/bundle-deps.test.ts", async () => {
    await import("../integration/bundle-deps.test");
  });
});
```

**Counter-example:** `src/assistant/agent.ts` and `src/assistant/agent-work.ts` statically import `ai` and `@ai-sdk/anthropic` for the shipped assistant HTTP/agent host — and that is fine. `src/http/server.ts` reaches those modules for Product Host agent routes, while nothing under `src/index.ts`'s static graph imports `src/http/` or `src/assistant/`. Garden-phase processors instead call the provider-neutral `ctx.modelInvoke` seam. The first-party `.dome/model-provider.ts` template copied from `assets/model-providers/anthropic.ts` calls Anthropic with plain `fetch`; it does not import either SDK.

**Second counter-example (the shipped MCP adapter):** `src/mcp/server.ts` statically imports `@modelcontextprotocol/sdk` — and that is fine. The module is reached only through the `dome mcp` Commander action's dynamic `import("./commands/mcp")`, and nothing under `src/index.ts`'s static graph imports `src/mcp/`. The bundle-deps walk from `src/index.ts` never sees the MCP package; a regression that re-exported `createDomeMcpServer` from `src/index.ts` would fail the test with the offending chain.

**Test guarantee:** `tests/invariants/engine-has-no-llm-or-mcp-dependency.test.ts` delegates per the off-matrix convention; `tests/integration/bundle-deps.test.ts` is the canonical enforcement.

**Related:**
- [[wiki/specs/sdk-surface]] §"Dependency list"
- [[wiki/gotchas/transitive-llm-dependency]]
- [[wiki/matrices/protocol-adapter]] — MCP as one row
