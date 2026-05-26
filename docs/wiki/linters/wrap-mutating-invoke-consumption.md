---
type: linter
created: 2026-05-26
updated: 2026-05-26
sources: ["[[cohesive/reviews/2026-05-26-dome-v0.5-second-pass-label-tightening-rewrite-validation]]"]
tier: deferred
target_version: v0.5.1+
---

# wrap-mutating-invoke-consumption

**Status:** Deferred to v0.5.1+. The structural enforcement that v0.5 ships is the single-source helper [[wiki/specs/sdk-surface]] §"Hook dispatch is intrinsic" + the two integration tests named in [[wiki/invariants/HOOK_DISPATCH_IS_VAULT_BOUND]] §"Structural enforcement". This linter closes a gap those structures cannot: a byte-equivalent hand-inlined duplicate of the wrap that happens to be correct at merge time but drifts when `wrapMutatingInvoke` is next changed.

**Severity:** Blocker — a violation produces silent hook-dispatch divergence across projections, which corrupts the substrate's audit trail and breaks the [[wiki/invariants/HOOK_DISPATCH_IS_VAULT_BOUND]] axiom.

**What it checks:** Every projection of `TOOL_REGISTRY` (every function that returns a shape whose keys are the canonical Tool names and whose values are async functions producing `ToolReturn<T>`) consumes `wrapMutatingInvoke` rather than implementing the post-invoke dispatch loop inline.

Programmatic detection: walk the project's `src/` AST; identify each function whose return type is structurally a `Record<ToolName, (...) => Promise<ToolReturn<...>>>` (or a subset matching the mutating-Tool names from `MUTATING_TOOL_NAMES`); assert that each such function transitively calls `wrapMutatingInvoke`. The check fails when an async value in the returned record contains a `vault.dispatchEvents(...)` call that is not inside `wrapMutatingInvoke`.

**What closes a violation:** Refactor the projection to invoke `wrapMutatingInvoke(vault, entry, writer)` and use its return value as the per-Tool function. Remove the inline `vault.dispatchEvents(...)` call from the projection's body.

**Why it's deferred to v0.5.1+:** v0.5 ships two projections (`bindTools` for `vault.tools`; `bindAiSdkTools` for `projectAiSdk(vault)`) plus one renderer (`renderMcp`), and the two integration tests cover the two-projection surface. A third projection is the trigger for the linter — at three+ projections, reviewer attention as the enforcement seam stops scaling. The linter is the structural fence that ships before `@dome/sdk/http` (the most-anticipated third renderer) lands.

**Convention until the linter ships:** Every projection ships its own hook-dispatch integration test parallel to `tests/integration/ai-sdk-hook-dispatch.test.ts`. Reviewers reject pull requests for new projections that don't include the analog test. The convention is enforced by reviewer attention; the linter promotes it to structural enforcement.

**Related:**

- [[wiki/invariants/HOOK_DISPATCH_IS_VAULT_BOUND]] — the axiom this linter enforces
- [[wiki/specs/sdk-surface]] §"Hook dispatch is intrinsic" — the helper this linter pins consumption of
- [[wiki/matrices/consumer-surface]] — the projection set the linter walks
