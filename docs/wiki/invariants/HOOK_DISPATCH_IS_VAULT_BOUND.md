---
type: invariant
created: 2026-05-26
updated: 2026-05-26
sources: ["[[cohesive/reviews/2026-05-26-dome-v0.5-cohesion-architecture-review-pass-2]]"]
tier: axiom
---

# HOOK_DISPATCH_IS_VAULT_BOUND

**Tier:** Axiom — non-disable-able. Disabling this changes what a Vault is.

**Statement:** Every mutating Tool invocation reachable from a Vault — `vault.tools.X`, `projectAiSdk(vault).X.execute`, `renderMcp(buildAbstractSurface(vault)).tools` MCP-handler invocations, and the analog projections in any future protocol renderer (`renderHttp`, `renderVoice`, `renderGrpc`) — routes through the single-source helper `wrapMutatingInvoke(vault, entry, writer)` in `src/tools/registry.ts`. The helper invokes the Tool, reads `vault.dispatchEvents` lazily off the Vault closure, and calls `vault.dispatchEvents(projectEffectsToEvents(out.effects))` after the invoke when `entry.mutating === true`. No projection re-implements the wrap inline.

A consumer cannot construct a projection of `vault.tools` (or its parser shape, or its AI-SDK shape, or any future protocol shape) where mutating Tools fire effects without dispatching hooks — the wrap is intrinsic to the Vault-bound Tool registry, not a per-projection decorator.

**Why:** Hook dispatch is the only mechanism by which `auto-update-index`, `auto-cross-reference`, declarative-YAML hooks, and any plugin-registered hook learn that the vault changed. If a projection bypasses the wrap, mutations through that projection invisibly skip every downstream reaction: `index.md` stops updating; cross-references stop being added; declarative intakes never fire; quarantine state doesn't persist. The bypass is silent — the file write succeeds, the Tool returns success, no error appears.

Pre-Phase-B, the wrap was duplicated across `bindTools` (in `registry.ts`) and `bindAiSdkTools` (in `ai-sdk-binding.ts`). The duplication was caught by the architecture review and closed structurally by extracting `wrapMutatingInvoke` to a single source. The axiom is the substrate-shape pin that prevents the duplication from reappearing: a future contributor adding a third projection (`projectHttp`, `projectGrpc`, `projectIpc`) consumes the helper rather than inlining the dispatch loop; a future change to the wrap (causation metadata, backpressure gate, a `closed`-flag pre-check that's pin number two of the v0.5 vault.close() lifecycle) is made in one place and inherited by every projection.

The invariant also makes the **substrate-shape** of `AbstractSurface` coherent: `AbstractSurface.tools` is the same `BoundToolSurface` `vault.tools` exposes — one set of hook-dispatch-wrapped Tool entries per Vault, threaded through every renderer. Protocol-rendered projections in `renderMcp` / `renderHttp` / `renderVoice` project from `surface.tools` rather than re-binding the registry, so the wrap inherits by construction.

**Structural enforcement:**

- **The single-source helper.** `wrapMutatingInvoke(vault, entry, writer)` in `src/tools/registry.ts` is the only function in the codebase that constructs the post-invoke `dispatchEvents` call. `bindEntry` (the bindTools internal that populates `vault.tools`) consumes it; `bindAiSdkTools` consumes it; protocol renderers (`renderMcp` and future siblings) consume `surface.tools` rather than re-binding (so they inherit the wrap by construction). A future contributor copying the dispatch logic inline produces a duplicate that the review process should catch — and that the tests below would catch at runtime if the duplicate diverges.
- **`tests/integration/mcp-hook-dispatch.test.ts`** — asserts a `writeDocument` invocation through the MCP-rendered surface triggers `auto-update-index` (i.e., the index gets updated as a hook-side-effect of the MCP-shaped write).
- **`tests/integration/ai-sdk-hook-dispatch.test.ts`** — asserts a `writeDocument` invocation through `projectAiSdk(vault)` triggers `auto-update-index`. Parallel to the MCP test; the AI-SDK path is the second projection of the registry the helper has to cover.

The invariant is **off-matrix** for the Tool × invariant matrix (no Tool refuses an invariant-violating call). Enforcement happens at the projection-construction boundary, not the call-site boundary.

**Counter-example:** A v1+ contributor adds `@dome/sdk/http` with `renderHttp(surface): HttpSurface`. In their first pass they implement the per-Tool POST handler by reading `entry.handler` from `TOOL_REGISTRY` directly (skipping `surface.tools`), then writing their own post-invoke `vault.dispatchEvents(...)` call. A subsequent change to `wrapMutatingInvoke` — say, adding a `causationId` field to the dispatched events for observability — is applied to the helper. `vault.tools` and `projectAiSdk(vault)` inherit the change; `renderMcp.tools` inherits it (because it projects from `surface.tools` which calls the helper); the HTTP renderer's hand-written dispatch loop does not. Six months later, observability traces show MCP and AI-SDK writes carry the causation field; HTTP writes don't — and the substrate's audit trail is silently broken on the HTTP path. With the invariant in place (and the AI-SDK test as the structural fence the contributor was expected to mirror), the contributor's pull request would surface the missing `renderHttp.test.ts` analog during review.

**Test guarantee:** `tests/integration/mcp-hook-dispatch.test.ts` and `tests/integration/ai-sdk-hook-dispatch.test.ts` together cover the two v0.5-shipped projections. The AC3 invariant-coverage test at `tests/integration/invariant-coverage.test.ts` accepts these two as the lockstep counterpart for this off-matrix axiom (the same off-matrix-aware mechanism `CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY`, `VAULT_IS_GIT_REPO`, and `INBOX_IS_EPHEMERAL` already use). A future projection ships with its own integration test asserting hook-dispatch for the projection's mutating-Tool path.

**Related:**

- [[wiki/specs/sdk-surface]] §"Hook dispatch is intrinsic" (the spec naming the helper)
- [[wiki/specs/sdk-surface]] §"Consumer surfaces" (the protocol-renderer layer that consumes the wrapped Tools by construction)
- [[wiki/invariants/HOOKS_CANNOT_BYPASS_TOOLS]] (the symmetric direction: hooks observe and propose; Tools mutate)
- [[wiki/matrices/consumer-surface]] (the protocol-renderer column the invariant constrains)
- [[wiki/matrices/tool-invariant-enforcement]] §"`HOOK_DISPATCH_IS_VAULT_BOUND` — projection-enforced (off-matrix)"
