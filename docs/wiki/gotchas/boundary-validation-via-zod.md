---
type: gotcha
created: 2026-05-27
updated: 2026-05-27
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"]
severity: medium
coverage: off-matrix
enforced_at: src/extensions/loader.ts
first_observed: 2026-05-27
---

# Boundary validation via Zod

**Symptom:** A YAML file or JSON shape with a malformed structure — a `<vault>/.dome/config.yaml` that names `invariants` as a string instead of an object, an extension bundle's `manifest.yaml` with a malformed `processors[].triggers` block, a corrupted `<vault>/.dome/state/quarantined.json` — slips past the loader and explodes deep in downstream code. The error message blames a spread-merge or a property access, not the boundary where the shape entered the system. Debugging takes longer than it should because the failure surface is far from the loader.

**Severity:** Medium — silent data shape corruption at the persistence boundary. v2 mobile/desktop shells will hot-reload `.dome/state/` files on every wake; an invalid file becomes a debug nightmare without a typed validation seam.

**Root cause:** The SDK uses Zod pervasively for input validation; the convention is **one schema per persistence boundary, `safeParse` at ingest, `Result<T, ValidationError>` returned to the caller**. Without enforcement, a contributor adding a new loader at a YAML or JSON boundary may hand-roll the validation with `typeof raw.field !== "string"` chains or `as Partial<X>` casts. The hand-rolled path slips past TypeScript and produces unhelpful error messages.

The v1 persistence boundaries that need Zod schemas:

- **`src/extensions/loader.ts`** — parses bundle `manifest.yaml`; consumes `BundleManifestSchema` defining processors[], page-types, capability declarations.
- **`src/vault.ts`** (or `src/vault-config.ts`) — reads `<vault>/.dome/config.yaml`; consumes `VaultConfigSchema` defining invariants enable/disable, extension grants, engine knobs.
- **`src/vault.ts`** (page-types loader) — reads `<vault>/.dome/page-types.yaml`; consumes `PageTypesConfigSchema`.
- **`src/quarantine-store.ts`** — reads `<vault>/.dome/state/quarantined.json`; consumes `QuarantineSchema`.
- **`src/projections/db.ts`** — reads SQLite rows; column-type validation happens through Bun.sqlite's typed bindings (no Zod needed at this layer), but schema-hash mismatches trigger the auto-rebuild per [[wiki/gotchas/projection-schema-skew]].

**Structural mitigation:** Every loader at a YAML or JSON persistence boundary defines a Zod schema and consumes `schema.safeParse(parsed)` rather than casting. The loader returns `Result<T, ValidationError>` consistent with the engine's error-handling surface.

The schemas live colocated with their loader (e.g., `BundleManifestSchema` in `src/extensions/manifest-schema.ts` adjacent to `loader.ts`) so a future contributor reading the loader sees the schema first. The cross-cutting `src/core/effect.ts` Effect schemas stay centralized because Effects are consumed from many call sites; per-boundary schemas are read by one loader and don't need the indirection.

For state-file corruption (`quarantined.json`, future state files), the validation failure path returns the empty-state fallback AND emits a `state-corruption-detected` DiagnosticEffect (via the engine when reachable from inside the load path; otherwise a direct write to `log.md` projection through the `dome.log` adoption-phase processor) — silent fallback was the pre-v1 behavior; observable fallback is the v1 behavior. The user sees the corruption in their log; the system continues without crashing.

**Convention until the lockstep ships:** v1 lands Zod schemas at every named boundary; new persistence boundaries added in v1.x ship with their schemas. Reviewer attention is the enforcement seam until a `tests/integration/boundary-validation-coverage.test.ts` lockstep walks every YAML/JSON read site in `src/` and asserts each consumes a Zod schema.

**Specific scenarios:**

- A user with a hand-edited `<vault>/.dome/config.yaml` carries a malformed `invariants:` block. The current behavior (without the schema) crashes during the spread merge in `openVault`; with the schema, it returns `Result.err({ kind: 'invalid-vault-config', path: 'invariants', expected: 'object', got: 'string' })` and `dome doctor` surfaces the error as a DiagnosticEffect.
- A third-party bundle author ships a `manifest.yaml` with a typo'd `processors[].triggers[].kind` field. Current behavior: an unhelpful "Cannot read property 'kind' of undefined" error during processor registration. Future behavior: `Result.err({ kind: 'bundle-load-failure', detail: 'processor-invalid', errors: [<Zod-issue-path>] })` per [[wiki/specs/sdk-surface]] §"Bundle-loader error taxonomy".
- A v2 mobile shell wakes from background, finds `<vault>/.dome/state/quarantined.json` corrupted by a previous-version process. Current behavior: silent empty fallback (the quarantine state resets; the user sees no signal). v1 behavior: same fallback + `state-corruption-detected` diagnostic emitted via the engine.

**Related:**

- [[wiki/specs/effects]] — the `Result<T, ToolError>` shape the boundary schemas mirror
- [[wiki/specs/sdk-surface]] §"Bundle-loader error taxonomy" — the `bundle-load-failure` discriminator set
- [[wiki/specs/vault-layout]] §"Derived operational state under `.dome/`" — the state-file persistence surface
- [[wiki/specs/projection-store]] §"Schema migrations" — SQLite-side validation via schema-hash mismatch
- [[wiki/gotchas/agent-prompt-regression]] — a different boundary (LLM output) with a different mitigation (eval suite)
