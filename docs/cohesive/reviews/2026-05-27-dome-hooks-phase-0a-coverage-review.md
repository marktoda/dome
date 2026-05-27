# End-of-run Coverage Review — Dome hooks Phase 0a (extension bundle loader)

**Reviewer:** cohesive:delta-coverage-reviewer (fresh-eyes subprocess)
**Date:** 2026-05-27
**Verdict:** Covered

## Coverage table

| Delta entry (stable ID) | Plan task(s) | Diff hunks | Status |
|---|---|---|---|
| `phase-0a-loader-skeleton` | Task 3 | `src/extensions/loader.ts:1-159` (new); `src/extensions/index.ts:1-2` | Covered |
| `phase-0a-manifest-schema` | Task 2 | `src/extensions/manifest-schema.ts:1-53` (`ManifestSchema`, `parseManifest`, semver regex, `Manifest` type) | Covered |
| `phase-0a-bundle-load-cascade` | Task 5 | `src/vault-config.ts:29,33,118-178` (`loadExtensionBundles` invoked, `bundles` threaded into `LoadedVaultConfig`); `src/vault.ts:14,49-54,163,202,223` (`Vault.bundles` field exposed + populated) | Covered |
| `phase-0a-openvault-page-types-merge` | Task 5 | `src/vault-config.ts:121-174` (merge loop with `seenNames`+`provenance` + fail-loud on cross-bundle + vault-vs-bundle collision via `bundle-load-failure`/`page-type-collision`) | Covered |
| `phase-0a-openvault-workflows-merge` | Task 7 | `src/prompts/prompt-loader.ts:31-65` (vault-local → bundle → SDK priority chain); `:87-95` (`list()` includes bundle workflows) | Covered |
| `phase-0a-openvault-hooks-register` | Task 6 | `src/hooks/yaml-loader.ts:31,146-178` (bundle scan; ID `${bundle.name}:${parsed.id}`; `source: "vault-local"` partitioning) | Covered |
| `phase-0a-openvault-cli-register` | Task 8 | `src/cli/cli.ts:11,428-497,507-516` (`extractVaultFlag` pre-scan, `registerBundleCliCommands` dynamic import + Commander wiring) | Covered |
| `phase-0a-hello-world-fixture` | Task 4 | `tests/fixtures/extensions/hello-world/manifest.yaml`; `page-types.yaml`; `preamble.md`; `workflows/say-hello.md`; `hooks/say-hello.yaml` (all 5 files added) | Covered |
| `phase-0a-loader-integration-test` | Task 9 | `tests/integration/extension-bundles-load.test.ts:1-124` (5 cases: clean load, collision, removal, manifest-invalid, manifest-missing) | Covered |

Supporting plan tasks landed: Task 1 (`bundle-load-failure` variant added to `ToolError` at `src/types.ts:57-69`, with `tests/types.test.ts`). Unit/integration tests landed for each implementation seam: `tests/extensions/manifest-schema.test.ts`, `tests/extensions/loader.test.ts`, `tests/vault-config.test.ts:54-101`, `tests/hooks/yaml-loader-bundles.test.ts`, `tests/prompts/prompt-loader-bundles.test.ts`, `tests/cli/cli-bundles.test.ts`.

## Out-of-scope hunks (verified, no drift)

The diff also contains substrate-doc hunks for the rewrite pass (ledger, two reviews, `docs/index.md`, two gotchas, AGENTS_MD invariant extension, `extension-bundle-shape.md` matrix, five spec rewrites). These are the rewritten specs the Phase 0a implementation makes true; they were authored in the prior rewrite session, not by this implementation pass. They do not introduce code outside the named Phase 0a stable IDs.

Phase 0b–1f stable IDs (preamble fragments, schedule field, `upsertSection`, `dome run-hook`, dailies bundle, migrate-dailies CLI) are explicitly deferred per the dispatch scope and have no corresponding code hunks — correct.

## What looked right

- **Bundle-CLI registration seam is the cleanest possible shape.** `extractVaultFlag` pre-scans argv, opens the vault once, dynamically imports each `cliPaths` entry, and closes the vault in a `finally`. The fail-loud posture surfaces `bundle-load-failure` into `outcome.code` rather than crashing Commander mid-parse.
- **Cross-bundle page-type collision detection tracks provenance.** `src/vault-config.ts:135` seeds `seenNames` from vault-local extensions so vault-vs-bundle collisions also reject; the `provenance` map produces a useful error message naming the prior declarer rather than a generic "duplicate."

## Post-review follow-ups (closed inline)

- The substrate-alignment-reviewer's `cli-collision unfired` High finding closed via commit `e77ecd9` (`src/cli/cli.ts` now seeds `seenNames` from shipped commands and fires `bundle-load-failure` with `detail: cli-collision` on conflict; integration test added).
