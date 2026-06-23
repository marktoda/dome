---
type: linter
created: 2026-05-27
updated: 2026-06-12
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
description: Forbids importing fs/bun:sqlite/git-write modules outside engine, projections, ledger, outbox — all mutation routes through the engine.
status: v1 (proposed; lockstep check ships in Phase 1 of implementation)
---

# engine-is-sole-applier

**Status:** v1 substrate; the structural fence behind [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]]. The lockstep check ships as part of Phase 1 of v1 implementation per the brainstorm's "Phasing the cut" section.

**Statement:** TypeScript files under `src/` outside `src/engine/`, `src/projections/`, `src/ledger/`, and `src/outbox/` do not import mutation modules. The mutation modules are: `node:fs` (and `node:fs/promises`), `bun:sqlite`, and isomorphic-git's mutation surface (`commit`, `add`, `writeRef`, `writeBlob`, `writeTree`, etc.).

## What it checks

The check is a static import-graph walk over `src/**/*.ts`. For every file outside the engine-internal directories, the check inspects every `import` and `import()` call, asserts the imported module name is not in the forbidden-module allowlist.

**Forbidden modules** (across the static import graph):
- `node:fs`
- `node:fs/promises`
- `bun:sqlite`
- `isomorphic-git` write-side functions (`commit`, `add`, `writeRef`, `writeRef`, `writeBlob`, `writeTree`, `branch`, `checkout`, `merge`, `push`, `pull`, etc.). Read-side functions (`log`, `readTree`, `readBlob`, `resolveRef`, etc.) are allowed.

**Allowed engine-internal directories** (imports are unrestricted):
- `src/engine/` — the adoption loop, applier, capability broker, closure-commit machinery.
- `src/projections/` — Bun.sqlite-backed projection store reads + writes.
- `src/ledger/` — Bun.sqlite-backed run ledger writes.
- `src/outbox/` — Bun.sqlite-backed outbox writes + external dispatch.
- `src/watcher.ts` — needs `node:fs` for file-mtime reads; the watcher does not mutate, but reads filesystem signals. Whitelisted by file path.

**Allowed boundary modules** (imports the check tolerates from anywhere):
- `node:path` (path manipulation; no filesystem effects).
- `bun:test` (test-only files).

## Exempt contexts

1. **Test files** under `tests/**` are exempt — tests legitimately exercise mutation modules to scaffold fixtures and to assert outcomes.
2. **The `src/watcher.ts` file** is whitelisted (it reads file mtimes; no writes).
3. **Files explicitly marked engine-internal** via a top-of-file `// @engine-internal` comment are exempt with a written justification of why the file lives outside `src/engine/` despite needing mutation reach. None currently exist; reserved for future v1.x boundary moves.

## Why this exists

The engine is the only applier per [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]]. Every mutation flows through the sole applier `src/engine/core/apply-effect.ts` — every effect kind and phase, garden PatchEffects included (which it authorizes and resolves to `queued-for-spawn` before the garden orchestrator spawns a sub-Proposal) — with capability enforcement, ledger writes, and projection updates as routed side effects. Modules outside the engine that reach for `fs.writeFile`, `sqlite.execute("INSERT ...")`, or `git.commit()` bypass the chokepoint — and with it the broker, the ledger, and the audit surface.

The static import-graph check catches the bypass at CI. The dynamic-import edge case (a processor reaching mutation modules via `await import("node:fs")`) is not caught by this check; v1.1+ adds a runtime fence via Node.js module-resolution interception or a runtime-import-trace.

## Implementation sketch (v1 Phase 1)

```ts
// tests/integration/no-direct-mutation-outside-boundaries.test.ts
import { test, expect } from "bun:test";
import { Glob } from "bun";
import { parseImports } from "../helpers/parse-imports";

const ENGINE_DIRS = ["src/engine/", "src/projections/", "src/ledger/", "src/outbox/"];
const WHITELIST = ["src/watcher.ts"];
const FORBIDDEN = new Set([
  "node:fs", "node:fs/promises", "bun:sqlite",
]);
const FORBIDDEN_GIT_FUNCS = new Set([
  "commit", "add", "writeRef", "writeBlob", "writeTree", "branch",
  "checkout", "merge", "push", "pull",
]);

test("engine-is-sole-applier", async () => {
  const violations: string[] = [];
  for await (const file of new Glob("src/**/*.ts").scan(".")) {
    if (ENGINE_DIRS.some(d => file.startsWith(d))) continue;
    if (WHITELIST.includes(file)) continue;
    const imports = await parseImports(file);
    for (const imp of imports) {
      if (FORBIDDEN.has(imp.module)) {
        violations.push(`${file}: imports ${imp.module}`);
      }
      if (imp.module === "isomorphic-git") {
        for (const sym of imp.named) {
          if (FORBIDDEN_GIT_FUNCS.has(sym)) {
            violations.push(`${file}: imports isomorphic-git#${sym}`);
          }
        }
      }
    }
  }
  expect(violations).toEqual([]);
});
```

## Related

- [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]] (the invariant this linter enforces)
- [[wiki/invariants/PROPOSALS_ARE_THE_ONLY_WRITE_PATH]] (the sister write-path chokepoint)
- [[wiki/linters/no-direct-mutation-outside-engine]] (sister; catches direct `Bun.write` / `fs.writeFile` calls in source code, not just imports)
- [[wiki/linters/processor-purity]] (extends the same property to extension-bundle processors)
- [[wiki/specs/effects]] §"The Effect union" (the routing chokepoint this linter protects)
