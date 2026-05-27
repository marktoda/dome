---
type: linter
created: 2026-05-27
updated: 2026-05-27
status: v1 (proposed; lockstep check ships in Phase 1 of implementation)
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"]
---

# processor-purity

**Status:** v1 substrate; the structural fence behind [[wiki/invariants/EFFECTS_ARE_THE_ONLY_PROCESSOR_OUTPUT]]. The lockstep check ships as part of Phase 1 of v1 implementation per the brainstorm's "Phasing the cut" section.

**Statement:** TypeScript files under `assets/extensions/*/processors/**/*.ts` (first-party bundles) and `<vault>/.dome/extensions/*/processors/**/*.ts` (vault-local third-party bundles) do not import mutation modules. A processor's `run(ctx)` body uses only the `ProcessorContext` surface; direct filesystem, SQLite, or git access bypasses the engine and violates the snapshot-in-effects-out contract per [[wiki/specs/processors]] §"What a processor cannot do".

## What it checks

The check is a static import-graph walk over the processor file set:

```
assets/extensions/*/processors/**/*.ts
.dome/extensions/*/processors/**/*.ts   (in vault-local CI integrations)
```

For every processor file, the check inspects every `import` and `import()` call, asserts the imported module name is not in the forbidden-module allowlist.

**Forbidden modules:**
- `node:fs`, `node:fs/promises`
- `node:path` (allowed in v1.1+ if path manipulation proves necessary; v1 forbids to keep processors strictly snapshot-driven)
- `bun:sqlite`
- `bun` (for `Bun.write`, `Bun.file`)
- `isomorphic-git` (entire module — processors don't need git access; the engine handles git boundaries)
- `node:child_process` (no shelling out)
- `node:net`, `node:http`, `node:https` (no direct network — `ExternalActionEffect` is the path)

**Allowed modules:**
- `@dome/sdk` — the four core types and the `defineProcessor` helper.
- `@dome/sdk/workflows` — `modelInvoke` integration for garden-LLM processors (these processors need to call the LLM; the engine's `modelInvoke` shim runs the call through capability enforcement).
- `zod` — input validation.
- Bundle-local relative imports (other files in the same bundle).
- Type-only imports from any package (`import type { ... } from "..."`) — these are erased at compile time and carry no runtime dependency.

## Why this exists

[[wiki/invariants/EFFECTS_ARE_THE_ONLY_PROCESSOR_OUTPUT]] requires that a processor's `run(ctx)` body returns `Promise<Effect[]>` without performing side effects. The `ProcessorContext` interface has no mutation surface (no `writer`, no `db`, no `git`); a processor that imports `node:fs` and calls `fs.writeFile` bypasses the entire engine boundary — and with it the capability broker, the ledger, the projection store, the outbox.

The static-import check catches the bypass at bundle-load time (the import would fail before the processor even runs). It also catches it at CI (the linter runs against bundle source files).

The check is per-file (not per-bundle) because a bundle may carry multiple processors and a `manifest.yaml` plus `external-handlers/` (which legitimately *do* call out — they're the side of the bundle that registers external-action implementations, and they live in a separate directory the linter doesn't sweep).

## Exempt contexts

1. **`external-handlers/<capability>.ts`** files — these implement external-capability handlers (calendar.write, notify.push, network.post) and legitimately need network/external access. The linter scopes to `processors/` only.
2. **Type-only imports** — `import type { ... }` is erased at compile.
3. **Files annotated `// @engine-internal: <justification>`** — reserved escape hatch for v1.x cases where a processor needs unusual reach. No current uses; review-gated.

## Why `node:path` is forbidden in v1

Path manipulation in a processor's `run(ctx)` body is almost always a signal that the processor is computing paths to read from or write to outside the snapshot. `ProcessorContext.snapshot.readBlob(path)` and `ProcessorContext.sourceRef(path)` are the two path-using surfaces; both accept vault-relative paths the engine validates. A processor that needs `node:path` is typically:

- Building paths to call external-system APIs → use `ExternalActionEffect` instead; the engine handles path / URL composition for known capabilities.
- Constructing `wiki/...` paths for PatchEffect targets → use plain string concatenation or template literals; the path is a string the engine validates against the processor's capability scope.
- Reading the user's home directory or environment-dependent paths → forbidden; processors run against snapshots, not filesystems.

If a v1.x processor needs `node:path` legitimately, it gets the `// @engine-internal` annotation with a written justification; the v1.x linter check is updated to allow `node:path` under that annotation specifically.

## Implementation sketch (v1 Phase 1)

```ts
// tests/integration/processor-purity.test.ts
import { test, expect } from "bun:test";
import { Glob } from "bun";
import { parseImports } from "../helpers/parse-imports";

const FORBIDDEN = new Set([
  "node:fs", "node:fs/promises", "node:path",
  "bun:sqlite", "bun",
  "isomorphic-git",
  "node:child_process",
  "node:net", "node:http", "node:https",
]);

const ALLOWED = new Set([
  "@dome/sdk", "@dome/sdk/workflows",
  "zod",
]);

test("processor-purity", async () => {
  const violations: string[] = [];
  for await (const file of new Glob("assets/extensions/*/processors/**/*.ts").scan(".")) {
    const imports = await parseImports(file);
    for (const imp of imports) {
      if (imp.typeOnly) continue;
      if (imp.module.startsWith(".")) continue;  // relative imports
      if (ALLOWED.has(imp.module)) continue;
      if (FORBIDDEN.has(imp.module)) {
        violations.push(`${file}: imports ${imp.module}`);
      }
    }
  }
  expect(violations).toEqual([]);
});
```

## Related

- [[wiki/invariants/EFFECTS_ARE_THE_ONLY_PROCESSOR_OUTPUT]] (the invariant this linter enforces)
- [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]] (the parent property at the engine boundary)
- [[wiki/linters/engine-is-sole-applier]] (sister linter; the engine-side fence)
- [[wiki/linters/no-direct-mutation-outside-engine]] (sister linter; catches direct calls)
- [[wiki/specs/processors]] §"What a processor cannot do"
- [[wiki/specs/processors]] §"Registration" (the `defineProcessor` helper)
