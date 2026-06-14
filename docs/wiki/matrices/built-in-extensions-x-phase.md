---
type: matrix
created: 2026-05-27
updated: 2026-06-13
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
description: Crosses first-party dome.* bundles with adoption/garden/view phases — source of truth for which processor runs when, and on what cron.
---

# Built-in extensions × phase matrix

The dense map of first-party `dome.*` bundles × the three processor phases.
Rows marked `shipped` are present in `assets/extensions/` and lockstep-tested
against their manifests. Cells may also name `planned` processors as explicit
future pressure; those entries are non-normative until promoted to shipped
assets with harness coverage. Rows marked `planned` are not shipped assets.

## The matrix

| Bundle | Status | Adoption phase | Garden phase | View phase |
|---|---|---|---|---|
| **`dome.markdown`** | shipped | `validate-wikilinks`; `normalize-frontmatter`; `lint-frontmatter`; `page-status` (supersession facts); `lint-supersession`; `broken-images`; `duplicate-detection`; `stale-dates`; `raw-immutable`; `core-size` (core-memory size budget) | `ambiguous-wikilink-answer`; `repair-wikilinks` (cron `5 5 * * *`); `render-index` (cron `15 5 * * *`, index-catalog render from `description:` frontmatter); `duplicate-detection-answer`; `refresh-updated` (cron `0 5 * * *`) | `orphan-pages` |
| **`dome.graph`** | shipped | `links`; `tag-index` | — | — |
| **`dome.health`** | shipped | — | `outbox-recovery-questions`; `outbox-recovery-answer`; `quarantine-recovery-questions`; `quarantine-recovery-answer`; `orphan-run-recovery-questions`; `orphan-run-recovery-answer` | — |
| **`dome.claims`** | shipped | shipped: `index` | shipped: `stamp` (claim-line anchor identity) | — |
| **`dome.daily`** | shipped | shipped: `task-index` | shipped: `stamp-block-id` (block-anchor identity), `reconcile-tasks` (close-in-place propagation), `normalize-task-syntax` (task syntax hygiene), `create-daily` (cron `0 6 * * *`), `carry-forward` (daily open-loop surface), `close-scaffold` (cron `30 21 * * *`, evening close scaffold — schedule-only by design), `attention-discount` (dismissal-derived discount facts, deterministic/rebuild-eligible), `ambiguous-followup-answer`; planned: `create-weekly`, `append-followup` | shipped: `agenda-with`, `prep`, `today`; planned: `week-review` |
| **`dome.lint`** | shipped | — | — | shipped: `report`; planned: `apply-finding` |
| **`dome.warden`** | shipped | — | `integrity` (signal `document.changed` on `wiki/**/*.md`), `integrity-answer` (answer trigger) | — |
| **`dome.search`** | shipped | shipped: `index-text`; planned: embeddings / refresh jobs | — | shipped: `query`, `export-context` |
| **`dome.sources`** | shipped | — | `fetch` (cron `*/15 * * * *`, subscription scheduler for committed external feeds — [[wiki/specs/sources]]; cheap no-op when no subscription is due) | — |
| **`dome.links`** | planned | — | `cross-reference` | — |
| **`dome.agent`** | shipped | — | shipped: `ingest` (model-driven raw-capture agent loop), `inbox-stale-check` (cron `0 * * * *`), `consolidate` (cron `0 2 * * *`, nightly recent-drift janitor), `sweep` (cron `0 3 * * *`, nightly meaning integration), `sweep-answer` (answer-triggered), `brief` (cron `30 5 * * *`, morning-brief composer), `preference-signals` (deterministic/rebuild-eligible preference counter facts), `preference-promotion` (deterministic owner-needed promotion questions), `preference-promotion-answer` (answer trigger; gated core.md writer — owns the promoted-preferences block), `active-projects` (cron `20 5 * * *` + daily-change signal; deterministic gated core.md writer — owns the active-projects block) | — |
| **`dome.migrate`** | planned | — | — | `migrate-vault` |

## Counts

- **Shipped processors:** active processor modules across `dome.claims`, `dome.markdown`, `dome.graph`, `dome.health`, `dome.daily`, `dome.lint`, `dome.search`, `dome.sources`, `dome.warden`, and `dome.agent`.
- **Planned processors:** listed as `planned` above; they are future pressure inside otherwise shipped bundles and do not count as shipped until assets and harness coverage land.

The matrix is the source of truth for "what runs when." A new first-party processor authored as part of v1.x lands here as a new cell; a third-party bundle adds rows.

## Why this is rich (not minimal)

A new bundle author looking at this matrix sees:

- **Adoption-phase is sparse.** Most of the action is in garden + view. The author can register an adoption-phase processor only when they need merge-time validation (rare).
- **Schedule-driven processors are explicit.** Each cron-driven processor's schedule is visible — the author can avoid overlapping with existing schedules.
- **View processors are dominantly LLM-driven in the future plan.** `week-review` uses `model.invoke`. The shipped `dome.search.query`, `dome.search.export-context`, `dome.lint.report`, `dome.daily.agenda-with`, `dome.daily.today`, and `dome.daily.prep` paths are deterministic first.

## Adding to the matrix

Adding a first-party processor:

1. Write the processor file in `assets/extensions/<bundle>/processors/<name>.ts`.
2. Declare it in `<bundle>/manifest.yaml`'s `processors:` block.
3. Add a cell to this matrix.
4. Add a test at `tests/processors/<bundle>-<name>.test.ts`.

Lockstep coverage: `tests/integration/bundle-matrix-lockstep.test.ts` parses this matrix and asserts every active shipped processor listed here matches the corresponding first-party bundle manifest. Planned entries are documentation-of-intent until promoted to shipped status with assets and tests.

## Retired: `dome.index` and `dome.log`

The previously planned `dome.index` (index maintainer) and `dome.log` (run-ledger → `log.md` projection) bundles are **retired** per [[wiki/invariants/NO_ACCRETING_REGISTRIES]] (2026-06-11). The index files are generated renders compiled by `dome.markdown.render-index` from per-page `description:` frontmatter, and the activity log is git history — engine commit bodies carry the patch narrative, surfaced by `dome log` ([[wiki/specs/cli]] §"`dome log`"). `log.md` is frozen.

The bundle-granularity reasoning still holds for the remaining planned bundles — `dome.links` (cross-referencing), `dome.search` (search + embeddings) each stay a coherent unit of behavior the user can enable or disable independently.

## Related

- [[wiki/specs/processors]] §"First-party processors"
- [[wiki/matrices/extension-bundle-shape]] — per-bundle file map
- [[wiki/matrices/processor-phase-x-trigger]] — phase × trigger compatibility
- [[wiki/matrices/effect-router-targets]] — per-effect routing
- [[wiki/matrices/intent-prompt-processors]] — user intents → processors
