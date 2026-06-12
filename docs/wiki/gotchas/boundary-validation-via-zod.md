---
type: gotcha
description: "Malformed config/manifest/state YAML or JSON skipping Zod boundary parsing explodes deep downstream with errors that blame the wrong code."
created: 2026-05-27
updated: 2026-06-10
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
coverage: off-matrix
enforced_at: src/extensions/loader.ts
first_observed: 2026-05-27
severity: medium
---

# Boundary validation via Zod

**Symptom:** A YAML file or JSON shape with a malformed structure — a `<vault>/.dome/config.yaml` that names `invariants` as a string instead of an object, an extension bundle's `manifest.yaml` with a malformed `processors[].triggers` block, a corrupted `<vault>/.dome/state/quarantined.json` — slips past the loader and explodes deep in downstream code. The error message blames a spread-merge or a property access, not the boundary where the shape entered the system. Debugging takes longer than it should because the failure surface is far from the loader.

**Severity:** Medium — silent data shape corruption at the persistence boundary. v2 mobile/desktop shells will hot-reload `.dome/state/` files on every wake; an invalid file becomes a debug nightmare without a typed validation seam.

**Root cause:** The SDK uses Zod pervasively for input validation; the convention is **one schema per persistence boundary, `safeParse` at ingest, `Result<T, ValidationError>` returned to the caller**. Without enforcement, a contributor adding a new loader at a YAML or JSON boundary may hand-roll the validation with `typeof raw.field !== "string"` chains or `as Partial<X>` casts. The hand-rolled path slips past TypeScript and produces unhelpful error messages.

The v1 persistence boundaries that need Zod schemas:

- **`src/extensions/loader.ts`** — parses bundle `manifest.yaml`; consumes `BundleManifestSchema` defining processors[], page-types, capability declarations.
- **`src/vault.ts`** (or `src/vault-config.ts`) — reads `<vault>/.dome/config.yaml`; consumes `VaultConfigSchema` defining invariants enable/disable, extension grants, engine knobs.
- **`src/vault.ts`** (page-types loader) — reads `<vault>/.dome/page-types.yaml`; consumes `PageTypesConfigSchema`.
- **`src/engine/operational/quarantine-store.ts`** — reads `<vault>/.dome/state/quarantined.json`; consumes colocated Zod schemas for the store file and entries, then maps `quarantinedAt` into `Date`.
- **`src/projections/db.ts`** — reads SQLite rows; column-type validation happens through Bun.sqlite's typed bindings (no Zod needed at this layer), but schema-hash mismatches trigger the auto-rebuild per [[wiki/gotchas/projection-schema-skew]].

**Structural mitigation:** Every loader at a YAML or JSON persistence boundary defines a Zod schema and consumes `schema.safeParse(parsed)` rather than casting. The loader returns `Result<T, ValidationError>` consistent with the engine's error-handling surface.

The schemas live colocated with their loader (e.g., `BundleManifestSchema` in `src/extensions/manifest-schema.ts` adjacent to `loader.ts`) so a future contributor reading the loader sees the schema first. The cross-cutting `src/core/effect.ts` Effect schemas stay centralized because Effects are consumed from many call sites; per-boundary schemas are read by one loader and don't need the indirection.

For state-file corruption (`quarantined.json`, future state files), the validation failure path returns a structured boundary error rather than silently falling back to empty state. Future recovery polish can decide whether a given state file is safe to reset and emit a `state-corruption-detected` DiagnosticEffect or repair question; the loader boundary itself must stay typed and observable.

**Convention until the lockstep ships:** v1 lands Zod schemas at every named boundary; new persistence boundaries added in v1.x ship with their schemas. Reviewer attention is the enforcement seam until a `tests/integration/boundary-validation-coverage.test.ts` lockstep walks every YAML/JSON read site in `src/` and asserts each consumes a Zod schema.

**Type/schema lockstep (zod 4):** The SDK is on zod 4. Two facts govern how schemas and hand types relate:

- **Hand-written types are canonical; schemas validate.** The public types (`Effect`, `Manifest`, the store-row shapes) are hand-written with the house optional style `field?: T` — *not* derived via `z.infer`. Zod cannot express exact-optional inference: `.optional()` infers `field?: T | undefined` in zod 4 just as in zod 3, which `exactOptionalPropertyTypes` rejects against `field?: T`. Do not convert public types to `z.infer` aliases — that flips the public optional semantics to permit explicit-`undefined` keys, which the constructors deliberately never produce.
- **Drift between a schema and its hand type is pinned at compile time**, not by convention. `tests/types/schema-type-lockstep.ts` carries a bidirectional assignability fence per schema/type pair: the hand type must extend the inferred type (the schema is not stricter than the type), and the inferred type must extend the undefined-loosened hand type (the type is not stricter than the schema, modulo the exact-optional gap). The fence is gated by `bun run typecheck` (and `v1:check`). A schema field added without the hand type — or vice versa — fails the build.

The one place the exact-optional gap crosses an assignment boundary is `parseManifest` (`src/extensions/manifest-schema.ts`): the validated output is cast to `Manifest` across that gap, with the lockstep fence guaranteeing the cast is shape-safe.

Zod 4's `discriminatedUnion` accepts refined members, so per-kind semantic refinements (FactEffect's non-empty `sourceRefs`, SearchDocument's body rules) live directly on each kind's schema; the union does not re-apply them. (Under zod 3 the union rejected `ZodEffects` members, forcing an un-refined parallel schema plus a union-level `superRefine` re-application — that layering is retired.)

**Specific scenarios:**

- A user with a hand-edited `<vault>/.dome/config.yaml` carries a malformed `invariants:` block. The current behavior (without the schema) crashes during the spread merge in `openVault`; with the schema, it returns `Result.err({ kind: 'invalid-vault-config', path: 'invariants', expected: 'object', got: 'string' })` and `dome inspect diagnostics` surfaces the error as a DiagnosticEffect.
- A third-party bundle author ships a `manifest.yaml` with a typo'd `processors[].triggers[].kind` field. V1 behavior: `Result.err({ kind: "bundle-load-failed", cause: { kind: "manifest-invalid", cause: { kind: "invalid-shape", issues: [...] } } })` per [[wiki/specs/sdk-surface]] §"Bundle-loader error taxonomy".
- A v2 mobile shell wakes from background, finds `<vault>/.dome/state/quarantined.json` corrupted by a previous-version process. Pre-v1 behavior silently reset quarantine state. V1 behavior returns `quarantine-store-parse-failed` with the offending schema path, so the host can surface or repair the corruption deliberately.

**Related:**

- [[wiki/specs/effects]] — the `Result<T, ToolError>` shape the boundary schemas mirror
- [[wiki/specs/sdk-surface]] §"Bundle-loader error taxonomy" — the `bundle-load-failed` error wrapper and nested loader discriminators
- [[wiki/specs/vault-layout]] §"Derived operational state under `.dome/`" — the state-file persistence surface
- [[wiki/specs/projection-store]] §"Schema migrations" — SQLite-side validation via schema-hash mismatch
- [[wiki/gotchas/agent-prompt-regression]] — a different boundary (LLM output) with a different mitigation (eval suite)
