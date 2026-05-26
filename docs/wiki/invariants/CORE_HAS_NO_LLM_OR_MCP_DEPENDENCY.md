---
type: invariant
created: 2026-05-26
updated: 2026-05-26
sources: ["[[cohesive/reviews/2026-05-26-dome-v0.5-cohesion-architecture-review]]"]
tier: axiom
---

# CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY

**Tier:** Axiom — non-disable-able. Disabling this changes what `@dome/sdk` is.

**Statement:** The `@dome/sdk` core entrypoint (`src/index.ts`) does not transitively depend on `@anthropic-ai/sdk`, `ai` (Vercel AI SDK), or `@modelcontextprotocol/sdk`. A consumer importing only `openVault`, `readDocument`, `writeDocument`, or any other symbol exported from the core entrypoint pulls none of those packages into their bundle.

LLM-driven workflows live in `@dome/sdk/workflows`. The MCP server and its adapters live in `@dome/sdk/mcp`. The CLI shell lives in `@dome/sdk/cli`. Consumers that need one of those surfaces import from that entrypoint explicitly; the core stays narrow.

**Why:** Dome is positioned as substrate for personal knowledge that survives across consumer shells (CLI today; mobile, desktop, voice, web in v1+). A v1 mobile shell that uses Dome only as a typed markdown store has no use for Anthropic's SDK or the MCP protocol — but pre-Phase-B, importing `openVault` transitively pulled both into the shell's bundle (~MB of JS, plus the cognitive cost of "what is this and why is it shipping"). The axiom is the structural mitigation: it pins the boundary that makes v1+ surface extensibility feasible.

The invariant is also what makes the **substrate-shape** of dome's design coherent: the four-concept core (Vault, Document, Tool, Hook) is sealed at both the conceptual layer ([[wiki/specs/sdk-surface]] §"The four concepts") AND the package-bundling layer (this invariant). Without the bundling layer, the conceptual seal is honored only by reviewer attention.

**Structural enforcement:** `tests/integration/bundle-deps.test.ts` introspects the transitive dependency set of the `@dome/sdk` core entrypoint at test time. The set must not contain `@anthropic-ai/sdk`, `ai`, or `@modelcontextprotocol/sdk`. A regression — e.g., a future contributor adding `import { runWorkflow } from "./workflows/agent-loop"` to `src/index.ts` — produces an import chain that pulls `ai` into core; the test catches the chain and reports the violating import path.

The invariant is off-matrix for the Tool × invariant matrix (no Tool refuses an invariant-violating call). Enforcement happens at the bundling boundary, not the call-site boundary.

**Counter-example:** A v1 mobile-app contributor imports `openVault` and `writeDocument` from `@dome/sdk` to build a Dome-aware notes view. Their bundle analyzer reports `@anthropic-ai/sdk` adds 480 KB. They open `node_modules/@dome/sdk/dist/index.js`, find a transitive import from `./workflows/agent-loop`, and discover the core re-exports `runWorkflow`. Either (a) they accept the bloat and ship a slow mobile app, (b) they fork `@dome/sdk` to strip the LLM dep, or (c) they file a regression issue. With the invariant in place, (a) and (b) never happen; the bundle-deps test fails in CI before the regression merges.

**Test guarantee:** `tests/integration/bundle-deps.test.ts` — uses Bun's transitive-import introspection (or a dependency-graph walker over `src/index.ts`) to assert the core entrypoint excludes the three forbidden packages. The test runs on every PR; failing it blocks merge.

**Consumer-surface matrix:** [[wiki/matrices/consumer-surface]] documents which entrypoint each consumer shell uses to reach the symbols it needs.

**Related:**
- [[wiki/specs/sdk-surface]] §"Distribution" (the four entrypoints)
- [[wiki/specs/sdk-surface]] §"Consumer surfaces" (the ConsumerSurface concept)
- [[wiki/gotchas/transitive-llm-dependency]] (the scar this invariant guards against)
- [[wiki/matrices/consumer-surface]] (which entrypoint each shell uses)
- [[wiki/specs/harnesses]] §"Future-harness pressure" (the v1+ consumers the invariant exists for)
