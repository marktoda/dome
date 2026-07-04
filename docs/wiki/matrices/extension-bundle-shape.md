---
type: matrix
created: 2026-05-27
updated: 2026-06-26
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
description: Which contributions (page types, processors, handlers, grants) each shipped bundle provides; lockstep-tested against the assets.
---

# Extension bundle shape matrix

The canonical map of "what an extension bundle contributes to a vault." Rows are bundles (first-party shipped + community-authored shapes anticipated); columns are the five registration kinds bundles can contribute. Each cell names which file (or directory) inside the bundle provides the contribution, or marks the kind unused by this bundle.

**Lockstep status:** shipped. `tests/integration/bundle-matrix-lockstep.test.ts` parses this matrix and asserts each active first-party shipped filename, page type, manifest module, and manifest capability kind agrees with the bundle assets. Rows with `Status: anticipated` are documentation-of-intent and skipped until promoted.

| `Status` value | Location convention | Lockstep behavior |
|---|---|---|
| `shipped` | `assets/extensions/<bundle>/` in the SDK package (resolved at runtime; not copied into vaults) | Iterate; assert each shipped filename exists. Cells may include `future:` notes, which are non-normative until promoted with assets and tests. |
| `test-fixture` | `tests/harness/fixtures/bundles/<bundle>/` (only in the SDK repo, never shipped or installed) | Iterate; assert each named filename exists. |
| `anticipated` | n/a (documentation-of-intent for future-pressure bundles) | Skip — rows with this status are non-normative future pressure. |

An **extension bundle** is a directory under `<vault>/.dome/extensions/<bundle-name>/` (or shipped from the SDK at `assets/extensions/<bundle-name>/`) containing a `manifest.yaml` plus contributions across seven kinds: page-types, preamble fragments, processors, external-handlers, capability grants, loops, doctor grant-entry probes. The bundle mechanism is the only registration path in v1 — there is no separate "tool," "hook," or "workflow" registration kind.

## Seven contribution kinds

- **Page type** — `<bundle>/page-types.yaml` adds entries to the runtime `PageTypeRegistry` during bundle load. Each entry declares the type name and optional `frontmatter_extras` schema; vault-local `.dome/page-types.yaml` is merged later from the candidate snapshot by `dome.markdown.lint-frontmatter`.

- **Preamble fragment** — planned `<bundle>/preamble.md` support will contribute a markdown subsection to AGENTS.md's templated `## Extension conventions` section. The current loader does not yet merge preambles; until that lands, rows naming `preamble.md` are future pressure unless the row is promoted with implementation and tests.

- **Processors** — `<bundle>/processors/*.ts` export implementation objects via `defineProcessorImplementation({ run })` per [[wiki/specs/processors]] §"Registration". The bundle's manifest lists each processor's fully qualified dotted id, version, phase, triggers, capabilities, execution policy, inspection scope, and module path. Bundle-name-prefixed IDs (`dome.daily.create-daily`) prevent cross-bundle collision.

- **External handlers** — `<bundle>/external-handlers/*.ts` register handlers for external capabilities (calendar, notify, network) per [[wiki/specs/capabilities]] §"external". The filename stem is the capability name, so `external-handlers/calendar.write.ts` registers `calendar.write`. A bundle may register an external handler for a capability it doesn't grant to its own processors (so a calendar-sync bundle can provide a `calendar.write` handler that other bundles' processors consume). Collisions across the loaded bundle set fail before runtime open.

- **Capability grants** — `<bundle>/manifest.yaml`'s `processors[].capabilities` declares per-processor capabilities; `<vault>/.dome/config.yaml`'s `extensions.<bundle>.grant` declares per-bundle grants. The intersection is what the broker enforces per [[wiki/invariants/EVERY_EFFECT_IS_CAPABILITY_CHECKED]].

- **Doctor grant-entry probes** — `<bundle>/manifest.yaml`'s `doctor.grantEntries:` block declares "this processor needs this specific grant entry or X silently breaks" probes ([[wiki/specs/cli]] §"`dome doctor`"). Each names the processor (must be this bundle's own), the required `{kind, target}` entries, why the gap matters, and the exact config remediation. The health report evaluates composed entries generically; a probe fires only when the processor is loaded, the manifest still declares the entry, and the kind is granted but the entry is not.

- **Loops** — `<bundle>/manifest.yaml`'s `loops:` block declares bundle-scoped maintenance loops ([[wiki/specs/sdk-surface]] §"Adding a maintenance loop"): id, goal, evidence, processors (must be this bundle's own), optional foreign contributors, surfaces, settlement `{key, noOpWhen}`, risks. The runtime composes them with the core's cross-bundle registry; loop-id collisions fail `openVault`. First-party bundles declare none today — their loops are cross-bundle compositions and stay in the core registry by design.

## Matrix

| Bundle ↓ \ Contribution kind → | Status | Page type (`page-types.yaml`) | Preamble (`preamble.md`) | Processors (`processors/*.ts`) | External handlers (`external-handlers/*.ts`) | Capability grants (default) |
|---|---|---|---|---|---|---|
| **`dome.markdown`** *(first-party)* | `shipped` | — | — | `validate-wikilinks.ts`, `ambiguous-wikilink-answer.ts`, `repair-wikilinks.ts`, `render-index.ts`, `normalize-frontmatter.ts`, `lint-frontmatter.ts`, `page-status.ts`, `lint-supersession.ts`, `broken-images.ts`, `stale-dates.ts`, `refresh-updated.ts`, `raw-immutable.ts`, `core-size.ts`, `orphan-pages.ts` | — | `read: ["**/*.md", "core.md", ".dome/page-types.yaml", images, "raw/**"]` (`core.md` named explicitly so the `core-size` lint survives narrowed markdown read scopes); `patch.auto: ["**/*.md", "wiki/syntheses/*.md", "index.md", "index-*.md" (legacy, retirement window), "meta/index-*.md"]`; `graph.write: ["dome.page.*"]` (frontmatter status/supersession facts from `page-status.ts`); `question.ask: true` |
| **`dome.graph`** *(first-party)* | `shipped` | — | — | `links.ts`, `tag-index.ts` | — | `read: ["**/*.md"]`; `graph.write: ["dome.graph.*"]` |
| **`dome.health`** *(first-party)* | `shipped` | — | — | `outbox-recovery-questions.ts`, `outbox-recovery-answer.ts`, `quarantine-recovery-questions.ts`, `quarantine-recovery-answer.ts`, `orphan-run-recovery-questions.ts`, `orphan-run-recovery-answer.ts`, `report-card.ts` | — | `read: ["**"]` for failed-row source provenance; `outbox.read: ["failed"]`; `outbox.recover: true`; `quarantine.read: true`; `quarantine.recover: true`; `run.read: ["running"]`; `run.recover: true`; `question.ask: true`; and — for `report-card` (per-processor replacement grant) — `read`/`patch.auto` over `meta/report-card.md` + `wiki/dailies/*.md`, `run.read: true` (all statuses), `questions.read: true` |
| **`dome.links`** *(first-party)* | `anticipated` | — | `preamble.md` | `cross-reference.ts` | — | `read: wiki/**`; `patch.propose: ["wiki/**"]` |
| **`dome.agent`** *(first-party)* | `shipped` | — | —; future: `preamble.md` | `brief-index.ts`, `calendar-index.ts`, `ingest.ts`, `inbox-stale-check.ts`, `consolidate.ts`, `sweep.ts`, `sweep-answer.ts`, `brief.ts`, `preference-signals.ts`, `preference-promotion.ts`, `preference-promotion-answer.ts`, `active-projects.ts`, `patrol.ts` | — | `read: ["wiki/**/*.md", "notes/**/*.md", "inbox/**/*.md", "index.md", "log.md", "meta/consolidation-ledger.md", "meta/sweep-ledger.md", "sources/calendar/*.md", "sources/slack/*.md", "core.md", "preferences/signals.md"]`; `patch.auto: ["wiki/**/*.md", "notes/**/*.md", "inbox/processed/*.md", "inbox/raw/*.md", "meta/consolidation-ledger.md", "meta/sweep-ledger.md", "preferences/signals.md"]` — `index.md` and `log.md` are read-only (same grant shape as `core.md`): the index is a generated render of `description:` frontmatter and `log.md` is frozen history per [[wiki/invariants/NO_ACCRETING_REGISTRIES]], with the grant-aware tools denying stray writes at tool time; `core.md` is read-only in the bundle grant: the propose-only core-memory page appears in exactly TWO `patch.auto` declarations — `preference-promotion-answer`'s (narrow per-processor replacement grant: `read` + `patch.auto` over `core.md` + `preferences/signals.md` only; owns the promoted-preferences block) and the deterministic `active-projects` renderer's (`read: ["core.md", "wiki/dailies/*.md"]` + `patch.auto: ["core.md"]`; owns the active-projects block) — per [[wiki/specs/preferences]] §two-gated-writers (every core.md `patch.auto` holder owns a distinct generated block) (the `brief` processor declares only `wiki/dailies/*.md` + `notes/*.md` + `preferences/signals.md` for `patch.auto`, but its `read` declaration includes `inbox/**/*.md` + `meta/consolidation-ledger.md` so the scoped questions batch keeps ingest- and consolidate-raised questions; the `sweep` processor reads `meta/sweep-ledger.md` as the advisory cursor file and patches `wiki/entities/**/*.md` + `wiki/concepts/**/*.md` + `meta/sweep-ledger.md` via a narrower per-processor patch.auto); `model.invoke: { maxDailyCostUsd: 5 }` on ingest and brief (each declared cap bounds that processor's OWN daily spend; the extension-wide pool is the vault grant's job — [[wiki/specs/capabilities]] §"model.invoke"); `model.invoke: { maxDailyCostUsd: 10 }` on consolidate and sweep; `question.ask: true` for owner clarifications and promotion questions; `graph.write: ["dome.preference.*"]` for the deterministic `preference-signals` counter ONLY — the model processors still declare no `graph.write` (MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS) |
| **`dome.claims`** *(first-party)* | `shipped` | — | — | `claim-index.ts`, `stamp-anchor.ts`, `render-facts.ts`, `stale-claims.ts` | — | `read: ["wiki/**/*.md", "notes/*.md"]`; `patch.auto: ["wiki/**/*.md", "notes/*.md"]`; `graph.write: ["dome.claims.*"]` |
| **`dome.daily`** *(first-party)* | `shipped` | `daily`; future: `weekly` | — | `agenda-with.ts`, `ambiguous-followup-answer.ts`, `carry-forward.ts`, `close-scaffold.ts`, `compose-blocks.ts`, `create-daily.ts`, `normalize-task-syntax.ts`, `prep.ts`, `reconcile-tasks.ts`, `settle-stale-answer.ts`, `stale-task-warden.ts`, `stamp-block-id.ts`, `task-index.ts`, `today.ts`; future: `create-weekly.ts`, `week-review.ts`, `append-followup.ts` | — | `read: ["wiki/**/*.md", "sources/calendar/*.md", "sources/slack/*.md", "meta/sweep-ledger.md"]` (the sources/ledger entries feed `compose-blocks.ts`); `patch.auto: ["wiki/**/*.md"]`; `graph.write: ["dome.daily.*"]`; `question.ask: true`; `questions.read: true` (compose-blocks reads open questions for the "To decide" block) |
| **`dome.lint`** *(first-party)* | `shipped` | — | — | `report.ts`; future: `apply-finding.ts` | — | `read: ["**/*.md"]`; future: `patch.propose: ["**"]` |
| **`dome.search`** *(first-party)* | `shipped` | — | — | `index-text.ts`, `query.ts`, `export-context.ts` | — | `read: ["**/*.md"]`; `search.write: ["**/*.md"]` |
| **`dome.sources`** *(first-party)* | `shipped` | — | — | `fetch.ts` | `sources.fetch.ts` (the first shipped use of the contribution kind: a generic spawn-the-vault-configured-fetch-command handler bound by filename stem; `openVaultRuntime` injects the vault root into bundle handler input) | `read: ["sources/**/*.md", ".dome/config.yaml"]` (skip-if-present snapshot reads + the config consent surface); `external: ["sources.fetch"]` — the subscription opt-in per [[wiki/specs/sources]] (shipped default flips every subscription `enabled: false`) |
| **`dome.migrate`** *(first-party)* | `anticipated` | — | — | `migrate-vault.ts` | — | `read: ["**"]`; `patch.auto: ["**"]` (migrations need broad reach by design) |
| **`hello-world`** *(test fixture)* | `test-fixture` | `hello` | `preamble.md` | `say-hello.ts` | — | `read: wiki/**`; `patch.auto: ["wiki/hellos/**"]` |
| **`acme.calendar-sync`** *(third-party — anticipated)* | `anticipated` | — | `preamble.md` | `sync-events.ts`, `event-to-task.ts` | `calendar.write.ts`, `calendar.read.ts` | `read: wiki/**`; `external: ["calendar.write", "calendar.read"]`; `patch.propose: ["wiki/dailies/**"]` |
| **`community.spaced-repetition`** *(third-party — anticipated)* | `anticipated` | `flashcard` | `preamble.md` | `extract-cards.ts`, `schedule-review.ts` | — | `read: wiki/**`; `graph.write: ["community.spaced-repetition"]`; `patch.auto: ["wiki/flashcards/**"]` |

## Reading the matrix

- **A bundle with no `Page type` cell** doesn't extend the wiki ontology; it operates over the existing types.
- **A bundle with `owns.path` in its capability grants** is the exclusive writer for those paths. No shipped first-party bundle uses it today (the planned `dome.index`/`dome.log` owners are retired per [[wiki/invariants/NO_ACCRETING_REGISTRIES]] — index files belong to `dome.markdown.render-index` via ordinary `patch.auto`, and `log.md` is frozen). The broker rejects other processors' patches targeting owned paths.
- **A bundle with `external` capability requests** provides or consumes external handlers. `acme.calendar-sync` provides handlers (its `external-handlers/` directory has the handler implementations) AND consumes the capabilities (its processors emit `ExternalActionEffect`).
- **The `dome.markdown` capability `patch.auto: ["**/*.md"]`** is the broadest markdown write grant in the shipped-default set — markdown autoformatting, managed-link repair, source-backed stub creation, and metadata maintenance need to touch managed pages across the vault. The grant is acceptable because the processors only emit source-preserving patches such as frontmatter ordering, high-confidence existing-page wikilink repairs, explicit concept/entity stubs that cite the linking source page, and existing `updated:` refreshes; these never invent unsupported source claims.

## Adding a bundle to the matrix

Adding a new first-party bundle requires:

1. Creating `assets/extensions/<bundle>/` with the contributions named in the cells.
2. Adding a row to this matrix with the bundle's name, status (`shipped`), and per-column filenames.
3. Enabling the bundle in the shipped `dome init` config if it is part of the default v1 vault experience.
4. Keeping `tests/integration/bundle-matrix-lockstep.test.ts` green so the row, manifest, processor files, page types, and capability kinds stay aligned.

A bundle the SDK ships without a row in this matrix is a substrate violation — the matrix coverage test fails CI.

## Why this matrix is closed (in v1)

Seven contribution kinds cover the v1 design (loops and doctor grant-entry probes both joined 2026-06-10 per [[wiki/gotchas/operator-surfaces-enumerate-first-party]]). Adding an eighth kind (e.g., diagnostic rendering hints, the remaining shadow kind) would be a substrate change touching [[wiki/specs/sdk-surface]] §"Extension bundles" — not a matrix-only edit.

## Related

- [[wiki/specs/sdk-surface]] §"Extension bundles" — the bundle mechanism spec
- [[wiki/specs/processors]] — what bundle processors are
- [[wiki/specs/capabilities]] — what bundle capability grants mean
- [[wiki/gotchas/extension-bundle-load-order]] — collision semantics
- [[wiki/invariants/AGENTS_MD_IS_ORIENTATION_SURFACE]] — preamble fragment threading
- [[wiki/matrices/built-in-extensions-x-phase]] — phase × processor map for the same bundles
- [[wiki/matrices/effect-x-capability]] — what each capability tier authorizes
- [[wiki/matrices/projection-table-x-owner]] — which extension owns which projection table
