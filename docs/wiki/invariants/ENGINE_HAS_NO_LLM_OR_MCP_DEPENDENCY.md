---
type: invariant
created: 2026-05-27
updated: 2026-05-27
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"]
tier: axiom
---

# ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY

**Tier:** Axiom — non-disable-able.

**Statement:** The `@dome/sdk` core entrypoint (engine, processors runtime, projection store, run ledger, outbox, capability broker, the four core types) does not transitively depend on `@ai-sdk/anthropic`, `ai`, or `@modelcontextprotocol/sdk`. Garden-phase LLM-backed processors and the MCP protocol adapter live in separate entrypoints (`@dome/sdk/workflows`, `@dome/sdk/mcp`) and ship those dependencies only when consumed.

This invariant replaces v0.5's `CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY`. The renaming is precise: in v1 the entrypoint is "the engine" — the four core types plus the adoption machinery — not "the SDK core entrypoint." The substrate fence is the same; the name now reflects what the boundary protects.

**Why:** Future native shells (mobile, desktop, voice, web) construct against `@dome/sdk` core for read + Submit. They should pay only for the engine — no transitive `ai` package, no MCP machinery, no `@anthropic-ai/sdk` overhead. A mobile app that only reads markdown and submits Proposals should not pay for an LLM SDK it never invokes.

The same property protects test isolation: integration tests for the engine run without LLM credentials. Adoption-loop tests, capability-enforcement tests, projection-rebuild tests — none of them require model access.

**Structural enforcement:**

1. **`@dome/sdk` core's `package.json` `dependencies` list excludes `ai`, `@ai-sdk/anthropic`, and `@modelcontextprotocol/sdk`.** They live in `@dome/sdk/workflows` and `@dome/sdk/mcp` respectively.
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

**Counter-example:** A garden-phase processor under `assets/extensions/dome.intake/processors/extract-capture.ts` imports `ai`'s `generateText`. The import is fine — the bundle's processor lives outside `@dome/sdk` core. The capability broker's `model.invoke` grant routes the call through `ProcessorContext.modelInvoke`, which is the seam where LLM access enters. The core entrypoint never imports `ai`; the `dome.intake` bundle's runtime does, and the bundle is loaded via dynamic import — the static import graph of `src/index.ts` stays clean.

**Test guarantee:** `tests/invariants/engine-has-no-llm-or-mcp-dependency.test.ts` delegates per the off-matrix convention; `tests/integration/bundle-deps.test.ts` is the canonical enforcement.

**Related:**
- [[wiki/specs/sdk-surface]] §"Dependency list"
- [[wiki/gotchas/transitive-llm-dependency]]
- [[wiki/matrices/protocol-adapter]] — MCP as one row
