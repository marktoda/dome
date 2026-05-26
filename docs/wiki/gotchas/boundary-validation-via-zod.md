---
type: gotcha
created: 2026-05-26
updated: 2026-05-26
sources: ["[[cohesive/reviews/2026-05-26-dome-v0.5-to-v1-readiness-architecture-review]]"]
severity: medium
coverage: off-matrix
enforced_at: src/tools/schemas.ts
first_observed: 2026-05-26
---

# Boundary validation via Zod

**Symptom:** A YAML file or JSON state file with a malformed shape — a `.dome/config.yaml` that names `invariants` as a string instead of an object, a corrupted `.dome/state/scheduled.json` that's invalid JSON or an unexpected shape — slips past the loader and explodes deep in downstream code. The error message blames a spread-merge or a property access, not the boundary where the shape entered the system. Debugging takes longer than it should because the failure surface is far from the loader.

**Severity:** Medium — silent data shape corruption at the persistence boundary. Mobile/desktop v1 shells will hot-reload `.dome/state/` files on every wake; an invalid file becomes a debug nightmare without a typed validation seam.

**Root cause:** v0.5 hand-rolls validation at three persistence boundaries that should have used Zod (the SDK's pervasive schema-validation library):

- `src/hooks/yaml-loader.ts` — parses declarative hook YAML and hand-validates with `typeof raw.event !== "string"` chains, throwing string errors instead of returning a `Result<DeclarativeHook, ValidationError>`. Inconsistent with the `Result<T, E>` discipline at the Tool layer.
- `src/vault.ts` — reads `.dome/config.yaml` and casts via `parseYaml(cfgText) as Partial<VaultConfig>`. The `as Partial<VaultConfig>` is unverified; a misshapen config slips past TypeScript and crashes the spread merge.
- `src/reconcile.ts` and `src/quarantine-store.ts` — `JSON.parse(...) as Record<string, ScheduledEntry>` and `Array.isArray(parsed) ? parsed.filter(...) : []` patterns. Hand-defensive; silent-empty-fallback on corruption.

The SDK already uses Zod everywhere else (the Tool input schemas at `src/tools/schemas.ts`, workflow-prompt frontmatter validation at `src/prompts/workflow-frontmatter.ts`, MCP descriptors via `zod-to-json-schema`). The substrate convention is **one schema per boundary, `safeParse` at ingest, `Result<T, ValidationError>` returned to the caller** — the persistence boundaries are inconsistent with this convention.

**Structural mitigation:** Every loader at a YAML or JSON persistence boundary defines a Zod schema (`DeclarativeHookSchema`, `VaultConfigSchema`, `PageTypesConfigSchema`, `ScheduledStateSchema`, `QuarantineSchema`) and consumes `schema.safeParse(parsed)` rather than casting. The loader returns `Result<T, ValidationError>` consistent with the Tool surface.

The five schemas live colocated with their loader (e.g., `DeclarativeHookSchema` in `src/hooks/yaml-loader.ts` next to the parser) so a future contributor reading the loader sees the schema first. The exception is `src/tools/schemas.ts`, the cross-cutting Tool-input schemas, which stays centralized because Tool inputs are consumed from many call-sites; persistence-boundary schemas are read by one loader and don't need the indirection.

For state-file corruption (`scheduled.json`, `quarantined.json`), the validation failure path returns the empty-state fallback AND emits a `state-corruption-detected` entry to `log.md` via the privileged-writer — silent fallback was the v0.5 behavior; observable fallback is the v0.5.1 behavior. The user sees the corruption in their log; the system continues without crashing.

**Convention until the linter ships:** v0.5.1 lands the Zod schemas at the three named boundaries. New persistence boundaries added in v1+ ship with their schemas; reviewer attention is the enforcement seam until a `tests/integration/boundary-validation-coverage.test.ts` lockstep walks every YAML/JSON read site in `src/` and asserts each consumes a Zod schema.

**Specific scenarios:**

- A user with a hand-edited `.dome/config.yaml` carries a malformed `invariants:` block. The current behavior crashes during the spread merge in `openVault`; with the schema, it returns `Result.err({ kind: 'invalid-vault-config', path: 'invariants', expected: 'object', got: 'string' })` and `dome doctor` surfaces the error.
- A v1 mobile shell wakes from background, finds `.dome/state/scheduled.json` corrupted by a previous-version process. Current behavior: silent empty fallback (the scheduled-tick re-derivation runs from scratch; the user sees no signal). Future behavior: same fallback + `state-corruption-detected` log entry the user (or the next `dome doctor` run) sees.
- A future v0.5.1 plugin author writes a declarative-hook YAML with a typo'd field. Current behavior: an unhelpful "typeof raw.workflow !== string" error. Future behavior: `Result.err({ kind: 'invalid-declarative-hook', errors: [...] })` with the full Zod-parse path.

**Related:**

- [[wiki/specs/sdk-surface]] §"Tool catalog" — the `Result<T, ToolError>` shape the boundary schemas mirror
- [[wiki/specs/hooks]] §"Declarative — `.dome/hooks/*.yaml`" — the loader where `DeclarativeHookSchema` lives
- [[wiki/specs/vault-layout]] §"Derived operational state under `.dome/`" — the state-file persistence surface
- `src/tools/schemas.ts` — the existing Zod-based precedent the boundary loaders converge on
- [[wiki/gotchas/agent-prompt-regression]] — a different boundary (LLM output) with a different mitigation (eval suite)
