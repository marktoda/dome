# Design Delta Ledger — Dome hooks Phase 0 + Phase 1 skeleton

**Date:** 2026-05-26
**Slug:** `dome-hooks-phase-0-1-skeleton`
**Branch:** `design/dome-hooks-phase-0-1-skeleton` (worktree at `.claude/worktrees/design+dome-hooks-phase-0-1-skeleton`, branched off `main`@`e139ae7`)
**Approved direction source:** retired V1 hook-roadmap planning docs deleted in the 2026-06-01 V1 reset. The historical dispatch confirmed four sub-decisions: (a) scope is Phase 0 substrate + Phase 1 dailies bundle skeleton, no LLM compile-on-write (Phase 2 deferred); (b) task carry-forward semantics are **copy-with-backref** (yesterday keeps lines; today gets copies with `from [[wiki/dailies/<prev>]]` footer attribution); (c) bundle split is **split by lifecycle** (`dailies`, `aggregation`, `recall` as separate bundles — only `dailies` in this scope); (d) migration path is **`dome migrate-dailies` one-shot CLI command contributed by the dailies bundle** (not a top-level shipped SDK command).
**Builds on:** [`docs/cohesive/delta-ledgers/2026-05-26-dome-v0.5-to-v1-tightening.md`](2026-05-26-dome-v0.5-to-v1-tightening.md) (the AbstractSurface + `wrapMutatingInvoke` + `HOOK_DISPATCH_IS_VAULT_BOUND` + composable-`openVault` substrate this rewrite extends with extension-bundle loading) and [`docs/cohesive/delta-ledgers/2026-05-26-dome-compiler-reframe.md`](2026-05-26-dome-compiler-reframe.md) (the compiler-reframe + AGENTS.md generation substrate that the preamble-fragment extension lives inside).

## Delta at a glance

**Classification:** Mixed.

- **Files rewritten:** 7 (`sdk-surface.md`, `hooks.md`, `cli.md`, `vault-layout.md`, `page-schema.md`, `AGENTS_MD_IS_ORIENTATION_SURFACE.md`, `docs/index.md`).
- **Files added:** 3 (`extension-bundle-load-order.md` gotcha, `scheduled-hook-idempotency.md` gotcha, `extension-bundle-shape.md` matrix).
- **Conceptual changes:** Extension bundle as packaging convention over the 5-kind registration surface (G3); schedule-driven hooks via `schedule:` cron field (G1); manual hook invocation via `dome run-hook` (G4); idempotent marker-delimited section updates via `upsertSection` Tool (G5); AGENTS.md preamble-fragment threading; bundle-contributed CLI commands; `daily` and `weekly` page types via the first-party `dailies` bundle (Phase 1 proof case).
- **Named invariants:** none added. `AGENTS_MD_IS_ORIENTATION_SURFACE` extended (statement + structural enforcement + fourth test + operational notes + MCP-mirror parity) to cover preamble-fragment threading; the 16-invariant catalog stays unchanged.
- **Behavior matrices:** 1 added — `extension-bundle-shape.md` (extension-bundle × five contribution kinds, rows for `dailies` shipped, `hello-world` test-fixture, `aggregation` / `recall` anticipated). Existing matrices unchanged at substrate layer; `tool-invariant-enforcement.md` and `event-types-and-payloads.md` extend implicitly when their referenced Tool / event lands in code.
- **Gotchas:** 2 added — `extension-bundle-load-order` (fail-loud collision via `bundle-load-failure` kind + `page-type-collision` discriminator; hook-IDs structurally namespaced as `<bundle>:<filename>`) and `scheduled-hook-idempotency` (at-most-once-per-reconcile catch-up clamp; narrower `idempotent:` semantic for scheduled hooks). Both carry `enforced_at_status: deferred` until their named integration tests ship in Phase 0a / 0c.
- **Semantic linters:** none added; the two existing specs (`no-retired-symbol-names`, `wrap-mutating-invoke-consumption`) stay unchanged.
- **Tests proposed:** new `tests/integration/extension-bundles-load.test.ts` (Phase 0a; covers hello-world load + collision rejection + CLI registration); new `tests/integration/scheduled-hooks.test.ts` (Phase 0c; live-fire + catch-up clamp + idempotent: false skip); extensions to `tests/invariants/agents-md-is-orientation-surface.test.ts` (Phase 0b; preamble-fragment install/render/removal cycle); extensions to `tests/integration/public-surface-shape.test.ts` (Phase 0d; `upsertSection` exported); new `tests/tools/upsert-section.test.ts` (Phase 0d); new `tests/integration/run-hook.test.ts` (Phase 0e); new `tests/integration/migrate-dailies.test.ts` (Phase 1e); extension to the bundle-load test for the dailies bundle (Phase 1f).
- **Deferred (out of scope this pass):** Phase 2 (LLM compile-on-write keystone with eval-suite work); Phase 3 (aggregation bundle); Phase 4 (recall bundle); programmatic TS hook loader (v0.5.1); `dome install-extension` CLI helper (v0.5.1); cross-bundle `manifest.yaml deps:` resolution (v0.5.1+); npm-distributable bundles (v1+); bundle-contributed Tools (v0.5.1+).

**Conceptual framing:** This rewrite establishes the **extension bundle** as a packaging convention over the existing 5-kind registration surface, closing the brainstorm's G3 pressure point — bundles let a single feature ship as a coherent unit of page-type + preamble + workflows + hooks + CLI commands rather than as five hand-threaded registrations. The bundle mechanism is *not* a new primitive: the four-concept core (Vault, Document, Tool, Hook) stays sealed; bundles compose registrations the substrate already supports. Adjacent to bundles, three substrate primitives land that the brainstorm's pressure-test G1/G4/G5 named (schedule-driven hooks, manual hook invocation, idempotent section upsert). The first-party `dailies` bundle is the proof case — its successful end-to-end load validates the substrate-extension surface for non-trivial features without the bundle mechanism becoming a substrate primitive itself. The substrate's pressure-3 question — *"can a future contributor or agent predict the right answer for every common change shape, anchored to a structural fence?"* — extends here to: *"can a future feature author ship a coherent multi-kind extension without modifying core?"* The answer is yes, via the bundle mechanism this rewrite pins.

## Approved direction (from brainstorm + plan + user dispatch)

Land Phase 0 substrate enablement (extension bundle loader, AGENTS.md preamble fragments, `schedule:` field on declarative hooks, `upsertSection` Tool, `dome run-hook` CLI command) and Phase 1 dailies-bundle skeleton (page type + preamble + creator hooks + carry-forward workflow + migrate-dailies bundle-contributed CLI command) as one cohesive substrate-rewrite-then-implementation pass. Phase 2 (compile-on-write LLM keystone), Phase 3 (aggregation), and Phase 4 (recall workflows) are explicitly deferred — Phase 2 needs LLM eval-suite work + design-gate confirmations (compile trigger timing, LLM call location) that are out of scope for this session.

User confirmed at dispatch:
- Scope is Phase 0 + Phase 1 skeleton (no LLM compile-on-write yet).
- Carry-forward semantics: **copy-with-backref**.
- Bundle split: **split by lifecycle** — `dailies`, `aggregation`, `recall` as separate bundles (only `dailies` in this scope).
- Migration: **`dome migrate-dailies` as a bundle-contributed CLI command from the dailies bundle**, not a top-level shipped SDK command.
- The shipped SDK CLI command count grows from 8 to 9 (adding `dome run-hook`); bundle-contributed commands grow the runtime CLI surface independently and don't increment the SDK count.

## Per-file changes

### Substrate added (3 files)

#### `docs/wiki/gotchas/extension-bundle-load-order.md` — new gotcha

Stable ID: `gotcha-extension-bundle-load-order`.

- Symptom: two bundles silently override each other on page-type or preamble-fragment collision; user observes drift without warning.
- Severity: medium. Coverage: off-matrix. Enforced_at: `tests/integration/extension-bundles-load.test.ts` (with `enforced_at_status: deferred` until the test ships in Phase 0a/0f).
- v0.5 mitigation: fail-loud — `openVault` returns `Result.err({ kind: 'bundle-load-failure', detail: ... })` on collision; hook-IDs are namespaced as `<bundle>:<filename>` to prevent cross-bundle hook collision structurally.
- Implementation work this implies: the bundle loader at `src/extensions/loader.ts` returns the typed error; the integration test exercises the rejection on a fixture with two colliding bundles.

#### `docs/wiki/gotchas/scheduled-hook-idempotency.md` — new gotcha

Stable ID: `gotcha-scheduled-hook-idempotency`.

- Symptom: a scheduled hook declared `idempotent: true` fires N times on reconcile after N intervals offline; OR declared `idempotent: false` and skips reconcile entirely, missing N intervals of intended fires.
- Severity: medium. Coverage: off-matrix. Enforced_at: `tests/integration/scheduled-hooks.test.ts` (with `enforced_at_status: deferred` until the test ships in Phase 0c).
- Mitigation: the at-most-once-per-reconcile clamp + the documented narrower `idempotent:` semantic for scheduled hooks. The clamp is structural (in the scheduler's reconcile-time fire logic); the semantic is documented (in `hooks.md` §"Declarative — `.dome/hooks/*.yaml`" Schedule subsection).
- Implementation work this implies: the per-vault scheduler in `wireDispatcher` reads `.dome/state/scheduled.json` and clamps catch-up to one fire per hook per reconcile.

#### `docs/wiki/matrices/extension-bundle-shape.md` — new behavior matrix

Stable ID: `matrix-extension-bundle-shape`.

- Rows: extension bundles (first-party `dailies` shipped + `aggregation` / `recall` anticipated + `hello-world` test fixture).
- Columns: five contribution kinds (page type, preamble fragment, workflows, hooks, CLI commands).
- Lockstep status: documentary in v0.5; v0.5.1 extension to `tests/integration/matrix-coverage.test.ts` asserts each first-party-bundle row's filenames correspond to real files in the shipped `assets/extensions/<bundle>/`.
- Implementation work this implies: the matrix row for `dailies` corresponds 1:1 with files in `assets/extensions/dailies/`.

### Substrate rewritten (7 files)

#### `docs/wiki/specs/sdk-surface.md` — rewrite (5 sections changed)

Stable IDs:

- `sdk-tool-catalog-eight` — §"Tool catalog (the seven)" → §"Tool catalog (the eight)" with `upsertSection` row added; prose throughout the subsection updated ("seven Tools" → "eight Tools", "Adding an 8th Tool" → "Adding a 9th Tool" in §"Tool catalog is one declarative array").
- `sdk-tool-signatures-upsertsection` — §"Tool signatures" gains the `upsertSection` signature block with marker shape (`<!-- section:<key> -->` / `<!-- /section:<key> -->`), idempotency-by-construction semantic, and optimistic-locking compatibility.
- `sdk-extension-bundles-section` — new §"Extension bundles" section inserted between §"Registration" and §"Tiered feature model". Names the bundle directory shape, `manifest.yaml` schema, six-step load lifecycle, fail-loud collision semantics, first-party shipping path (`assets/extensions/`), and "bundles aren't a new primitive" framing.
- `sdk-adding-a-new-extension-bundle-recipe` — §"Tiered feature model" §"Off-matrix lockstep convention" subsection followed by new §"Adding a new extension bundle" subsection. Three required edits (directory, manifest, preamble) + five optional contribution edits (page-types, workflows, hooks, CLI commands, Tools). Each contribution links to the relevant spec section + the matrix.
- `sdk-registration-extension-bundles-note` — §"Registration" 5×3 matrix paragraph closes with the addition: "Extension bundles are the second packaging convention — a vault-local directory under `<vault>/.dome/extensions/<name>/` that registers any combination of the five kinds; see §"Extension bundles" below."

#### `docs/wiki/specs/hooks.md` — rewrite (5 sections changed)

Stable IDs:

- `hooks-declarative-schedule-field` — §"Declarative — `.dome/hooks/*.yaml`" YAML example gains the `schedule:` and `idempotent:` fields with comment explaining optional/required semantics + the loader-validation note.
- `hooks-schedule-execution-subsection` — new §"Schedule field — cron-driven hooks" subsection following the YAML example. Names the cron syntax, the per-vault scheduler in `wireDispatcher`, the `.dome/state/scheduled.json` extension, the at-most-once-per-reconcile clamp, the `event:` omission semantic for schedule-only hooks.
- `hooks-adding-a-new-hook-five-forms` — §"Adding a new hook" "Three forms" → "Five forms" with new "Declarative schedule-driven form" inserted between "Declarative event-reactive form" and "Programmatic form (v0.5.1+)"; new "Bundle-contributed form" inserted before "Shipped-default form".
- `hooks-execution-model-manual-and-schedule` — §"Execution model" bullets gain two new entries: **Manual invocation** (the `dome run-hook` synthesis path) and **Schedule-driven invocation** (the scheduler-thread + `clock.tick.<hook-id>` synthesis path).
- `hooks-why-only-behavior-extension-bundle-mention` — §"Why hooks are the only behavior-extension surface" bullets gain schedule-driven examples (create-daily, weekly-rollup) + a bullet about bundle-packaged coherent features; closing prose updates from "Tool registration + Hook registration, never as new core primitives" to "Tool registration + Hook registration (in bundles or vault-local), never as new core primitives".
- `hooks-related-new-gotchas` — §"Related" gains links to the two new gotchas (extension-bundle-load-order, scheduled-hook-idempotency).

#### `docs/wiki/specs/cli.md` — rewrite (5 sections changed)

Stable IDs:

- `cli-count-eight-to-nine-prose` — opening paragraph "Eight commands" → "Nine commands"; the "extension bundles can contribute additional bundle-conditional commands" clause naming the `dailies` bundle's `migrate-dailies` as the canonical example.
- `cli-dome-run-hook-section` — new §"`dome run-hook <id>`" section inserted between §"`dome doctor`" and §"`dome export-context <topic>`". Full invocation contract (flags, exit codes, refusal semantics, the manually-invoked-bypasses-idempotency note).
- `cli-implementation-note-five-commands-list-six` — §"Implementation note" deterministic-commands list `init/doctor/serve/reconcile/stats` → `init/doctor/serve/reconcile/stats/run-hook`; LOC budget "< 600 LOC" → "< 700 LOC".
- `cli-command-mapping-table-nine-rows` — §"Implementation note" command-mapping table gains the `dome run-hook` row + the closing prose names bundle-conditional commands as the `dailies` example.
- `cli-adding-a-new-command-bundle-contributed-section` — §"Adding a new command" gains a §"Bundle-contributed commands" subsection naming the `<vault>/.dome/extensions/<bundle>/cli/*.ts` path, the bundle-conditional surfacing in `dome --help`, the cross-bundle collision rejection, and the `migrate-dailies` canonical example.

#### `docs/wiki/specs/vault-layout.md` — rewrite (3 sections changed)

Stable IDs:

- `vault-layout-extensions-directory-tree` — §"Vault root" tree gains `.dome/extensions/<bundle-name>/` row with the inline "see sdk-surface §"Extension bundles"" reference; the `state/` row gains `quarantined.json` (a pre-existing surface that wasn't in the v0.5 tree comment).
- `vault-layout-git-tracked-extensions` — §"Git repository structure" §"What gets committed to git" — `.dome/extensions/` is added to the committed list ("these are the vault's identity, including which extension bundles the vault has installed"); the gitignored note extends to name `quarantined.json` alongside the other two state files.
- `vault-layout-ownership-extensions-row` — §"Ownership rules" table gains a `.dome/extensions/<bundle>/` row naming the bundle-author ownership semantic, the `--repair`-refresh dependency for preamble fragments, the `openVault`-refresh dependency for hook YAMLs.

#### `docs/wiki/specs/page-schema.md` — rewrite (2 sections changed)

Stable IDs:

- `page-schema-extension-types-two-paths` — §"Extension types" preamble paragraph extended to name the two declaration paths (vault-local `.dome/page-types.yaml` AND bundle-contributed `<bundle>/page-types.yaml`), the merge-on-name semantic, the collision rejection, the `source:` provenance tracking.
- `page-schema-daily-weekly-type-blocks` — §"Extension types" gains a `**`daily` and `weekly` extension types**` subsection at the bottom showing the dailies-bundle-contributed YAML for both types + the wiki/<plural>/ destination paths + the Obsidian Tasks plugin syntax note + the cross-reference to `extension-bundle-shape.md` for the full bundle contribution catalog.

#### `docs/wiki/invariants/AGENTS_MD_IS_ORIENTATION_SURFACE.md` — rewrite (4 sections changed)

Stable IDs:

- `agents-md-statement-extension-conventions` — §"Statement" rewritten to name extension-bundle conventions in the list of things AGENTS.md teaches the agent + the templated-sections regeneration source list extended to include "loaded extension-bundle preamble fragments".
- `agents-md-extension-preamble-fragments-subsection` — new §"Extension-bundle preamble fragments" subsection inserted after the statement, explaining the load-order subsection rendering, the dailies-bundle example, the templated-not-user-prose categorization.
- `agents-md-structural-enforcement-bundle-clauses` — §"Structural enforcement" `dome init` bullet extended (omit `## Extension conventions` if no bundles loaded), `--repair` bullet extended (regenerates fragments in load order), `dome doctor` bullet extended (preamble-fragment drift is a violation when bundles are loaded but their fragments are absent from the templated section).
- `agents-md-test-guarantee-fourth-test` — §"Test guarantee" gains a fourth test asserting the hello-world fixture bundle's preamble fragment renders correctly + removal removes it + user-prose preservation across bundle install/uninstall cycles.
- `agents-md-operational-bundle-fragments-anti-pattern` — §"Operational notes" gains a bullet naming the "editing the rendered fragment in AGENTS.md directly is a soft anti-pattern; edit the bundle's `preamble.md` at the source" rule for bundle authors and users.

#### `docs/index.md` — rewrite (5 list items changed)

Stable ID: `index-substrate-catalog-phase-0-1-update`.

- §"Specs" `[[wiki/specs/cli]]` line: "8-command Dome CLI" → "9-command Dome CLI" with the new commands enumerated; bundle-conditional commands named as the dailies/migrate-dailies example.
- §"Specs" `[[wiki/specs/sdk-surface]]` line: extension bundles + `upsertSection` named in the line summary.
- §"Matrices" gains a new entry: `[[wiki/matrices/extension-bundle-shape]]` between `event-types-and-payloads` and `intent-prompt-tools`.
- §"Gotchas" gains two new entries: `extension-bundle-load-order` (alphabetically placed after `dirty-git-state-at-reconcile`) and `scheduled-hook-idempotency` (alphabetically placed after `out-of-band-vault-edits`).
- §"Invariants" `AGENTS_MD_IS_ORIENTATION_SURFACE` line unchanged (the invariant doc was extended but its summary line stays accurate at the catalog level).

## Implementation work (deferred to `cohesive:implement-cohesively`)

These are the code changes the substrate above describes. Each has a stable ID for the delta-coverage reviewer's check.

### Phase 0a — Extension bundle loader

- `phase-0a-loader-skeleton` — create `src/extensions/loader.ts` exporting `loadExtensionBundles(root: string): Promise<Result<ExtensionBundle[], ToolError>>`. Walks `<vault>/.dome/extensions/<bundle>/`, reads each `manifest.yaml`, validates against `ManifestSchema`, returns the typed bundle list in load order (alphabetical by directory name).
- `phase-0a-manifest-schema` — create `src/extensions/manifest-schema.ts` exporting `ManifestSchema = z.object({ name: z.string(), version: z.string().regex(SEMVER), description: z.string().optional(), deps: z.array(z.string()).optional() })` and `Manifest = z.infer<typeof ManifestSchema>`. The `name` is asserted equal to the directory name at load time.
- `phase-0a-bundle-load-cascade` — extend `loadVaultConfig(root)` in `src/vault.ts` (or sibling `src/vault-config.ts`) to also load extension bundles via `loadExtensionBundles(root)`. The function returns the bundles alongside the existing `config`/`pageTypes` tuple.
- `phase-0a-openvault-page-types-merge` — extend `openVault` to merge bundle-contributed `page-types.yaml extensions:` entries into `pageTypes.extensions` before the registry is constructed. Cross-bundle name collisions reject with `Result.err({ kind: 'bundle-load-failure', detail: 'bundles X and Y both declare page type Z' })`.
- `phase-0a-openvault-workflows-merge` — extend the `PromptLoader` initialization in `buildAbstractSurface` / `loadVaultConfig` to scan bundle workflow directories (`<bundle>/workflows/*.md`) alongside `<vault>/.dome/prompts/`. The Workflow registry's `WORKFLOW_NAMES` tuple grows at runtime to include bundle-contributed names.
- `phase-0a-openvault-hooks-register` — extend `buildBuiltinHookRegistry` (or `loadDeclarativeHooks`) to also load bundle hook YAMLs (`<bundle>/hooks/*.yaml`) and register each with ID `<bundle>:<filename>`. Cross-bundle hook-ID collision is structurally impossible by construction; collision-within-bundle (two files with the same name) is a `bundle-load-failure`.
- `phase-0a-openvault-cli-register` — extend `runCli` (in `src/cli/cli.ts`) to surface bundle-contributed CLI commands from `<bundle>/cli/*.ts`. Each bundle's CLI file exports a `command` object (Commander-compatible). Bundle commands appear after the SDK's shipped commands in `dome --help`.
- `phase-0a-hello-world-fixture` — create `tests/fixtures/extensions/hello-world/` with `manifest.yaml`, `page-types.yaml` (declares `hello` type), `preamble.md`, `workflows/say-hello.md`, `hooks/say-hello.yaml` (minutely schedule, fires `say-hello` workflow). The fixture is the canonical bundle the integration test exercises.
- `phase-0a-loader-integration-test` — create `tests/integration/extension-bundles-load.test.ts` asserting: (a) the hello-world fixture loads cleanly, page type registered, preamble captured, workflow loaded, hook registered with ID `hello-world:say-hello`, CLI command registered; (b) two fixture bundles with colliding page-type names reject with `bundle-load-failure`; (c) bundle hooks fire in alphabetical bundle-name order; (d) bundle removal between `openVault` calls clears the bundle's registrations.

### Phase 0b — AGENTS.md preamble fragments

- `phase-0b-buildagentsmd-preamble-arg` — extend `buildAgentsMdTemplated(config, pageTypes, workflowNames, preambleFragments)` in `src/agents-md.ts` to accept an additional ordered array of `{ bundle: string; content: string }`. Empty array → no `## Extension conventions` section rendered.
- `phase-0b-preamble-section-render` — render the `## Extension conventions` section after the existing `## Workflows` section. Each fragment renders as `### <bundle-name>` followed by the fragment's content verbatim.
- `phase-0b-doctor-repair-fragments` — `dome doctor --repair` (in `src/cli/commands/doctor.ts` or `src/cli/doctor/show/` per the v0.5 split) calls `loadExtensionBundles` + threads `preambleFragments` through `buildAgentsMdTemplated`. User-prose section is parsed via the delimiter comments (existing logic) and re-emitted verbatim; the templated section is regenerated to include current preamble fragments.
- `phase-0b-doctor-check-fragment-drift` — `dome doctor` (without `--repair`) reports drift when loaded bundles' preamble fragments are absent from the templated section.
- `phase-0b-invariant-test-update` — extend `tests/invariants/agents-md-is-orientation-surface.test.ts` with the fourth test described in the rewritten invariant: install hello-world fixture, run `--repair`, assert the fragment appears, remove the bundle, re-run `--repair`, assert removal AND user-prose preservation.

### Phase 0c — Schedule field on declarative hooks

- `phase-0c-schema-schedule-field` — extend `DeclarativeHookSchema` in `src/hooks/yaml-loader.ts` with `schedule: z.string().optional()` validated by a cron-parsing helper. Add a `.refine()` that asserts: either `event:` or `schedule:` is present (mutually exclusive in spirit but both allowed); if `schedule:` is present, it parses as a 5-field cron expression.
- `phase-0c-cron-validation` — add `parseCron(expr: string): { ok: true; ... } | { ok: false; reason: string }` in `src/hooks/cron-parse.ts` (or use a dep like `cron-parser` — decide based on dep-bundle policy). The DeclarativeHookSchema's refine calls this; invalid cron rejects the YAML with a validation error.
- `phase-0c-scheduler-wire` — extend `wireDispatcher` in `src/vault.ts` (or sibling) to construct a per-vault scheduler thread that consults the registered schedule-driven hooks, reads `.dome/state/scheduled.json` for last-fire times, wakes on intervals, synthesizes `clock.tick.<hook-id>` events, and dispatches them through `dispatchEvents`. At-most-once-per-reconcile clamp lives in `dome reconcile` Phase 3 logic.
- `phase-0c-scheduled-state-extension` — extend `.dome/state/scheduled.json` shape (in `src/quarantine-store.ts`-analog or new `src/scheduled-store.ts`) to also persist schedule-driven hook last-fire times alongside the existing scheduled-event mechanism. Use `Result`-shape Zod validation per F6 of the prior refactor.
- `phase-0c-reconcile-phase-3-clamp` — extend `src/reconcile.ts` Phase 3 to clamp catch-up to one fire per schedule-driven hook per reconcile run, regardless of how many intervals elapsed since last fire.
- `phase-0c-scheduled-hooks-test` — create `tests/integration/scheduled-hooks.test.ts` asserting: (a) schedule-only hook fires at its cron interval during live serve; (b) catch-up after N missed intervals fires exactly once; (c) `idempotent: false` schedule-driven hook skips reconcile entirely; (d) bare-event hook with `schedule:` fires on both triggers.

### Phase 0d — `upsertSection` Tool

- `phase-0d-tool-impl` — create `src/tools/upsert-section.ts` implementing the find-or-append-by-marker logic. Reads document body; finds `<!-- section:<key> -->` and `<!-- /section:<key> -->` markers; replaces content between them if both present; appends markers + content if absent; returns no-op effect if content matches existing section. Optimistic locking via `expected_mtime` reuses the writeDocument pattern.
- `phase-0d-registry-entry` — extend `TOOL_NAMES` tuple in `src/tools/registry.ts` to include `"upsertSection"`; add corresponding `TOOL_REGISTRY` entry with `mutating: true`. Extend `MCP_TOOL_NAMES` with `upsertSection: "dome.upsert_section"`.
- `phase-0d-schemas` — add `compactUpsertSectionInput` Zod schema in `src/tools/schemas.ts` paralleling the existing tool input schemas. Output is `ToolReturn<Document>`.
- `phase-0d-tests` — create `tests/tools/upsert-section.test.ts` covering: (a) marker-absent case creates markers + appends; (b) marker-present case replaces in place; (c) identical-content case produces no effect (empty effects array, no log entry); (d) optimistic-locking conflict returns `concurrent-write-conflict`.
- `phase-0d-tool-surface-shape-test-update` — extend `tests/integration/public-surface-shape.test.ts` (or the equivalent post-refactor test) to assert `upsertSection` is exported from `@dome/sdk` core via `BoundToolSurface`.

### Phase 0e — `dome run-hook` CLI command

- `phase-0e-command-impl` — create `src/cli/commands/run-hook.ts` implementing `domeRunHook(path, opts: { hookId: string; eventPath?: string; eventPayloadJson?: string }): Promise<Result<void, CliError>>`. Opens vault; constructs the manual-invocation event; calls `vault.dispatchEvents([event])`; awaits the hook handler; returns success/failure.
- `phase-0e-cli-wire` — wire `program.command("run-hook").argument("<id>").option("--event.path <path>").option("--event.payload-json <json>").action(...)` in `src/cli/cli.ts` `buildProgram`.
- `phase-0e-cli-export` — add `export { domeRunHook } from "./commands/run-hook";` to `src/cli/index.ts`. The `cli-shell-shape` lockstep test catches missed re-exports.
- `phase-0e-event-projection-manual-invoked` — extend `src/event-projection.ts` to define the `hook.manual.invoked` event shape (payload: `{ hookId: string; path?: string; ...userPayload }`). The dispatcher's matcher routes the event to the named hook by ID.
- `phase-0e-dispatch-by-hook-id` — extend the `HookDispatcher` matcher to also match on event payload `hookId` when the event type is `hook.manual.invoked`. (Alternative: synthesize the event as the hook's normal event type with the payload from `--event.path` etc.; the design picks the simpler match-by-ID approach.)
- `phase-0e-tests` — create `tests/integration/run-hook.test.ts` covering: (a) `dome run-hook hello-world:say-hello` invokes the hello-world fixture's hook; (b) unknown hook ID exits with usage error; (c) quarantined hook refuses with the doctor-suggestion error; (d) manually invoked hook fires even when declared `idempotent: false`; (e) the `hook.manual.invoked` event appears in `log.md`.

### Phase 1a — Dailies bundle skeleton

- `phase-1a-bundle-skeleton` — create `assets/extensions/dailies/manifest.yaml` (`name: dailies`, `version: 1.0.0`, `description: "First-party rhythm bundle: daily + weekly notes with carry-forward."`).
- `phase-1a-daily-page-type` — create `assets/extensions/dailies/page-types.yaml` declaring `daily` and `weekly` page types per the schema added to `page-schema.md` §"daily and weekly extension types".
- `phase-1a-daily-preamble` — create `assets/extensions/dailies/preamble.md` explaining: dailies live at `wiki/dailies/<YYYY-MM-DD>.md` (weeklies at `wiki/weeklies/<YYYY-W##>.md`); Obsidian Tasks plugin syntax is honored verbatim; the carry-forward semantic copies open `- [ ]` task lines from yesterday with `from [[wiki/dailies/<prev>]]` footer attribution; the create-daily / create-weekly workflows fire on schedule; the migrate-dailies CLI is the one-shot path for moving existing `notes/<YYYY-MM-DD>.md` into the bundle's layout.

### Phase 1b — Daily creator hook + workflow

- `phase-1b-create-daily-hook` — create `assets/extensions/dailies/hooks/create-daily.yaml` with `schedule: "0 6 * * *"`, `workflow: create-daily`, `idempotent: true`. The workflow self-guards against re-creation when today's daily already exists.
- `phase-1b-create-daily-workflow` — create `assets/extensions/dailies/workflows/create-daily.md` with frontmatter (`tools: [readDocument, writeDocument, upsertSection]`, `triggers:`) and a prompt body that (a) checks if `wiki/dailies/<today>.md` exists (no-op if yes), (b) reads `wiki/dailies/<yesterday>.md` if it exists, (c) parses open `- [ ] #task` lines (Obsidian Tasks syntax — priority emojis, no completion-date markers), (d) constructs today's daily from the template (`# Notes`, `## Today's meetings`, `# What did I get done today?`, `# Story of the day` headings) with carried-forward tasks appearing under `# Notes` with the `from [[wiki/dailies/<yesterday>]]` footer for each, (e) writes today's daily via `writeDocument` with frontmatter `{date, prev: [[wiki/dailies/<yesterday>]], next: null, tags: [daily]}`.

### Phase 1c — Carry-forward semantics

- `phase-1c-carry-forward-parser` — implement an in-workflow parser for Obsidian Tasks plugin syntax: matches `^- \[ \] (#task )?(.*?)(\s+⏫|🔼|🔽)?(\s+\[\[.+?\]\])*(\s+✅ \d{4}-\d{2}-\d{2})?\s*$`; classifies as "open" (no ✅) or "completed" (has ✅). Only "open" lines carry forward.
- `phase-1c-carry-forward-tests` — extend the bundle integration test (Phase 1f) to verify carry-forward: fixture vault has yesterday's daily with three open tasks + one completed task; creator hook fires; today's daily contains the three open tasks (each with `from` footer) and not the completed task.

### Phase 1d — Weekly creator hook + workflow

- `phase-1d-create-weekly-hook` — create `assets/extensions/dailies/hooks/create-weekly.yaml` with `schedule: "0 6 * * 1"` (Monday 6am), `workflow: create-weekly`, `idempotent: true`.
- `phase-1d-create-weekly-workflow` — create `assets/extensions/dailies/workflows/create-weekly.md`. Reads the seven dailies from the current week (`wiki/dailies/<YYYY-MM-DD>.md` for each day Mon-Sun) AND the seven dailies from last week (for context). Carries forward unfinished tasks from last week's weekly (`wiki/weeklies/<YYYY-W##>.md`) into this week's. Constructs the weekly with frontmatter `{week, dailies: [...], prev: [[wiki/weeklies/<prev-week>]], next: null, tags: [weekly]}` and a body that summarizes the week's narrative (the workflow's LLM call composes this from the dailies' content).

### Phase 1e — `dome migrate-dailies` bundle-contributed CLI

- `phase-1e-cli-command` — create `assets/extensions/dailies/cli/migrate-dailies.ts` exporting a Commander-compatible command object: `{ name: "migrate-dailies", description: "...", action: async (opts) => { ... } }`. The bundle loader registers it; it appears in `dome --help` when the bundle is loaded.
- `phase-1e-cli-logic` — implementation: scan `<vault>/notes/*.md` for files matching `^\d{4}-\d{2}-\d{2}\.md$`; for each, compute target path `wiki/dailies/<date>.md`; read the file; transform frontmatter to match the dailies bundle's schema (preserve user fields, ensure `date`/`prev`/`next`/`tags` are set); call `vault.tools.moveDocument(from, to, reason: "migrate to dailies bundle layout")`. `moveDocument` atomically relocates AND rewrites incoming wikilinks per the existing Tool contract. The command is idempotent: re-running on an already-migrated vault detects "no notes/<YYYY-MM-DD>.md files match" and exits with status 0 + a "nothing to migrate" message.
- `phase-1e-tests` — create `tests/integration/migrate-dailies.test.ts` exercising: (a) fixture vault with `notes/2026-05-25.md` and `notes/2026-05-26.md` migrates to `wiki/dailies/2026-05-25.md` and `wiki/dailies/2026-05-26.md` with rewritten frontmatter + incoming-wikilink rewrites; (b) re-running the migration is a no-op; (c) the migration is committed as a single workflow-style commit per [[wiki/specs/hooks]] §"Commit policy".

### Phase 1f — Bundle-load integration tests

- `phase-1f-dailies-bundle-load-test` — extend `tests/integration/extension-bundles-load.test.ts` (Phase 0a) with a `dailies`-specific section: install `assets/extensions/dailies/` into a fixture vault's `.dome/extensions/`, run `openVault`, assert (a) `daily` and `weekly` page types are registered, (b) AGENTS.md (post `--repair`) contains the dailies preamble fragment, (c) the two scheduled hooks are registered with IDs `dailies:create-daily` and `dailies:create-weekly`, (d) the `migrate-dailies` CLI command is registered, (e) `dome run-hook dailies:create-daily` synthesizes the event and the workflow fires (mock LLM call to avoid real-token spend in CI; assert the workflow's prompt is loaded correctly).

## Updated substrate counts (post this rewrite)

The substrate uses categorical references rather than inline counts (per `wiki/gotchas/substrate-count-drift.md`). The figures below are the in-flight delta-ledger view, not normative content:

- **Specs:** unchanged — same 8 specs at `docs/wiki/specs/`. Five gain extensions in this rewrite (`sdk-surface`, `hooks`, `cli`, `vault-layout`, `page-schema`); three are untouched (`harnesses`, `mcp-surface`, `prompts-and-workflows`).
- **Named invariants:** unchanged — same set per `src/types.ts` `INVARIANTS`. One invariant doc (`AGENTS_MD_IS_ORIENTATION_SURFACE`) gains substantive extensions covering preamble fragments.
- **Behavior matrices:** +1 net. New: `extension-bundle-shape`. Existing matrices unchanged at the substrate layer (tool-invariant-enforcement implicitly extends when upsertSection ships in code).
- **Gotchas:** +2 net. New: `extension-bundle-load-order`, `scheduled-hook-idempotency`. Both ship with `enforced_at_status: deferred` pending the Phase 0a/0c integration tests.
- **Semantic linter specs:** unchanged — same two specs at `docs/wiki/linters/`.
- **Repo-root orientation files:** unchanged — `AGENTS.md` and `CLAUDE.md` at vault root, established in the prior refactor.
- **Tools:** the canonical Tool catalog grows from 7 to 8 with `upsertSection` (substrate change in this rewrite; code change deferred to Phase 0d).
- **Shipped CLI commands:** grow from 8 to 9 with `dome run-hook` (substrate change in this rewrite; code change deferred to Phase 0e). Bundle-conditional commands (`dome migrate-dailies` from the dailies bundle) appear at the runtime layer and don't increment the SDK count.

## Deferred (do NOT close in this rewrite)

- **Phase 2 — compile-on-write keystone.** The LLM-driven hooks that propagate daily-edit narrative into entity/concept/meeting pages. Needs design-gate confirmations (compile trigger timing — async-debounced vs sync-on-save vs manual-only vs hybrid; LLM call location — workflow registry vs abstraction) and substantial eval-suite work. Out of scope; lives in the brainstorm's Layer 2 and the plan's Phase 2.
- **Phase 3 — aggregation & reflection.** The `aggregation` bundle (weekly rollup, monthly retro, stale-thread surface). Depends on Phase 2's last-interaction frontmatter output for L3.3.
- **Phase 4 — recall workflows.** The `recall` bundle (plan-today, follow-up-with, retro-recall). Pure workflows, no new hook plumbing; can dogfood early but sharpens post-Phase 2.
- **Programmatic TS hook loader.** The v0.5.1 deferral in the prior refactor stays unchanged. Bundles can contribute YAML hooks in v0.5; TS hooks in bundles land in v0.5.1 with the broader programmatic-loader work.
- **`dome install-extension <name>` CLI helper.** v0.5 ships the copy-by-hand pattern documented in `sdk-surface.md` §"How bundles ship". The install-extension command lands when the SDK's `assets/extensions/` directory grows beyond the dailies bundle alone.
- **Cross-bundle dependencies.** `manifest.yaml deps:` field is informational in v0.5. Dependency resolution between bundles is a v0.5.1+ concern.
- **Bundle distribution via npm.** All bundles in v0.5 are vault-local copies of SDK-shipped or user-authored directories. npm-distributable bundles are a v1+ concern.
- **`Tool` contributions from bundles.** v0.5 bundles can contribute the four kinds (page-types, preamble, workflows, hooks, CLI commands) but not Tools — the programmatic Tool-loader for vault-local sources ships in v0.5.1 alongside the programmatic hook loader.

## Repair pass 1 (Issues Found → Repair → re-validate)

**Source review:** [`docs/cohesive/reviews/2026-05-26-dome-hooks-phase-0-1-skeleton-rewrite-validation.md`](../reviews/2026-05-26-dome-hooks-phase-0-1-skeleton-rewrite-validation.md) (pass 1, Issues Found).
**Closes:** B1, B2, B3, B4, B5, I1, I2, I3, I4, I5.

Five Blocker/High findings (B1 ledger body header count drift; B2 sdk-surface Tool count drift at 6 sites; B3 "Adding an 8th Tool" cross-references stale at 3 sites; B4 hooks.md "Four forms" / 5 enumerated forms count divergence; B5 scheduled-hook event-name reconciliation between `clock.tick.<hook-id>` and the pre-existing `clock.tick.<interval>` taxonomy) and five Medium/Low findings (I1 `dome backfill-daily` undefined-command reference; I2 matrix mixing shipped + anticipated rows without lockstep-safe distinction; I3 bundle-loader error vocabulary split across three names without a canonical home; I4 MCP `instructions` parity with AGENTS.md preamble fragments unaddressed; I5 spurious `dome install-extension` workflow reference) closed in the same worktree.

## Repair pass 2 (Approved + Medium → Close in same worktree → merge)

**Source review:** [`docs/cohesive/reviews/2026-05-26-dome-hooks-phase-0-1-skeleton-rewrite-validation-pass-2.md`](../reviews/2026-05-26-dome-hooks-phase-0-1-skeleton-rewrite-validation-pass-2.md) (pass 2, Approved).
**Closes:** I1 (pass-2), I2 (pass-2), I3 (pass-2), + Substrate gap recommendation (matrix-row step in §"Adding a new extension bundle" recipe), + Vague-language items.

Three Medium close-inline edits + one substrate-gap close + two vague-language tightens:

- **I1 (pass-2) closed** — `sdk-surface.md:576` updated from "seven `dome*` command functions" to "nine `dome*` command functions" with the nine names enumerated parenthetically (`domeInit`, `domeMigrate`, `domeServe`, `domeReconcile`, `domeLint`, `domeStats`, `domeDoctor`, `domeRunHook`, `domeExportContext`).
- **I2 (pass-2) closed** — `extension-bundle-shape.md` Status column split: `shipped` (assets/extensions/), `test-fixture` (tests/fixtures/extensions/), `anticipated` (lockstep skips). Added explicit lockstep-behavior table immediately above the matrix.
- **I3 (pass-2) closed** — delta-ledger preamble (this §"Delta at a glance" block) rewritten as the canonical 8-bullet form (Files / Conceptual changes / Named invariants / Behavior matrices / Gotchas / Semantic linters / Tests proposed / Deferred). The Classification statement now leads as a one-line preamble; the (a)–(i) sub-changes from pass-1 consolidate into the Conceptual changes bullet, with full per-file specifics preserved in §"Per-file changes" below.
- **Substrate-gap (recipe parity) closed** — `sdk-surface.md` §"Adding a new extension bundle" gains a 9th explicit step naming the [[wiki/matrices/extension-bundle-shape]] row addition, paralleling the AC3 discipline of §"Adding a new invariant".
- **Vague-language closed** — `hooks.md:69` YAML comment tightened from "mutually exclusive with event in spirit, both allowed" to "can coexist with event: — hook fires on either trigger". Ledger stable ID `hooks-adding-a-new-hook-four-forms` renamed to `hooks-adding-a-new-hook-five-forms` (matches the spec body's correct "Five forms by mechanism" lead line).

No new substrate concepts were introduced; no design-layer choices were re-derived. Pass-2 close-inline edits are textual repairs against the pass-2 review findings.

## History

This rewrite is the first design-rewrite of the v1-features pass following the v0.5-to-v1-tightening refactor. The earlier refactor's delta ledgers are referenced as substrate continuity:

- v0.5-to-v1 tightening (just-landed): `docs/cohesive/delta-ledgers/2026-05-26-dome-v0.5-to-v1-tightening.md` — shipped composable-`openVault`, `vaultRef`, PromptLoader-per-Vault, Zod boundary validation, AGENTS.md delimiter lockstep, the recipes ("Adding a new X is N file edits"), and the doctor split.
- Compiler reframe: `docs/cohesive/delta-ledgers/2026-05-26-dome-compiler-reframe.md` — reframed `dome serve` as compiler daemon + introduced `AGENTS_MD_IS_ORIENTATION_SURFACE` + `VAULT_RECONCILES_AFTER_NATIVE_WRITE` axioms.

This Phase 0 + Phase 1 skeleton rewrite extends those refactors with the extension-bundle mechanism + schedule-driven hooks + the upsertSection Tool + the run-hook CLI + the AGENTS.md preamble-fragment threading + the first-party `dailies` bundle skeleton. It closes the brainstorm's pressure-test G1/G3/G4/G5 at the substrate layer; the implementation pass that follows makes the substrate's claims true in code. The four follow-up phases (Phase 2/3/4 + the deferred programmatic-loader/install-extension/npm-distribution work) sequence after.
