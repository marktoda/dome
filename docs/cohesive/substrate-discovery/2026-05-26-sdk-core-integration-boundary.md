# Substrate Discovery — SDK core vs integration boundary enforcement

**Date:** 2026-05-26
**Scope:** the `@dome/sdk` package — specifically the structural mechanisms (or lack thereof) that prevent core SDK primitives (Vault, Document, Tool, Hook) from mixing with integration / shell code (cli, mcp, workflows, eval, prompts).
**Prior report cited:** `docs/cohesive/substrate-discovery/2026-05-26-dome-v0.5-self-review.md` (same day, broader scope) — that report's §"Locality boundaries" and §"Missing memory" items #1, #2, #5 already cover most of this surface. This report supplements with structural-enforcement specifics not in the prior report and re-frames the findings around the *mechanism* question the user asked.

## Substrate discovered

### Target change surface

- **Subsystem:** the partition between core and integrations inside the single `@dome/sdk` package.
- **Main files likely involved:**
  - `src/index.ts` — the public surface; re-exports both core and integration symbols.
  - `src/cli/index.ts` — the only *enforced* split surface (separate entrypoint via `package.json` `exports`).
  - `package.json` `exports` field (lines 9–18) — the one structural enforcement that exists today.
  - `tsconfig.json` — single project, no `references`, no path-based partition.
  - Integration dirs: `src/workflows/`, `src/mcp/`, `src/eval/`, `src/prompts/`, `src/hooks/` (the YAML pack — note `auto-update-index` and `auto-cross-reference` are arguably core, `yaml-loader.ts` is integration).
  - Core dirs: top-level `src/*.ts`, `src/tools/`, plus the two SDK hook implementations.
- **Neighboring subsystems:** the same boundary question recurs for every future v1+ consumer shell (mobile, desktop, voice, web — per `wiki/specs/harnesses.md`).

### Relevant specs/docs

- `docs/wiki/specs/sdk-surface.md` §"What ships in v0.5" describes the core surface (Vault, Document, Tool, Hook + 7 Tools) and the CLI split, but does not name workflows/MCP/eval as distinct integration layers — they are listed flat alongside core in the spec body. The spec carries the layering *idea* (the core-vs-CLI split is described) but not the *generalization* the user is asking about.
- `docs/wiki/specs/harnesses.md` §"Future-harness pressure" — names four future consumer shells (mobile, desktop, voice, web) and asserts each will compose with the SDK; does not say which integrations they include or exclude.
- `docs/wiki/syntheses/v0.5-build-plan.md` — no mention of subpackages or workspace structure.

### Behavior matrices

- **Existing:** none specific to this surface. The prior report's §"Behavior matrices" lists `tool-invariant-enforcement`, `event-types-and-payloads`, `intent-prompt-tools` — none address layering.
- **Missing but likely needed:** a **directory × layer** matrix (rows = each `src/<dir>`, columns = `core | integration | shell`) that fixes the canonical assignment. Today this is implicit and inconsistent — `src/hooks/` mixes the two SDK-source hooks (core-shape) with `yaml-loader.ts` (integration-shape, pulls Zod parsing of user YAML), and there is no document that says so. The prior report's #2 (consumer-surface matrix) is related but rows-wise — *what consumers need*; this matrix is rows-wise *what each directory is*.

### Named invariants

- **Existing:** none enforce layering between core and integrations. The 12 existing invariants are all behavior-of-vault invariants (`RAW_IS_IMMUTABLE`, `MARKDOWN_IS_SOURCE_OF_TRUTH`, etc.), not architectural-layering invariants.
- **Candidate invariants (supplementing prior report):**
  - `CORE_HAS_NO_LLM_DEPENDENCY` — per prior report, item #1. Restated structurally: *no file under `src/{vault,document,tools,hook-*,reconcile,frontmatter,wikilinks,watcher,event-projection,workflow-commit,page-type,privileged-writer,git,types,vault-fs,vault-scaffold,shipped-defaults}.ts` or `src/tools/**` may import from `ai`, `@ai-sdk/*`, `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, or `commander`.*
  - `CORE_HAS_NO_INTEGRATION_IMPORT` — no core file (per the above enumeration) may import from `src/cli/**`, `src/mcp/**`, `src/workflows/**`, `src/eval/**`, `src/prompts/**`, or `src/hooks/yaml-loader.ts`. Today this happens to be true (`grep` confirmed zero leaks) but nothing prevents it from breaking on the next commit.
  - `INTEGRATIONS_DO_NOT_CROSS_REACH` — `src/cli/**` may import core and `src/mcp/**` (CLI hosts MCP via `serve.ts`); but `src/mcp/**` MUST NOT import `src/cli/**`, `src/workflows/**` MUST NOT import `src/mcp/**` or `src/cli/**`, etc. Today these are also true but unenforced.

### Existing enforcement

- **Tests:** the prior report's `tests/integration/public-surface.test.ts` pins the public-export list of `@dome/sdk`. It does **not** pin the `@dome/sdk/cli` list separately, and does not test that core files don't import integration libraries. Public-surface contract tests catch *additions/removals* to the export list, not *transitive imports*.
- **Types:** `Vault.aiTools: import("ai").ToolSet` at `src/vault.ts:51` is the load-bearing inward leak — the core `Vault` *type* declares a dependency on the `ai` package, so any consumer importing `Vault` pulls the `ai` type at minimum. (Whether bundlers tree-shake the runtime depends on usage.) This is the structural artifact of "core re-exports integration."
- **Constraints:** `package.json` `exports` defines two entrypoints — `.` and `./cli`. Both resolve into the same `src/` tree; `exports` only gates *what can be imported from the package by name*, not *what the package can import from itself*. The CLI is gated; nothing else is.
- **CI checks:** none. No lint pass, no boundary check, no bundle-size budget, no `dependency-cruiser` rule. The test suite is the only gate.
- **Semantic linters:** none. No ESLint config exists in the repo (verified — `ls -a` shows no `.eslintrc*`, no `eslint.config.*`, no `biome.json`, no `dependency-cruiser.cjs`, no `knip.*`). The repo has *zero* lint tooling.

### Known gotchas / scars

- The prior report's `transitive-llm-dependency` (Missing memory #5) is the canonical gotcha for the current state — *naming* the problem the user is asking how to *fix*. No live gotcha doc exists yet.
- The prior report's `style-guide-rot`-class concerns do not apply here (this is structural, not stylistic).

### Locality boundaries

- **The actual physical seams today:**
  1. **`package.json` `exports`** — splits `@dome/sdk` from `@dome/sdk/cli`. Real and enforceable. A consumer cannot accidentally pull CLI symbols when importing the core entry. This is the *only* hard boundary.
  2. **Directory naming** — `src/cli/`, `src/mcp/`, `src/workflows/`, `src/eval/`, `src/prompts/`, `src/hooks/`. Soft boundary — relies on contributor judgment.
  3. **`src/index.ts` curation** — what gets re-exported determines the public surface. Soft — any contributor can add a re-export. The integration test catches *removals*, not new additions that bundle integration deps under the core entry.

- **Suspected premature centralization:** the single `src/index.ts` barrel **is** the centralization that's now hurting. It's centralizing exports across all layers (core + workflows + MCP + eval + prompts), which forces every consumer to either accept all of them or tree-shake aggressively. The CLI split shows the alternative: separate entrypoint, separate barrel. The pattern that worked once (`./cli`) is not generalized to the other layers.

- **Suspected duplication-that-wants-abstraction:** the *split mechanism* itself. The CLI split is a one-off — there's no abstraction that says "here's how to add a new entrypoint." If the answer is "split MCP into `@dome/sdk/mcp`, workflows into `@dome/sdk/workflows`, eval into `@dome/sdk/eval`," then the pattern needs documenting once and applying four times.

### Package files (for library-native review)

- `package.json` — single package, two entrypoints. Subpath exports use `./<name>` — supports trailing `*` glob if needed. `bun` is the runtime (not `pnpm` / `npm`). There is **no `workspaces` field** today — this is not a monorepo, it's a single package with subpath exports. Bun supports workspaces (`bun init --workspace`), but adopting workspaces would be a structural change.
- `tsconfig.json` — single project, `module: ESNext`, `moduleResolution: bundler`, no `references`, `include: ["src/**/*", "tests/**/*"]`. Project references (TS 3.0+) would let us declare per-directory tsconfigs with `references` arrows that the compiler enforces. Not used today.

### Missing memory

Ranked by leverage for the user's specific question ("how do we structurally enforce the boundary").

- **No named invariant or linter for "core does not import integration."** `src/index.ts:96-99` describes the CLI split in a comment but does not name the *general rule* that should also govern MCP, workflows, eval. The substrate that would close this: a single `docs/wiki/invariants/LAYER_IMPORT_DIRECTION.md` declaring the core / integration / shell trichotomy and the legal import directions, paired with **one** enforcement mechanism — either (a) ESLint `no-restricted-imports` with per-directory `overrides`, (b) `dependency-cruiser` rules, (c) a custom Bun-script linter under `scripts/`, or (d) tsconfig project references that make integration-from-core imports a compile error. Per the prior report's "no semantic linter despite the spec carrying the surface" finding, the broader point is the same: rules without machinery rot.

- **No layer-membership matrix.** Today the layering is implicit in directory names and `src/index.ts` re-export blocks. `src/hooks/yaml-loader.ts` is an integration (parses user YAML, depends on Zod for user-input schemas) while `src/hooks/auto-update-index.ts` and `auto-cross-reference.ts` are core SDK hooks — but the directory groups them. The matrix that would close this: `docs/wiki/matrices/sdk-layer-membership.md` with rows = every directory and file at the granularity needed to be unambiguous, columns = `core | integration | shell | mixed-by-design`. A `mixed-by-design` column is honest substrate — `src/hooks/` may legitimately be mixed, and the matrix is the place to say so.

- **`@dome/sdk` entrypoint already pulls Anthropic + MCP transitively.** Confirmed: `src/index.ts:55-93` re-exports `runWorkflow`, `buildAiSdkTools`, `DEFAULT_MODEL`, `DomeMcpServer`, `buildToolAdapters`, etc. — *each of these is a value-export of a module that imports the respective library*. Any consumer doing `import { openVault } from "@dome/sdk"` evaluates the barrel, which evaluates all the re-exported modules (unless the bundler tree-shakes — which depends on the bundler and the consumer's setup). Specifically, `Vault.aiTools: import("ai").ToolSet` at `src/vault.ts:51` makes the *type* of Vault depend on `ai`. Substrate that would close this: either (a) the `LAYER_IMPORT_DIRECTION` invariant above plus a new entrypoint partition (`@dome/sdk` carries only core; `@dome/sdk/workflows`, `@dome/sdk/mcp`, `@dome/sdk/eval` carry the integrations), OR (b) the looser variant where `src/index.ts` does NOT re-export integration symbols and consumers import them via deep paths like `@dome/sdk/workflows/agent-loop` (subpath patterns with `./*` glob). The decision between these is exactly what brainstorming should compare.

- **No project references or per-directory tsconfigs.** TypeScript supports compile-time enforcement of layering via project references — `src/core/tsconfig.json` could omit `src/integrations/` from `include`, and a `references` arrow from integration tsconfigs to core would make integration-from-core imports a compile error. Today this mechanism is unused. The substrate that would close this: a decision in the brainstorm on whether project references are the chosen enforcement (versus ESLint rules vs custom script vs subpackages).

- **No `dome doctor` check enumerating per-entrypoint exports.** The prior report's #1 candidate invariant proposed `dome doctor` could enumerate exports per entrypoint and assert disjoint sets. The mechanism is concrete and shipped-doctor-shape — `dome doctor` already does 8 deterministic checks; adding a 9th that runs `bun --print "Object.keys(await import('@dome/sdk'))"` (or AST-walks `src/index.ts` and `src/cli/index.ts`) and asserts no symbol appears in both would be an enforceable substrate artifact. This is **not the same** as a linter — it's a runtime self-check the user already runs as part of doctor.

- **`@internal` and "do not export" are documented in code comments, not enforced.** `src/index.ts:29-37` and `:71-73` use prose comments to mark `privileged-writer` and `eval/replay` as not-public. These work today but are unscannable — there's no JSDoc `@internal` annotation, no API Extractor config, no Microsoft API style report. Substrate that would close this: either (a) add `@internal` JSDoc tags and run `tsc --stripInternal` for the published `.d.ts` (TypeScript handles this natively), OR (b) accept that since this is a workspace-internal SDK without a separate publish step, the comment-as-rule is fine — but *name it as a gotcha* (`internal-marked-by-comment.md`) so a future contributor knows the convention.

- **No matrix or gotcha for "adding a new integration."** When a contributor wants to add a new integration (say, a webhook subscription layer or a Datadog metrics emitter), there is no recipe: which directory does it go in, does it get its own entrypoint, does it get its own tests subdir, does it need a layer-matrix update? The prior report touches on this via #2 (consumer-surface matrix) but from the consumer side. The producer-side recipe is missing. The substrate that would close this: a `docs/wiki/specs/integration-layer.md` short spec listing the rules ("each integration is a directory under `src/`, gets an entrypoint in `package.json` exports if intended for external consumption, has a matrix row, etc.").

### Next

Continue into the brainstorm with this discovery as grounding. *(`cohesive:brainstorm-design`.)* **Design question:** which structural mechanism (or combination) should enforce the core-vs-integration boundary — entrypoint partition via `package.json` subpath exports, ESLint `no-restricted-imports`, dependency-cruiser, tsconfig project references, full Bun-workspace monorepo, or a custom `dome doctor` check — given the future pressure of multiple v1+ consumer shells (mobile/desktop/voice/web) and the constraint that this is a single-author single-package codebase today where ceremony cost matters.
