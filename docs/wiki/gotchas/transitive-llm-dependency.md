---
type: gotcha
created: 2026-05-26
updated: 2026-05-26
sources: ["[[cohesive/reviews/2026-05-26-dome-v0.5-cohesion-architecture-review]]"]
severity: high
coverage: off-matrix
first_observed: 2026-05-26
---

# transitive-llm-dependency

**Symptom:** A consumer that imports only Vault + Tools from `@dome/sdk` (e.g., a v1 mobile shell that wants typed markdown storage with no LLM) finds `@ai-sdk/anthropic` and `@modelcontextprotocol/sdk` in their bundle. The bundle is ~MB larger than the consumer expected; bundle analyzers point at transitively-pulled imports from `@dome/sdk` core.

**Severity:** High — silently bloats every v1+ consumer shell. Pre-Phase-B, the core entrypoint at `src/index.ts` re-exported `runWorkflow`, `WorkflowRegistry`, `DomeMcpServer`, and constructed `vault.aiTools` / `vault.toolParsers` eagerly inside `openVault`. A consumer importing `openVault` reached `tools/registry.ts`, which imports `ai`, which transitively imports `@ai-sdk/anthropic` (the Vercel adapter Dome uses) and its `@anthropic-ai/sdk` peer. The chain ran for every consumer regardless of whether they used the LLM-driven surface.

**Root cause:** The four-concept core was conceptually sealed (Vault, Document, Tool, Hook are the only primitives — see [[wiki/specs/sdk-surface]] §"The four concepts"), but the **packaging boundary** was not. LLM-driven workflows and the MCP server are *built on top of* the four concepts, but they shared the same entrypoint, so the bundler couldn't distinguish them.

**Structural mitigation:** Two layers:

1. **The [[wiki/invariants/CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY]] axiom** pins the contract: `@dome/sdk` core may not transitively depend on `@ai-sdk/anthropic`, `ai`, or `@modelcontextprotocol/sdk`. Structurally enforced by `tests/integration/bundle-deps.test.ts`.

2. **The entrypoint split.** Four entrypoints replace the prior two:
   - `@dome/sdk` — core (Vault, Document, Tool, Hook, the seven Tools, hook dispatcher, reconcile, watcher, types, registrations)
   - `@dome/sdk/workflows` — LLM-driven surface (`runWorkflow`, `WorkflowRegistry`, `PromptLoader`, `projectAiSdk(vault)`, `@ai-sdk/anthropic` + `ai` deps)
   - `@dome/sdk/mcp` — MCP server surface (`DomeMcpServer`, `buildConsumerSurface(vault)`, adapters, `@modelcontextprotocol/sdk` dep)
   - `@dome/sdk/cli` — CLI shell (`runCli`, the seven `dome*` command functions; consumes `commander`)

   `Vault` itself sheds `aiTools` and `toolParsers` — those projections live in entrypoint-scoped functions (`projectAiSdk(vault)`, `projectMcp(vault)`) consumers reach explicitly.

**Specific scenarios:**

- **v1 mobile shell** importing `openVault` + the seven Tools → core only; no Anthropic, no MCP. Bundle stays small.
- **v1 web/HTTP shell** wanting search-only over a vault → core only. If it later adds an HTTP transport, it imports `@dome/sdk/mcp` (or a future `@dome/sdk/http`) for the adapter pattern.
- **Plugin SDK author** writing a custom Tool that needs the AI SDK → imports `@dome/sdk` for Vault/Document/Tool types AND `@dome/sdk/workflows` for `projectAiSdk(vault)`. The split lets them pay only for what they use.
- **Test harness** that spins up a Vault to validate a Tool → core only. The eval suite at `src/eval/` was always supposed to be an internal `@dome/sdk/workflows` consumer, not a core consumer.

**Operational notes:**

- The `bundle-deps.test.ts` regression test introspects the import graph from `src/index.ts` and asserts none of the forbidden packages appear. It runs on every PR; CI will block a regression before merge.
- Bundlers that tree-shake (esbuild, Rollup, Bun's bundler) won't actually pull dead code from `@dome/sdk` if the consumer doesn't reach it — but tree-shaking is a runtime optimization, not a contract. The invariant + test pin the contract; tree-shaking is a happy side effect.
- The split affects **internal** dome callers too: `src/cli/commands/lint.ts` etc. previously imported `runWorkflow` from a sibling path; post-Phase-B, those CLI commands live in `@dome/sdk/cli` which depends on `@dome/sdk/workflows` for the LLM-driven flow.

**Related:**
- [[wiki/invariants/CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY]] (the axiom)
- [[wiki/specs/sdk-surface]] §"Distribution" + §"Consumer surfaces"
- [[wiki/matrices/consumer-surface]] (which entrypoint each shell uses)
- [[wiki/specs/harnesses]] §"Future-harness pressure"
- [[cohesive/reviews/2026-05-26-dome-v0.5-cohesion-architecture-review]] — Phase B closed this gotcha
