---
type: gotcha
created: 2026-05-27
updated: 2026-06-09
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"]
severity: high
coverage: off-matrix
enforced_at: tests/integration/bundle-deps.test.ts
first_observed: 2026-05-26 (closed at v0.5+phase1+phase3; pin maintained in v1)
---

# Transitive LLM dependency

**Symptom:** A consumer that imports only the Submit + Recall surface from `@dome/sdk` (e.g., a v2 mobile shell that wants typed markdown storage with no LLM) finds `@ai-sdk/anthropic` and `@modelcontextprotocol/sdk` in their bundle. The bundle is ~MB larger than the consumer expected; bundle analyzers point at transitively-pulled imports from `@dome/sdk` core.

**Severity:** High — silently bloats every v1+ consumer shell. The risk is that the `@dome/sdk` core entrypoint re-exports symbols whose implementation transitively pulls in LLM or MCP packages, defeating the entrypoint split.

**Root cause:** The four core types (Vault, Proposal, Processor, Effect) are conceptually sealed (per [[wiki/specs/sdk-surface]] §"The four concepts"), but the **packaging boundary** has to be enforced — every re-export from `src/index.ts` is a transitive-deps risk. A garden-LLM processor that depends on `ai` lives inside an extension bundle directory and is loaded dynamically; the static import graph of `src/index.ts` stays clean by construction.

**Structural mitigation:** Two layers:

1. **The [[wiki/invariants/ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY]] axiom** pins the contract: `@dome/sdk` core (the engine, processor runtime, projection store, run ledger, outbox, capability broker, the four core types) may not transitively depend on `@ai-sdk/anthropic`, `ai`, or `@modelcontextprotocol/sdk`. Structurally enforced by `tests/integration/bundle-deps.test.ts`.

2. **The entrypoint split.** Current v1 exports keep `src/index.ts` clean and
   route LLM use through runtime/provider injection plus extension bundles:
   - `@dome/sdk` — core types, effect constructors, processor authoring helpers,
     adopted-ref read helpers, bundle-loader helpers, and pure engine
     commit-trailer helpers. It does not export a public submit API or protocol
     adapters.
   - Companion entrypoints depend on protocol/model libraries explicitly and
     are not imported from the package root. `@dome/sdk/mcp` (`src/mcp/`) is
     the first shipped one: it depends on `@modelcontextprotocol/sdk` and is
     reached only via the `dome mcp` verb's dynamic import. `@dome/sdk/http`
     and provider packages remain future shapes.

   The target `Vault` wrapper exposes Recall (`query`, `readDocument`,
   `resolveWikilink`) plus engine control (`sync`, `rebuild`,
   `getAdoptionStatus`) and lifecycle (`close`; future `drainProcessors`).
   Writes remain git-native plus engine-internal Proposal construction. There
   is no public `submitProposal` surface in v1.0.

**Specific scenarios:**

- **v2 mobile shell** importing the target `openVault` wrapper plus Recall/query helpers → core only; no Anthropic, no MCP. Bundle stays small.
- **v2 web/HTTP shell** wanting search-only over a vault → core only. If it later adds an HTTP transport, it imports `@dome/sdk/http` (when that ships) for the adapter pattern.
- **Plugin SDK author** writing a custom garden-LLM processor → imports `@dome/sdk` for processor/effect types and depends explicitly on whatever provider adapter or model library the processor needs. The split lets them pay only for what they use.
- **Test harness** that spins up a Vault to validate an adoption-phase processor → core only. The eval suite at `tests/fixtures/eval-inputs/` was always supposed to be an internal `@dome/sdk/workflows` consumer when it touches garden-LLM, not a core consumer.

**Operational notes:**

- The `bundle-deps.test.ts` regression test introspects the import graph from `src/index.ts` and asserts none of the forbidden packages appear. It runs on every PR; CI blocks regressions before merge.
- Bundlers that tree-shake (esbuild, Rollup, Bun's bundler) won't actually pull dead code from `@dome/sdk` if the consumer doesn't reach it — but tree-shaking is a runtime optimization, not a contract. The invariant + test pin the contract; tree-shaking is a happy side effect.
- `package.json` listing `@modelcontextprotocol/sdk` is **not** a regression:
  the manifest entry serves the `src/mcp/` companion entrypoint, and the
  bundle-deps walk from `src/index.ts` proves consumers of the core never pull
  it. The fence is the entrypoint graph, not the manifest (per the invariant's
  2026-06-09 scoping).
- First-party `dome.*` extension bundles ship processor TypeScript inside
  `assets/extensions/dome.*/processors/`; model-capable processors receive
  `ctx.modelInvoke` only when their manifest capabilities and runtime provider
  configuration allow it. The bundle loader imports processors at runtime, but
  the package-root static graph stays free of model and MCP packages.

**Related:**
- [[wiki/invariants/ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY]] (the axiom)
- [[wiki/specs/sdk-surface]] §"Dependency list" + §"Consumer surfaces"
- [[wiki/matrices/protocol-adapter]] (which entrypoint each shell uses)
- [[wiki/specs/harnesses]] §"Future-harness pressure (v2+, non-normative integration points)"
