---
type: invariant
created: 2026-05-27
updated: 2026-07-03
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
description: Processor.run returns only Effect[] — no side effects; ProcessorContext has no writers and the processor-purity lint bans mutation imports
enforced_by:
  - tests/processors/runtime.test.ts
  - tests/processors/executor.test.ts
tier: axiom
---

# EFFECTS_ARE_THE_ONLY_PROCESSOR_OUTPUT

**Tier:** Axiom — non-disable-able.

**Statement:** A `Processor.run(ctx)` function returns `Promise<Effect[]>` and nothing else. Processors do not perform side effects. They do not call writers, git, SQLite, network APIs, or any mutation primitive. The engine routes the returned effects through capability enforcement and applies them.

**Why:** The snapshot-in-effects-out contract is what makes processors reviewable, testable, and substitutable. A processor that wrote to disk directly would carry the engine's full responsibility (capability checks, diagnostics, ledger) without the engine's guarantees. The closed boundary is what lets the engine reason about provenance: every change traces to an Effect; every Effect to a processor's emission.

**Structural enforcement:**

1. **`ProcessorContext` interface has no mutation surface.** TypeScript's structural typing makes a `Processor.run` body that tries to `ctx.write(...)` or `ctx.git.commit(...)` fail compilation — the methods don't exist on the type.
2. **Processor constructors freeze the executable surface.** `defineProcessorImplementation(...)` freezes implementation exports; legacy `defineProcessor(...)` freezes full Processor exports. Reassigning `run` after definition fails.
3. **The engine never gives a processor a writer reference.** `ProcessorContext` carries `snapshot` (read-only), `changedPaths` (read-only), `capabilities` (an opaque token), `now()` (host-clock read), `modelInvoke?` (an LLM-call function), `sourceRef` (a helper) — no `writer`, no `db`, no `git`.
4. **The semantic linter `processor-purity`** ([[wiki/linters/processor-purity]]) statically inspects every file under `assets/extensions/*/processors/` and `<vault>/.dome/extensions/*/processors/` for imports of mutation modules (`node:fs`, `bun:sqlite`, `isomorphic-git`, etc.). Imports outside an allowlist (Zod, type-only imports from `@dome/sdk`) fail the lint.

**Counter-example:** A processor that imports `node:fs/promises` and calls `fs.writeFile(...)` inside `run()`. The semantic linter rejects the import. If it slipped through, the snapshot the processor reads from is a *committed* tree, not the working tree — `fs.writeFile` would only mutate the working tree (not the commit the engine builds the candidate from), so the write would be invisible to adoption and surface as a `vault.out-of-band-edit` event on the next watcher cycle. Either way, the effect of the bypass is "user notices and reports the broken processor"; the engine's invariants stay intact.

**Test guarantee:** `tests/invariants/effects-are-the-only-processor-output.test.ts` (off-matrix; delegates to `tests/integration/processor-purity.test.ts`) — typechecks that every shipped-default processor's `run` body uses only the allowed `ProcessorContext` surface.

## Implementation status

The type-level, construction-time, runtime-validation, and first-party lint
fences are current v1 behavior.

- **`ProcessorContext` has no mutation surface.** The type in
  `src/core/processor.ts` carries read/query inputs such as `snapshot`,
  `changedPaths`, `proposal`, `runId`, `input`, `now`, optional
  `modelInvoke`, and SourceRef helpers. It does not expose writers, git,
  SQLite, or filesystem handles.
- **Processor implementation exports are freeze-locked.** New bundle modules
  use `defineProcessorImplementation(...)`; legacy full-Processor modules may
  still use `defineProcessor(...)`. In both cases `run` is frozen after
  definition, while manifest metadata remains the reviewable source of truth.
- **`run` returns `Promise<Effect[]>`.** The Effect union is closed at ten
  kinds and `src/engine/core/apply-effect.ts` exhaustively routes them.
- **Effect schemas validate at the executor boundary.** Invalid processor
  output becomes a nominal processor failure/diagnostic rather than reaching
  the router.
- **`tests/integration/processor-purity.test.ts` is active.** It scans
  first-party processor files under `assets/extensions/*/processors/` for
  mutation-capable imports and obvious write calls.

**Related:**
- [[wiki/specs/processors]] §"What a processor cannot do"
- [[wiki/specs/effects]]
- [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]]
- [[wiki/invariants/PROPOSALS_ARE_THE_ONLY_WRITE_PATH]]
