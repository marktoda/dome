# Change Cohesion Review — Dome hooks Phase 0a (extension bundle loader)

**Reviewer:** cohesive:substrate-alignment-reviewer (fresh-eyes subprocess)
**Date:** 2026-05-27
**Verdict:** Pass with notes

## Main concern

The Phase 0a slice implements the substrate's spine correctly. Three substrate-alignment issues remain — none block Phase 0a; the cli-collision High finding was closed inline post-review at commit `e77ecd9`. Two Medium notes (hook source provenance, taxonomy test gaps) remain as follow-ups for Phase 0b/0c.

## Verified

- 6-step bundle-load lifecycle: Phase 0a steps (1 page-types, 3 workflows, 4 hooks, 5 CLI) all wired. Step 2 (preamble) captured at `ExtensionBundle.preamblePath` but not yet threaded into AGENTS.md — explicitly deferred to Phase 0b. Step 6 (tools) deferred to v0.5.1+ per spec.
- Hook ID namespacing: `src/hooks/yaml-loader.ts:170` produces `<bundle>:<filename-stem>` correctly.
- Fail-loud collision: `vault-config.ts:126-170` seeds `seenNames` from vault-local + earlier bundles; covers both cross-bundle and bundle-vs-vault-local cases.
- HOOKS_CANNOT_BYPASS_TOOLS: `hook-dispatcher.ts:131-133` gates `privilegedWriter` on `source === "sdk"`; bundle hooks register as `"vault-local"` so the fence holds.
- CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY: `src/extensions/` imports only `yaml`, `zod`, `node:fs`, `node:fs/promises`, `node:path`.

## Closed inline (post pass-1 review)

### `cli-collision` taxonomy entry now fires (was: enumerated but unfired)

Pre-fix `src/cli/cli.ts:478-491` called `program.command(cmd.name)` for every bundle CLI export with no collision check against the nine shipped commands or against earlier bundles' registrations. Commander's behavior on duplicate command names is silently last-write-wins — a user installing a community bundle named `migrate` would silently shadow `dome migrate`.

Fix at commit `e77ecd9`: `registerBundleCliCommands` now seeds a `seenNames` set from `program.commands` (the nine shipped names), tracks `provenance`, and returns `bundle-load-failure` with `detail: cli-collision` on conflict. Integration test added (`tests/integration/extension-bundles-load.test.ts` — "bundle CLI command colliding with shipped command name fails with cli-collision").

## Remaining notes (Medium — deferred follow-ups)

| Severity | Area | Evidence | Change | Doc to update |
|---|---|---|---|---|
| Medium | Spec drift | `docs/wiki/specs/page-schema.md:107` — claims bundle source `"extension:<bundle>"`; `src/hooks/yaml-loader.ts:170` registers bundle hooks with `source: "vault-local"` | Pick one source-of-truth: either extend `HookSource` with `"extension:<bundle>"` variant (and update privileged-writer gate to also deny extensions) AND surface bundle provenance in `dome doctor --show workflows`; OR retract the page-schema claim and point at the `<bundle>:<id>` ID-prefix namespacing as the diagnostic surface | `src/hooks/hook-registry.ts` (add variant) OR `docs/wiki/specs/page-schema.md:107` (retract claim) |
| Medium | Test guarantee | `tests/integration/extension-bundles-load.test.ts` covers `page-type-collision`, `manifest-invalid`, `manifest-missing`, `cli-collision`. Four of the seven enumerated `detail:` discriminators (`name-mismatch` is unit-tested only at `tests/extensions/loader.test.ts:56`; `hook-invalid`, `workflow-invalid`, and the remaining have no end-to-end test) | Either ship end-to-end tests per taxonomy entry now, OR add an AC3-style lockstep meta-test that parses the `detail:` union from `src/types.ts` and asserts each value appears in at least one `expect(...).toBe(<detail>)` call in the integration suite | `tests/integration/extension-bundles-load.test.ts` (add cases or meta-test) |

Both follow-ups touch surfaces Phase 0c (`dome run-hook`) and Phase 0b (AGENTS.md preamble fragments) will revisit; addressing them in those subsequent passes is the natural seam.

## What looked right

- **Bundle-loader error taxonomy as one kind + discriminator** is a model future-extensibility pattern: callers handle one error kind, new failure modes are one-row additions.
- **Hook-ID namespacing as structural-by-construction**: cross-bundle hook-ID collision is impossible without any runtime check.
- **Fail-loud collision detection on page-types** produces a useful error message naming both sources via the `provenance` map rather than a generic "duplicate."

## Next

**Disposition:** Pass with notes — proceed to handoff. Two Medium follow-ups are documented above and should be addressed in Phase 0b/0c or as standalone tightening before v1 ships.
