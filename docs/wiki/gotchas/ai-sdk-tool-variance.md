---
type: gotcha
created: 2026-05-26
updated: 2026-05-26
sources: ["[[cohesive/reviews/2026-05-26-dome-v0.5-cohesion-architecture-review]]"]
severity: low
coverage: off-matrix
enforced_at: src/tools/registry.ts
enforced_at_status: deferred  # v0.5 path retired; v1 enforcement TBD in later phase
first_observed: 2026-05-26
---

# ai-sdk-tool-variance

**Symptom:** `src/tools/registry.ts:128` constructs an AI SDK `Tool<>` via `tool({...})` and double-casts the return through `unknown`: `tool({ description, inputSchema, execute }) as unknown as Tool<TInput, TOutput>`. Line 215 pairs this with `satisfies Record<ToolName, ToolRegistryEntry<any, any>>` — the `any, any` is a deliberate variance-relaxation. The registry comment at lines 210-214 acknowledges this is a workaround for AI SDK v6's `Tool<I,O>` variance constraints.

**Severity:** Low — the cast is in one place, the boundary is narrow, and the runtime behavior is correct. The risk is **silent regression**: if AI SDK v7+ tightens the `Tool<>` shape (e.g., renames `execute` to `invoke`, or changes the `inputSchema` constraint), the cast keeps compiling against the stale shape while breaking at runtime.

**Root cause:** AI SDK v6 inverted the prior contract — its `Tool<INPUT, OUTPUT>` generic prefers to **infer** the input shape from the Zod schema passed as `inputSchema`, rather than accepting an explicit generic. Dome's `TOOL_REGISTRY` entries declare `Tool<TInput, TOutput>` explicitly because the registry is the single source of truth for "the seven Tools" and the rest of the SDK (bound surface, MCP adapters, workflow runner) consumes the canonical shape. The two viewpoints disagree at the type level; the cast bridges them at runtime.

**Structural mitigation (deferred to the next AI SDK major bump):** Either:

- **Drop the explicit generic.** Let `tool({inputSchema, execute})` infer; return `ReturnType<typeof tool>` from the registry entries. The downstream consumers (MCP adapter, AI-SDK consumer) adapt to whatever shape AI SDK currently exposes. The cost: the `BoundToolSurface` interface at `src/hooks/hook-context.ts:21` may need a parallel rewrite to match inferred shapes, and the explicit `TInput`/`TOutput` per Tool is lost. Acceptable when the AI SDK bump is the trigger.

- **Migrate to Zod v4.** AI SDK v6 actively prefers Zod v4's `infer` semantics (which makes optional-vs-undefined first-class). The `compactX` helpers at `src/tools/schemas.ts:68-121` exist *because* of Zod v3's optional-handling mismatch with `exactOptionalPropertyTypes`; Zod v4 collapses those six helpers into one (or zero). The migration is a multi-day effort and pairs naturally with the AI SDK bump.

Phase B does **not** apply either mitigation. The current cast works for AI SDK v6 stable; reaching for the migration without an external trigger is premature. The gotcha doc exists so a future contributor seeing the cast knows it's a deliberate, documented scar rather than an oversight.

**Specific scenarios:**

- **AI SDK v6.x patch.** No effect. The cast continues to bridge correctly.
- **AI SDK v7 release.** Open the changelog. If `Tool<>` shape changes incompatibly, the registry's TypeScript will compile against the cast but runtime calls into `aiTool.execute(...)` may pass a wrong-shape argument or read a wrong-shape return. The trigger to migrate.
- **A new Tool added to the registry.** No effect — the `entry()` and `readOnly()` helpers absorb the variance via the same cast. The pattern propagates.
- **Plugin author writes a custom Tool.** The plugin's `Tool` type comes from AI SDK directly (Dome doesn't re-export it). If AI SDK v7 changes the shape, plugins may see TypeScript errors that Dome internals don't catch.

**Operational notes:**

- The cast at `registry.ts:128` is paired with the `satisfies Record<ToolName, ToolRegistryEntry<any, any>>` at line 215. Both are part of the same workaround; touching one without the other usually breaks the build.
- The `compactX` helpers in `src/tools/schemas.ts:68-121` are NOT part of this gotcha specifically — they're the Zod-v3-vs-`exactOptionalPropertyTypes` mismatch, a related but distinct scar. The Zod v4 migration mentioned above would close both gotchas in one pass.
- The registry's load-bearing claim (`src/tools/registry.ts:9-13`) is "we use the AI SDK's native `Tool<>`, not a custom ToolDescriptor wrapper." That claim is still true *at the runtime shape level* — the cast doesn't introduce a new type the SDK wouldn't recognize. It just relaxes the static check across the variance gap.

**Related:**
- [[wiki/specs/sdk-surface]] §"Dependencies" (the Zod and AI SDK versions Dome targets)
- [[cohesive/reviews/2026-05-26-dome-v0.5-cohesion-architecture-review]] §F5 (the architecture-review finding that surfaced this scar)
