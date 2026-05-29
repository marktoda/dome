---
type: matrix
created: 2026-05-27
updated: 2026-05-28
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"]
---

# Built-in extensions × phase matrix

The dense map of the nine first-party `dome.*` bundles × the three processor phases × which processors they ship. This is what new bundle authors compare against when registering a processor — "is there already a first-party processor doing this?"

## The matrix

| Bundle | Adoption phase | Garden phase | View phase |
|---|---|---|---|
| **`dome.markdown`** | `validate-wikilinks` (emits `DiagnosticEffect` for unresolved links); `normalize-frontmatter` (emits canonicalizing `PatchEffect`s); `lint-frontmatter` (minimal frontmatter diagnostics); `broken-images` (emits `DiagnosticEffect` for missing local image embeds); `duplicate-detection` (emits `QuestionEffect` for suspected duplicate pages); `stale-dates` (emits `DiagnosticEffect` when `updated:` trails git history) | — | `orphan-pages` (command-triggered view over `dome.graph.links_to` facts) |
| **`dome.graph`** | `links` (emits `dome.graph.links_to` facts from wikilinks); `tag-index` (emits `dome.graph.tagged` facts from frontmatter and inline tags) | — | — |
| **`dome.index`** | `update-index` (emits `PatchEffect` to rewrite `index.md` row for each changed wiki page) | — | — |
| **`dome.log`** | `append-log` (emits `PatchEffect` to append per-adoption summary to `log.md` from the run ledger) | — | — |
| **`dome.links`** | — | `cross-reference` (on `signal:file.created` for `wiki/entities/**`, scans wiki bodies for entity-name mentions, emits `PatchEffect` to add backlinks) | — |
| **`dome.intake`** | `inbox-stale-check` (per-sync; emits `DiagnosticEffect` for files older than `engine.inbox_stale_age_hours`) | `extract-capture` (on `signal:file.created` for `inbox/raw/**`, calls LLM to compile capture into wiki updates; emits `PatchEffect` and `FactEffect`); `process-questions` (on `signal:document.changed` for pages with unanswered questions) | — |
| **`dome.daily`** | — | `create-daily` (cron `0 6 * * *`); `create-weekly` (cron `0 6 * * MON`); `carry-forward` (on `signal:file.created` for `wiki/dailies/**`); `append-followup` (on `signal:document.changed` for `wiki/dailies/**` when a followup line is added) | `today` (command `dome today`); `week-review` (command and cron); `agenda-with` (command `dome query agenda-with <person>`); `prep` (command `dome prep <topic>`) |
| **`dome.lint`** | — | — | `lint-report` (command `dome lint` and cron `0 7 * * MON`); `apply-finding` (command `dome lint --apply <id>`) |
| **`dome.search`** | `index-text` (on `signal:document.changed`, `signal:file.created`, and `signal:file.deleted`, emits SearchDocumentEffect for `fts_documents`) | future: embeddings / refresh jobs | `query` (command `dome query`); future: `export-context` |
| **`dome.migrate`** | — | — | `migrate-vault` (command `dome migrate`) |

## Counts

- **Total processors:** ~25 across the nine bundles.
- **Adoption-phase processors:** 7 (parse, validate-wikilinks, validate-frontmatter, update-index, append-log, inbox-stale-check, index-text, index-embeddings).
- **Garden-phase processors:** 8 (cross-reference, extract-capture, process-questions, create-daily, create-weekly, carry-forward, append-followup, refresh-embeddings).
- **View-phase processors:** ~10 planned (today, week-review, agenda-with, prep, lint-report, apply-finding, query, export-context, migrate-vault, + cli adapter for the same).

The matrix is the source of truth for "what runs when." A new first-party processor authored as part of v1.x lands here as a new cell; a third-party bundle adds rows.

## Why this is rich (not minimal)

A new bundle author looking at this matrix sees:

- **Adoption-phase is sparse.** Most of the action is in garden + view. The author can register an adoption-phase processor only when they need merge-time validation (rare).
- **Schedule-driven processors are explicit.** Each cron-driven processor's schedule is visible — the author can avoid overlapping with existing schedules.
- **View processors are dominantly LLM-driven in the future plan.** `today`, `week-review`, `agenda-with`, `prep`, `lint-report`, `export-context` — most use `model.invoke`. The shipped `dome.search.query` path is deterministic FTS first.

## Adding to the matrix

Adding a first-party processor:

1. Write the processor file in `assets/extensions/<bundle>/processors/<name>.ts`.
2. Declare it in `<bundle>/manifest.yaml`'s `processors:` block.
3. Add a cell to this matrix.
4. Add a test at `tests/processors/<bundle>-<name>.test.ts`.

The structural fence: `tests/integration/built-in-extensions-coverage.test.ts` iterates this matrix and asserts every named processor exists at the declared bundle path. Drift between the matrix and the shipped bundles fails CI.

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
