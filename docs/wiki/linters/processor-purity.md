---
type: linter
description: "Forbids processor files importing fs, sqlite, git, or network modules — run(ctx) must emit Effects only, never side-effect past the engine."
created: 2026-05-27
updated: 2026-05-29
status: v1 (implemented)
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"]
---

# processor-purity

**Status:** v1 substrate; the structural fence behind [[wiki/invariants/EFFECTS_ARE_THE_ONLY_PROCESSOR_OUTPUT]]. The implemented check lives at `tests/integration/processor-purity.test.ts`.

**Statement:** TypeScript files under `assets/extensions/*/processors/**/*.ts` (first-party bundles) and `<vault>/.dome/extensions/*/processors/**/*.ts` (vault-local third-party bundles) do not import mutation modules. A processor's `run(ctx)` body uses only the `ProcessorContext` surface; direct filesystem, SQLite, or git access bypasses the engine and violates the snapshot-in-effects-out contract per [[wiki/specs/processors]] §"What a processor cannot do".

## What it checks

The check is a static import-graph walk over the processor file set:

```
assets/extensions/*/processors/**/*.ts
.dome/extensions/*/processors/**/*.ts   (in vault-local CI integrations)
```

For every processor file, the check inspects every `import` and `import()` call, asserts the imported module name is not in the forbidden-module denylist, and scans for known mutation calls.

**Forbidden modules:**
- `node:fs`, `node:fs/promises`
- `bun:sqlite`
- `bun` (for `Bun.write`, `Bun.file`)
- `isomorphic-git` (entire module — processors don't need git access; the engine handles git boundaries)
- `node:child_process` (no shelling out)
- `node:net`, `node:http`, `node:https` (no direct network — `ExternalActionEffect` is the path)

- Direct mutation calls such as `Bun.write`, `writeFile`, `appendFile`, `unlink`, `rename`, `mkdir`, `fetch`, SQLite mutation statements, and mutating git calls.

**Allowed modules:**
- `@dome/sdk` — the four core types and the `defineProcessor` helper.
- `node:path` / `node:path/posix` — path-string helpers are allowed; filesystem and git mutation APIs are not.
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

## Why path helpers are allowed

Path manipulation is not itself mutation. Several first-party processors need POSIX path helpers to normalize vault-relative markdown references and image links. The purity boundary is filesystem, SQLite, git, network, and process mutation access; path-string normalization remains inside the snapshot-in/effects-out contract as long as the processor still reads through `ctx.snapshot` and writes only by returning effects.

## Implementation sketch

```ts
// tests/integration/processor-purity.test.ts
import { test, expect } from "bun:test";
import { Glob } from "bun";
import { parseImports } from "../helpers/parse-imports";

const FORBIDDEN = new Set([
  "node:fs", "node:fs/promises",
  "bun:sqlite", "bun",
  "isomorphic-git",
  "node:child_process",
  "node:net", "node:http", "node:https",
]);

const ALLOWED = new Set([
  "@dome/sdk", "zod", "node:path", "node:path/posix",
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
