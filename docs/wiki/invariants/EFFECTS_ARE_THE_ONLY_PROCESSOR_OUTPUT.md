---
type: invariant
created: 2026-05-27
updated: 2026-05-27
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"]
tier: axiom
---

# EFFECTS_ARE_THE_ONLY_PROCESSOR_OUTPUT

**Tier:** Axiom — non-disable-able.

**Statement:** A `Processor.run(ctx)` function returns `Promise<Effect[]>` and nothing else. Processors do not perform side effects. They do not call writers, git, SQLite, network APIs, or any mutation primitive. The engine routes the returned effects through capability enforcement and applies them.

**Why:** The snapshot-in-effects-out contract is what makes processors reviewable, testable, and substitutable. A processor that wrote to disk directly would carry the engine's full responsibility (capability checks, diagnostics, ledger) without the engine's guarantees. The closed boundary is what lets the engine reason about provenance: every change traces to an Effect; every Effect to a processor's emission.

**Structural enforcement:**

1. **`ProcessorContext` interface has no mutation surface.** TypeScript's structural typing makes a `Processor.run` body that tries to `ctx.write(...)` or `ctx.git.commit(...)` fail compilation — the methods don't exist on the type.
2. **`defineProcessor(...)` is the only construction path.** The function freezes the returned object; reassigning `processor.run` after definition fails.
3. **The engine never gives a processor a writer reference.** `ProcessorContext` carries `snapshot` (read-only), `changedPaths` (read-only), `capabilities` (an opaque token), `modelInvoke?` (an LLM-call function), `sourceRef` (a helper) — no `writer`, no `db`, no `git`.
4. **The semantic linter `processor-purity`** ([[wiki/linters/processor-purity]]) statically inspects every file under `assets/extensions/*/processors/` and `<vault>/.dome/extensions/*/processors/` for imports of mutation modules (`node:fs`, `bun:sqlite`, `isomorphic-git`, etc.). Imports outside an allowlist (Zod, type-only imports from `@dome/sdk`) fail the lint.

**Counter-example:** A processor that imports `node:fs/promises` and calls `fs.writeFile(...)` inside `run()`. The semantic linter rejects the import. If it slipped through, the snapshot the processor reads from is a *committed* tree, not the working tree — `fs.writeFile` would only mutate the working tree (not the commit the engine builds the candidate from), so the write would be invisible to adoption and surface as a `vault.out-of-band-edit` event on the next watcher cycle. Either way, the effect of the bypass is "user notices and reports the broken processor"; the engine's invariants stay intact.

**Test guarantee:** `tests/invariants/effects-are-the-only-processor-output.test.ts` (off-matrix; delegates to `tests/integration/processor-purity.test.ts`) — typechecks that every shipped-default processor's `run` body uses only the allowed `ProcessorContext` surface.

## Implementation status

**As of Phase 1+2 (Processor type defined; runtime + bundle loader + linter not yet wired):**

The type-level fence is real today; the runtime + lint fences ship as the processor runtime and bundles arrive in later phases.

- Structurally true now:
  - **`ProcessorContext` has no mutation surface.** The type in `src/core/processor.ts` carries `snapshot`, `changedPaths`, `proposal`, `runId`, `input`, `capabilities` (opaque `CapabilityToken` brand), `modelInvoke?` (optional), and `sourceRef` (helper). No `writer`, no `db`, no `git`, no `fs`. TypeScript's structural typing makes a `Processor.run` body that calls `ctx.write(...)` or `ctx.git.commit(...)` fail compilation today.
  - **`run` returns `Promise<Effect[]>`.** The `Processor` type's `run` field is `(ctx: ProcessorContext<TInput>) => Promise<Effect[]>` — the return type is fixed and the Effect union is closed (7 kinds, exhaustive switch in the engine).
  - **`CapabilityToken` is structurally opaque** — `{ readonly __brand: "CapabilityToken" }` — so processor code cannot inspect or unwrap it to reach the broker directly.
  - **Effect schemas validate at the engine boundary** (`src/core/effect.ts` Zod schemas) — a processor that constructs an Effect with a wrong shape fails Zod parsing before reaching the router.

- Forward-looking (lands in later phases):
  - **`defineProcessor(...)` does not yet exist.** The `Processor` and `ProcessorContext` types are declared, but the helper that freezes the returned object (bullet 2) ships with the Phase 3 processor runtime. Until then, processor literals are not freeze-locked at construction time.
  - **The semantic linter `processor-purity`** ([[wiki/linters/processor-purity]]) is a reviewable spec but not yet a CI check. It ships in Phase 10 cleanup. Until then, the import-allowlist on processor files is reviewer-enforced.
  - **No first-party processors live under `assets/extensions/*/processors/` yet.** The shipped-default hooks migrate into bundle-form processors in Phase 6; the linter's scan target only becomes populated then.
  - **`tests/integration/processor-purity.test.ts`** (and its lockstep stub) ship once the first first-party processor bundle lands (Phase 6).
  - **Engine never gives a processor a writer reference** (bullet 3) is structurally true on the type today — but becomes an operational claim only when the Phase 3 runner actually constructs `ProcessorContext` instances and hands them to processors. Until then, no processor is invoked through the engine.

The type-level chokepoint is in place; the *runtime + lint coverage* layers stack on top as Phases 3, 6, and 10 ship.

**Related:**
- [[wiki/specs/processors]] §"What a processor cannot do"
- [[wiki/specs/effects]]
- [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]]
- [[wiki/invariants/PROPOSALS_ARE_THE_ONLY_WRITE_PATH]]
