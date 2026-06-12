---
type: linter
description: "Checks src/engine/ files sit in core/garden/operational/host layer dirs and never import upward, keeping the engine's layer DAG real."
created: 2026-06-10
updated: 2026-06-10
sources:
  - "[[cohesive/reviews/2026-06-10-oop-abstraction-layers-architecture-review]]"
---

# engine-import-direction

**Status:** v1 substrate; the structural fence behind [[wiki/matrices/engine-module-map]].

**Statement:** Every TypeScript file under `src/engine/` lives in exactly one of the four layer directories (`core/`, `garden/`, `operational/`, `host/`), and no engine module imports a module from a higher-ranked layer. Layer rank order: `core` (0) < `garden` (1) < `operational` (2) < `host` (3).

## What it checks

The check is a static import-graph walk over `src/engine/**/*.ts`, in lockstep with [[wiki/matrices/engine-module-map]]:

1. **Placement lockstep** — every module row in the matrix's "Module → layer" table exists on disk at `src/engine/<layer>/<module>.ts`, and every `.ts` file under `src/engine/` has a matrix row. A file added without a row, or a row without a file, fails.
2. **Import direction** — for every engine file, every relative import that resolves inside `src/engine/` must target a module whose layer rank is ≤ the importing file's layer rank. Same-layer imports (including same-layer cycles, e.g. `apply-effect` ↔ `diagnostics`) are allowed; upward imports fail with the violating edge named.
3. **No loose files** — a `.ts` file directly under `src/engine/` (not in a layer directory) fails.

## Exempt contexts

1. **Test files** under `tests/**` are exempt — tests may import any engine module directly.
2. **Imports from outside `src/engine/`** (CLI, MCP, processors, vault assembly) are out of scope here; they are governed by [[wiki/linters/engine-is-sole-applier]] and the public-surface shape test.
3. **Comment mentions** of module paths are not imports and are ignored (the check parses import statements, not prose).

## Why this exists

`src/engine/` carries the engine's four internal layers. Before the layers were named, the directory was flat and the layering existed only in the import graph — readable by tracing imports, invisible in the tree, and unenforced. The first upward import had already appeared (an operational-role module importing the compiler host) before the 2026-06-10 architecture review surfaced it. Directory placement makes the layer assignment visible; this check makes it load-bearing. The failure mode it prevents: a contributor adds a convenience import from `core` or `operational` up into `host`, the engine's dependency DAG silently becomes a web, and the layers stop being independently understandable.

## Implementation

```ts
// tests/integration/engine-import-direction.test.ts
// Parses docs/wiki/matrices/engine-module-map.md's "Module → layer" table,
// asserts placement lockstep, then walks every import in src/engine/**/*.ts
// and asserts importing-layer rank >= imported-layer rank.
```

The shipped test follows the bundle-matrix-lockstep pattern (`tests/integration/bundle-matrix-lockstep.test.ts`): the matrix is the canonical declaration; the test reads it rather than duplicating the module list.

## Related

- [[wiki/matrices/engine-module-map]] — the canonical layer assignment this linter enforces
- [[wiki/linters/engine-is-sole-applier]] — the sibling fence on the engine's *outer* boundary
- [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]] — the invariant the engine's sealed shape serves
