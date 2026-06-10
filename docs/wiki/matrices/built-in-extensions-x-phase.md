---
type: matrix
created: 2026-05-27
updated: 2026-06-09
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
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
| **`dome.markdown`** | shipped | `validate-wikilinks`; `normalize-frontmatter`; `lint-frontmatter`; `page-status` (supersession facts); `lint-supersession`; `broken-images`; `duplicate-detection`; `stale-dates`; `raw-immutable`; `core-size` (core-memory size budget) | `ambiguous-wikilink-answer`; `repair-wikilinks` (cron `5 5 * * *`); `simplify-indexes` (cron `10 5 * * *`); `duplicate-detection-answer`; `refresh-updated` (cron `0 5 * * *`) | `orphan-pages` |
| **`dome.graph`** | shipped | `links`; `tag-index` | — | — |
| **`dome.health`** | shipped | — | `outbox-recovery-questions`; `outbox-recovery-answer`; `quarantine-recovery-questions`; `quarantine-recovery-answer`; `orphan-run-recovery-questions`; `orphan-run-recovery-answer` | — |
| **`dome.claims`** | shipped | shipped: `index` | shipped: `stamp` (claim-line anchor identity) | — |
| **`dome.daily`** | shipped | shipped: `task-index` | shipped: `stamp-block-id` (block-anchor identity), `reconcile-tasks` (close-in-place propagation), `normalize-task-syntax` (task syntax hygiene), `create-daily` (cron `0 6 * * *`), `carry-forward` (daily open-loop surface), `attention-discount` (dismissal-derived discount facts, deterministic/rebuild-eligible), `ambiguous-followup-answer`; planned: `create-weekly`, `append-followup` | shipped: `agenda-with`, `prep`, `today`; planned: `week-review` |
| **`dome.lint`** | shipped | — | — | shipped: `report`; planned: `apply-finding` |
| **`dome.warden`** | shipped | — | `integrity` (signal `document.changed` on `wiki/**/*.md`), `integrity-answer` (answer trigger) | — |
| **`dome.search`** | shipped | shipped: `index-text`; planned: embeddings / refresh jobs | — | shipped: `query`, `export-context` |
| **`dome.index`** | planned | `update-index` | — | — |
| **`dome.log`** | planned | `append-log` | — | — |
| **`dome.links`** | planned | — | `cross-reference` | — |
| **`dome.agent`** | shipped | — | shipped: `ingest` (model-driven raw-capture agent loop), `inbox-stale-check` (cron `0 * * * *`), `consolidate` (cron `0 2 * * *`, nightly recent-drift janitor), `sweep` (cron `0 3 * * *`, nightly meaning integration), `sweep-answer` (answer-triggered), `brief` (cron `30 5 * * *`, morning-brief composer), `preference-signals` (deterministic/rebuild-eligible preference counter facts), `preference-promotion` (deterministic owner-needed promotion questions), `preference-promotion-answer` (answer trigger; core.md's single auto-writer) | — |
| **`dome.migrate`** | planned | — | — | `migrate-vault` |

## Counts

- **Shipped processors:** active processor modules across `dome.claims`, `dome.markdown`, `dome.graph`, `dome.health`, `dome.daily`, `dome.lint`, `dome.search`, `dome.warden`, and `dome.agent`.
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

## Why not collapse `dome.markdown` and `dome.index` into one bundle

`dome.markdown` parses + validates; `dome.index` maintains `index.md`. They're separated because:
- `dome.markdown` is the shipped-default validator. Disabling it means accepting unstructured markdown — a user choice.
- `dome.index` is the index maintainer. Disabling it means `index.md` won't update — a different user choice.
- Combining them would force a single on/off; the separation keeps each as an independent capability the user grants or revokes.

Same reasoning for `dome.log` (log maintenance), `dome.links` (cross-referencing), `dome.search` (search + embeddings). Each is a coherent unit of behavior the user can enable or disable independently.

## Related

- [[wiki/specs/processors]] §"First-party processors"
- [[wiki/matrices/extension-bundle-shape]] — per-bundle file map
- [[wiki/matrices/processor-phase-x-trigger]] — phase × trigger compatibility
- [[wiki/matrices/effect-router-targets]] — per-effect routing
- [[wiki/matrices/intent-prompt-processors]] — user intents → processors
