# Dome v1.x Roadmap

This document captures the roadmap from "v1.0 shipped (engine + one diagnostic-only processor)" through to "Dome is materially useful as a daily second-brain tool." Each phase delivers a coherent user-facing improvement, not just infrastructure.

**Status:** v1.0 + Phase 11 (commit-watcher daemon, init polish, `dome.markdown.validate-wikilinks`) + Phase 12 (applyPatch substrate + `dome.markdown.normalize-frontmatter`) + Phase 13a (TIER 0 pack: `dome.markdown.lint-frontmatter` + `dome.graph.links` + `dome.markdown.orphan-pages` + `dome run` CLI + `ctx.projection` query surface) + Phase 13b partial (`dome.graph.tag-index`) are merged to `main`.

## Capability dependency graph

Most useful processors require one of three substrate landings. The tiers below order processors by **substrate cost** so the roadmap is a clean buildup.

```
TIER 0 — diagnostic-only (no new substrate)
  ↓
TIER 1 — needs applyPatch (DONE in Phase 12)
  ↓
TIER 2 — needs modelInvoke (LLM cost tracking, budget enforcement)
  ↓
TIER 3 — needs scheduled-trigger dispatch (cron events)
```

## TIER 0 — Useful immediately (no new substrate)

These emit diagnostics/facts/questions only. `dome inspect <subject>` surfaces what they found.

### Phase 13a (shipped) — diagnostic + fact + view processor pack

| Processor | What it does | Why it's high-value |
|---|---|---|
| ✅ `dome.markdown.lint-frontmatter` | Validates the minimal core schema: presence of frontmatter, presence of `type:`, well-formed `created:` / `updated:` dates, well-formed `tags:`, parseable YAML. Five diagnostic codes. | Cheapest path to "the vault stays well-formed." Per-page-type schema validation (e.g., `type: task` requires `dueDate`) deferred to Phase 13c when the page-types substrate lands. |
| ✅ `dome.graph.links` | Scans `*.md` for `[[wikilink]]` references. Emits `FactEffect(subject: page, predicate: "dome.graph.links_to", object: <target>)`. First fact-emitting processor; first `graph.write` capability declaration; namespace `dome.graph.*`. | Foundation for the link graph — incoming-link analysis, dead-link detection, reverse-link views. |
| ✅ `dome.markdown.orphan-pages` | View-phase, command-triggered (`dome run orphan-pages`). Reads `links_to` facts, computes incoming-link counts, emits one `ViewEffect` listing every page with zero incoming AND not implicitly linked from a root-index page. | The "lost notes" problem — files you wrote and then forgot to link from anywhere. |

Substrate added: `ctx.projection` query view on `ProcessorContext`; `dome run <name>` CLI command for command-triggered view-phase processors.

### Phase 13b (in progress) — remaining TIER 0 processors

| Processor | What it does | Why it's high-value |
|---|---|---|
| ✅ `dome.graph.tag-index` | Parses frontmatter `tags: [...]` and inline `#tag` syntax. Emits `FactEffect(subject: page, predicate: "dome.graph.tagged", object: tag)`. | Foundation for tag-based recall. |
| `dome.markdown.stale-dates` | Reads frontmatter `updated:` and compares to the file's commit date. If they disagree by more than N days, emit a diagnostic. | Catches the "I forgot to bump the date" hygiene issue. |
| `dome.markdown.duplicate-detection` | Compares page titles + first paragraphs across the vault. Flags suspected duplicates with `QuestionEffect`. First Question-emitting processor. | Detects accidental fragmenting of an entity into two pages. |
| `dome.markdown.broken-images` | Scans for `![](path)` references; emits diagnostic when the image isn't in the vault. | Sibling of the wikilink validator; same shape. |

### Phase 13c (planned) — per-page-type schemas

Restores a v0.5-era concept retired in Phase 7b: `.dome/page-types.yaml` (or successor substrate) declaring per-type schemas, then `dome.markdown.lint-frontmatter` extends to validate against the declared schema for each page's declared `type:`. Requires page-types substrate to land first.

**Estimated effort:** each remaining processor is ~150-300 LOC + tests. ~1 day per processor.

## TIER 1 — Needs `applyPatch` (✅ substrate landed in Phase 12)

| Processor | What it does | Patches it emits |
|---|---|---|
| ✅ `dome.markdown.normalize-frontmatter` | Reformats YAML: canonical key order, normalized tag-list shape. | Emits PatchEffect{mode:"auto"} per file that would change. **Done in Phase 12b.** |
| `dome.markdown.resolve-wikilinks` | For each broken wikilink, look for a near-match in the basename index. If exactly one fuzzy candidate exists, emit `PatchEffect(mode: "propose")` rewriting `[[danny]]` → `[[entities/danny]]`. | Mode "propose" lands as a side branch the user reviews. |
| `dome.index.maintain` | For each canonical root (`wiki/`, `notes/`), maintains an `index.md` that lists all files in that root, grouped by page-type. Emits `PatchEffect(mode: "auto", patch: <regenerated index.md>)`. | The v0.5 `auto-update-index` reincarnated as a processor. |
| `dome.log.append` | Maintains the `log.md` chronological activity file. Each commit produces one new log entry. | v0.5's logging behavior. |
| `dome.markdown.unstable-ids` | For pages whose frontmatter lacks `id:`, generates one from the path + a UUID and emits a patch to add it. | Stable identity layer — important for the FactEffect system to work consistently. |
| `dome.markdown.format` | Real markdown reformatter (existing `dome.lint.markdown-format` is a stub). Tables aligned, list indentation consistent, trailing whitespace stripped. | Highest-volume patcher; needs idempotency review. |

**Estimated effort:** each is ~200-400 LOC. ~1-2 weeks for the remaining five.

## TIER 2 — Needs `modelInvoke`

Bigger lift — requires building a cost-tracking wrapper, per-bundle budget enforcement, retry/idempotency for stochastic outputs. But these are where Dome stops being "a clever filing system" and becomes "actually useful."

| Processor | What it does | Cost profile |
|---|---|---|
| `dome.intake.extract-capture` | When a file lands in `raw/voice/` or `inbox/captures/`, LLM-extracts: candidate entities mentioned, candidate tasks, candidate decisions, source-of-truth quotes. Emits `FactEffect`s + `PatchEffect` to file the capture under `wiki/sources/<id>.md`. | Per-capture; bounded by user input rate. ~1k-5k tokens per capture. |
| `dome.people.infer-relations` | Garden-phase. On schedule (e.g., nightly), reads `wiki/entities/*.md`, extracts relationship facts ("Danny reports to Crishna", "Crishna leads Data Platform"). Emits `FactEffect`s. | Periodic; budget-capped. |
| `dome.daily.morning-brief` | Scheduled (cron 7am). Reads recent activity, calendar facts (if available), open tasks. Emits a `PatchEffect` writing the daily-note's "morning brief" generated region. | Once per day per vault. |
| `dome.lint.semantic-review` | View-phase, command-triggered (`dome lint`). LLM reads a changed file and flags semantic issues a regex can't catch ("This paragraph contradicts the claim on line 12", "This entity is referenced but not defined"). | On-demand. Bigger token budgets. |
| `dome.synthesis.entity-summary` | Garden-phase. For each entity with N+ source mentions, generates a 1-paragraph summary that lives in an owned region of the entity's page. Refreshes when sources change. | Bounded by entity count × refresh frequency. |
| `dome.query.evidence-backed-answer` | View-phase. User asks `dome query "what did I decide about X"`. Processor retrieves relevant pages, LLM synthesizes a citation-grounded answer with `SourceRef`s. | On-demand. |

**Estimated effort:** `modelInvoke` substrate is ~2-3 days. Then each processor is ~300-500 LOC. ~3-4 weeks total.

## TIER 3 — Needs scheduled-trigger dispatch

Currently the daemon only fires processors on commit. The spec describes `schedule` triggers (cron-style) that fire on time, not commit. Garden-phase processors with `schedule:` triggers (e.g., `dome.daily.morning-brief` at 7am) require this.

**Building it:** ~1 day. The runtime walks the registry for `schedule:` triggers at daemon start, registers them with setInterval/setTimeout machinery, and fires them at the right time. The ledger gets a `schedule_cursors` table (already in the schema).

## Recommended sequencing

Each phase delivers a coherent user-facing improvement.

### Phase 12c — Bug fix: advance `main` alongside adopted ref *(~½ day)*

**Surfaced by Phase 12 live-test.** `applyPatch` creates floating closure commits and advances only `refs/dome/adopted/main`. Per v1.md §4.1, the closure commit should also be added to `main`. Without this, the daemon enters a hard error loop after the first patch-emitting adoption: subsequent cycles can't fast-forward the adopted ref against new floating commits that are siblings of the existing closure.

**Fix:** in `adopt.ts`'s closure step, when `candidate !== proposal.head` (a closure landed), advance `main` to `candidate` before advancing `refs/dome/adopted/main`. Single-client mode makes this safe — no concurrent writer.

### Phase 13a (shipped) — TIER 0 starter: lint + graph + orphan-pages *(~1 week)*

Three processors shipped:
- `dome.markdown.lint-frontmatter` (adoption-phase, diagnostic-only)
- `dome.graph.links` (adoption-phase, FactEffect-emitting; first `graph.write` capability)
- `dome.markdown.orphan-pages` (view-phase, command-triggered via `dome run orphan-pages`)

Substrate added:
- `ProcessorContext.projection` — read-only `ProjectionQueryView` (facts / diagnostics / questions). Adoption-phase contexts get an undefined slot; view-phase contexts get a live handle.
- `dome run <name>` CLI command — the dispatch path for command-triggered view-phase processors. Each new `dome run <name>` is realized by adding a view-phase processor whose command trigger declares `name`.
- `Harness.runCli(args)` test helper — in-process CLI invocation for scenario tests.

### Phase 13b (planned) — remaining TIER 0 *(~1 week)*

`dome.markdown.stale-dates`, `dome.markdown.duplicate-detection`, `dome.markdown.broken-images`.

### Phase 13c (planned) — per-page-type schemas *(~1 week)*

`.dome/page-types.yaml` substrate (or successor) + `dome.markdown.lint-frontmatter` extension to validate per-type fields. Requires the page-types substrate to land first.

### Phase 14 — Diagnostic auto-resolve + processor versioning + `dome rebuild` *(~1 week)*

Three loosely-coupled UX improvements:

1. **Diagnostic auto-resolve.** When a processor re-runs against the same proposal and *doesn't* re-emit a diagnostic, mark prior matching rows resolved. Currently diagnostics accumulate forever even after the underlying issue is fixed.

2. **Processor-version invalidation.** Wire the existing `cache-keys-changed` signal: bumping a processor's version → its rows clear → next sync re-emits them. Today the signal fires but nothing acts on it.

3. **`dome rebuild` command.** Force-re-emit all processor work against the current adopted state. Replaces the `git update-ref refs/dome/adopted/main HEAD~10` workaround.

**Outcome:** `dome doctor --show diagnostics` shows only current issues. Bumping a processor's behavior is a clean operation.

### Phase 15 — `dome.log` + `dome.index` + closure-commit polish *(~1 week)*

Reincarnate the v0.5 `auto-update-index` and `auto-cross-reference` behavior as v1 processors. Now log/index get maintained automatically as engine closure commits.

**Outcome:** the user gets the v0.5 ergonomics back, structurally cleaner.

### Phase 16 — `modelInvoke` substrate *(~3 days)*

- LLM-call wrapper with token + cost tracking → `runs.cost_usd`.
- Per-bundle daily budget enforcement.
- Retry + idempotency-key for stochastic outputs.

**Outcome:** infrastructure for LLM processors lands.

### Phase 17 — `dome.intake.extract-capture` + first synthesis *(~2 weeks)*

The flagship use case: voice/text captures land in `inbox/`, the processor extracts entities/tasks/decisions, files things under `wiki/sources/`, emits facts.

Plus `dome.synthesis.entity-summary` for cross-page synthesis.

**Outcome:** "drop a capture in and it gets digested" — the actual v1 vision.

### Phase 18 — `dome query` + scheduled processors *(~1 week)*

- Build the `dome query` CLI command that hits the projection's fact store + FTS.
- Add scheduled-trigger dispatch so `dome.daily.morning-brief` can fire on cron.

**Outcome:** "ask the system what it knows" plus daily routines.

## Total roadmap

~7-9 weeks of focused work gets Dome from "infrastructure with two markdown processors" to "useful daily second-brain tool with intake + queries + auto-maintenance." Each phase ships value on its own — you could stop after Phase 15 and have a markedly better tool than v0.5 was.

## Open v1.x polish items (not roadmap phases)

These are smaller items worth fixing but don't merit their own phase. Bundle into polish PRs as discovered.

- **`gray-matter` date coercion.** Unquoted ISO dates like `created: 2026-05-27` parse to JS `Date` objects, which re-serialize to full ISO format (`2026-05-27T00:00:00.000Z`). This makes the first sync of any file with unquoted dates emit a normalize-frontmatter patch. Cosmetic; users can quote dates as strings to avoid.
- **`--exclusive` flag on `dome serve`.** PID-file the daemon so a second invocation refuses if another instance is running. Prevents the "zombie from MCP spawn" issue.
- **`dome doctor --show diagnostics` filter by `adopted_commit`.** Default filter to "current state only" so the view doesn't drown in historical entries.
- **Per-processor `--verbose` granularity.** `dome serve --verbose --filter-processor dome.markdown.*` would only print events from matching processors.
- **`dome status --json`** improvements: per-processor recent-run summary.
- **Foreign-key enforcement on `capability_uses.run_id REFERENCES runs(id)`.** SQLite has `PRAGMA foreign_keys=ON` opt-in; we should enable it.
- **Substrate-as-tests for shipped bundles.** The validate-wikilinks tests + normalize-frontmatter tests are processor-unit-only; no test asserts they're loaded by `loadBundles` with the canonical capabilities. Worth a lockstep test.

## Where to start

If you only have time for one phase, **Phase 12c is the most urgent** — without it, `applyPatch` enters an error loop in production. After that, **Phase 13 + Phase 14** together (~2 weeks) deliver the biggest UX win: a real `dome doctor`, current-state diagnostic views, and `dome rebuild`. Then Phase 15 brings back the v0.5 auto-maintenance ergonomics on the v1 substrate.

The LLM phases (16, 17) are where the system's value compounds — but they need the substrate beneath to be solid first.
