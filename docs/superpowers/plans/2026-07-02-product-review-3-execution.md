# Product Review Round 3 — Execution Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute the 2026-07-02 product-review recommendations: build the approved pruning pass (+ ledger retention), close the settlement loop (`task.settle`), ship the weekly report card, instrument the recall loop, add the coverage-based gardening patrol, harden the second-user kit, and fix the observed ops defects.

**Architecture:** All work follows the sealed four-concept core (Vault/Proposal/Processor/Effect). No new primitives. New owner-facing writes are either garden PatchEffects (report card, patrol) or human-authored commits through the capture-style commit-or-nothing seam (settle, miss log). Store-change signals extend the shipped `questions.changed` pattern. Every retirement follows the doc-sweep rule (normative wiki pages rewritten in place; historical brainstorms untouched).

**Tech Stack:** Bun + TypeScript, Bun.sqlite, isomorphic-git, Commander CLI, MCP SDK (adapter only), React/Vite (PWA).

## Global Constraints

Copied from repo law (AGENTS.md, docs/philosophy.md, invariant docs). Every task's requirements implicitly include these:

- **Spec-first**: every behavior change updates the owning `docs/wiki/specs/*.md` (and matrices) in the same task, rewriting stale prose in place (never appending "update:" notes). Historical docs under `docs/cohesive/brainstorms/` are never edited.
- **Effects are the only processor output**; the engine is the only applier; every effect is capability-checked. No processor imports `node:fs`, `bun:sqlite`, or isomorphic-git write functions (processor-purity linter).
- **AC3 lockstep**: shipped named invariants in `docs/wiki/invariants/*.md` require `tests/invariants/<slug>.test.ts` (see `tests/integration/invariant-coverage.test.ts`). Retiring an invariant retires its test; adding one adds its test.
- **`@dome/sdk` core has no LLM or MCP dependency** (`tests/integration/bundle-deps.test.ts`).
- **The generated-block grammar (`src/core/generated-block.ts`) is untouched.** New generated blocks reuse the existing primitive and register in `DAILY_GENERATED_BLOCKS` (`assets/extensions/dome.daily/processors/daily-types.ts`) when they live in dailies, plus the search-index strip list when they are projections of state owned elsewhere.
- **Signal vocabulary is a closed union**: new signal kinds extend `Signal` in `src/core/processor.ts` + the manifest zod enum + the dispatch chokepoints, exactly as `questions.changed` did (`src/engine/operational/questions-changed.ts` is the precedent to mirror).
- **Engine import direction**: `src/engine/` modules import only same- or lower-ranked layers (core < garden < operational < host); `tests/integration/engine-import-direction.test.ts` enforces.
- **Markdown is source of truth; projections rebuildable**; durable operational state (`answers.db`, `runs.db`, `outbox.db`, quarantine) is preserved unless intentionally discarded.
- **Test gating**: `bunx tsc --noEmit` (or the repo's typecheck script if one exists in package.json) + scoped `bun test <paths>` for the touched areas. Do NOT run the full `bun test ./tests` suite inside a task — it is flaky under parallel load; the controller runs broad gates at phase boundaries.
- **Commits**: conventional-commit style matching recent history (`feat(dome.daily): …`, `fix(engine): …`, `docs(specs): …`), one coherent commit per step group, ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **File-name verification**: file paths below are directory-and-symbol precise but an implementer MUST verify exact basenames with Glob/Grep before editing (e.g. the attention-discount processor file). If a named file does not exist under the stated directory, find the file owning the named symbol; do not create a duplicate.
- The approved pruning design is `docs/cohesive/brainstorms/2026-07-02-pruning-pass-design.md` (in this branch). Where this plan and that doc disagree, THIS PLAN governs (it post-dates the design).

---

## Phase A — the pruning pass

### Task 1: Delete JobEffect and dead daily vocabulary

**Files:**
- Modify: `src/core/effect.ts` (or wherever the `Effect` union + `JobEffect` type live — Grep `JobEffect`), `src/core/processor.ts` (drop the `job` trigger kind), zod schemas for manifests/effects, `src/engine/core/apply-effect.ts` (routing arm), `src/engine/core/capability-policy.ts` (`job.enqueue`), `src/engine/operational/jobs.ts` (delete), `src/projections/` `scheduled_jobs` table DDL + any accessors, `src/engine/operational/scheduler.ts` if it consults jobs.
- Modify: `assets/extensions/dome.daily/processors/` — delete the retired render helpers `carriedForwardSection` / `replaceCarriedForwardSection` (Grep for them; keep marker-recognition entries).
- Modify specs: `docs/wiki/specs/effects.md` (eleven kinds → ten; rewrite the taxonomy count everywhere it appears — check `docs/wiki/gotchas/substrate-count-drift.md` for the canonical-const pattern), `docs/wiki/specs/processors.md` (trigger table), `docs/wiki/specs/capabilities.md` (tier count if `job.enqueue` counted), `docs/wiki/matrices/effect-router-targets.md`, `docs/wiki/matrices/effect-x-capability.md`, `docs/wiki/matrices/processor-phase-x-trigger.md`, `docs/wiki/specs/projection-store.md` (scheduled_jobs table), `docs/index.md` line for effects spec ("eleven-kind" → "ten-kind").
- Modify: `src/cli/commands/init-templates.ts` and `docs/` anywhere implying `log.md` still updates (Grep `log.md` in src/ and docs/wiki/ — retire stale references only; no vault file moves).
- Test: update `tests/core/processor.test.ts`, effect-schema lockstep tests, capability-count tests, delete `tests/**/jobs*` tests. Grep `job.enqueue`, `JobEffect`, `scheduled_jobs` across tests.

**Interfaces:**
- Produces: `Effect` union without `JobEffect`; trigger vocabulary without `job`. Later tasks assume ten effect kinds.

**Steps:**
- [ ] Grep the full symbol inventory (`JobEffect`, `job.enqueue`, `scheduled_jobs`, `jobs.ts`, `carriedForwardSection`, `replaceCarriedForwardSection`) and enumerate every reference.
- [ ] Delete code + table + routing + capability + trigger kind; shrink type unions and exhaustive switches; delete/update the tests named above; run scoped tests (`bun test tests/core tests/engine/apply-effect.test.ts tests/engine/capability-broker.test.ts tests/processors/triggers.test.ts` plus any schema-lockstep tests found).
- [ ] Rewrite the spec/matrix pages in place (counts, tables, routing rows). Verify with Grep that no normative doc still names `JobEffect`/`job.enqueue` (historical brainstorms exempt). Add both names to the retired-names list in `docs/wiki/linters/no-retired-symbol-names.md` if that linter has a mechanical test — Grep `no-retired-symbol` in tests/ to check.
- [ ] Typecheck + scoped tests green; commit (`refactor(core)!: retire JobEffect + job trigger — zero users` and `docs(specs): ten-kind effect taxonomy`).

### Task 2: Health trio moves to store-change signals

**Files:**
- Modify: `src/core/processor.ts` (Signal union += `outbox.changed`, `quarantine.changed`), manifest zod enum, `src/engine/operational/questions-changed.ts`-equivalent dispatch plumbing (create `src/engine/operational/store-changed.ts` or extend the existing dispatch channel — mirror the questions-changed tick-scoped flag + once-per-tick epilogue pattern from commits `f6cc3cb`/`193a4c3`/`453a4f5`).
- Modify: `src/outbox/dispatch.ts` — fire the changed-callback from BOTH terminal-failure sites: `recordFailedAttempt`'s terminal branch AND `recoverExpiredDispatching`'s terminal branch (the drain-boundary result array misses lease-expiry failures; the design doc §4 verified these as the complete set).
- Modify: quarantine store (`src/processors/execution-state.ts`) — fire at the threshold-trip in `recordRetryableTerminalFailure` and at `clearQuarantine`/`clearQuarantineIfCurrent` (precise set-changed semantics, NOT the broader every-counter-tick persist hook).
- Modify: `assets/extensions/dome.health/manifest.yaml` — `outbox-recovery-questions` subscribes `outbox.changed` (cron dropped); `quarantine-recovery-questions` subscribes `quarantine.changed` (cron dropped); `orphan-run-recovery-questions` keeps cron, demoted `* * * * *` → `0 * * * *`.
- Specs: `docs/wiki/specs/processors.md` + `docs/wiki/specs/processor-execution.md` (signal kinds + synthesis sites), `docs/wiki/matrices/processor-phase-x-trigger.md`, health bundle rows in `docs/wiki/matrices/built-in-extensions-x-phase.md`. The sources-fetch 15-minute poll is explicitly retained (design §4) — do not touch it.
- Test: mirror `tests/engine/questions-changed.test.ts` shape → `tests/engine/store-changed.test.ts` (terminal outbox failure fires exactly one coalesced signal per tick; quarantine trip fires; clear fires; counter-tick does NOT fire); update `tests/harness/scenarios/` health scenario if one pins the cron; manifest trigger tests.

**Interfaces:**
- Consumes: Task 1's shrunk trigger vocabulary.
- Produces: `Signal` kinds `outbox.changed` / `quarantine.changed` available to any manifest.

**Steps:**
- [ ] Write failing tests for the two new signal kinds and their firing sites (copy the structure of `tests/engine/questions-changed.test.ts`).
- [ ] Implement union + zod + dispatch plumbing + the four firing sites; flip the health manifests.
- [ ] Rewrite specs/matrices in place. Typecheck + scoped tests (`bun test tests/engine tests/processors/triggers.test.ts tests/harness/scenarios/triggers`).
- [ ] Commit (`feat(engine): outbox.changed + quarantine.changed store signals; health trio drops per-minute crons`).

### Task 3: Warden folds into consolidate; dome.warden retires

**Files:**
- Modify: `assets/extensions/dome.agent/lib/consolidate-charter.ts` (Grep for the consolidate charter file) — graft the integrity-finding taxonomy (historical-as-ongoing / contradiction / self-corroborating / inference-as-fact, noisy-class suppression, confidence floor) as a charter section, sourced from `assets/extensions/dome.warden/processors/integrity.ts`'s prompt before deleting it.
- Modify: consolidate's tool seam (Grep `askOwner` under `assets/extensions/dome.agent/`) — add a `flagIntegrity` tool that deterministically emits `info`/`warning` DiagnosticEffects (self-clearing via `resolveStaleDiagnostics`; never questions, never facts, never auto-patches).
- Modify: `assets/extensions/dome.claims/processors/` claim-index processor — same-page claim-key collision emits a deterministic diagnostic (adoption-phase; it already parses every claim line; NO projection read). The warden's projection-read pre-filter does NOT graft (design §1 scout finding: it was dead code — `ctx.projection?.facts` in garden phase).
- Delete: `assets/extensions/dome.warden/` entirely; the warden stanza in `src/cli/default-vault-config.ts`; warden rows in `docs/wiki/matrices/built-in-extensions-x-phase.md` + `docs/wiki/matrices/extension-bundle-shape.md`; warden sections of `docs/wiki/specs/autonomous-agents.md` (consolidate §gains the integrity clause); Grep `dome.warden` across src/, assets/, docs/wiki/, tests/.
- Test: charter assertions move into `tests/extensions/dome.agent/charters.test.ts`; `flagIntegrity` tool emission test (structured finding → DiagnosticEffect with expected code/severity); claim-collision test in `tests/processors/claims-grammar.test.ts` or the claims processor test file; delete `tests/extensions/warden-integrity.test.ts`; update `tests/integration/default-vault-config.test.ts` and the agent-prompt-regression snapshot (`tests/harness/scenarios/.../agent-prompt-regression.test.ts.snap`) — snapshot changes here are expected and must be reviewed, not blindly accepted: the new charter section must appear, nothing else moves.

**Interfaces:**
- Produces: consolidate charter with integrity section + `flagIntegrity` tool; `dome.warden` no longer exists anywhere (Task 19's default-config work assumes this).

**Steps:**
- [ ] Write failing tests: charter contains the integrity taxonomy section; `flagIntegrity` maps a finding to a DiagnosticEffect; claim-index emits `claims.key-collision` diagnostic for a same-page duplicate key.
- [ ] Graft charter + tool; add collision detection; delete the bundle + config stanza + tests; sweep docs.
- [ ] Typecheck + scoped tests (`bun test tests/extensions/dome.agent tests/processors tests/integration/default-vault-config.test.ts`). Verify Grep-clean for `dome.warden` outside historical docs.
- [ ] Commit (`feat(dome.agent): consolidate absorbs integrity review via flagIntegrity tool; retire dome.warden`).

### Task 4: Stale-task machinery collapses to overdue-only; prune unknown-processor state

**Files:**
- Delete: the attention-discount processor + `attention-shared.ts` under `assets/extensions/dome.daily/processors/` + `dome.attention.*` grants/doctor-entries in `assets/extensions/dome.daily/manifest.yaml`.
- Modify: `carry-forward` / `today` / `prep` / `agenda-with` processors — drop the discount penalty term from ranking (ranking = due-date then recency). Grep `dome.attention` and the shared ranking helper.
- Modify: `stale-task-warden` — overdue-only eligibility (**overdue ≥ 14 days, period**); undated tasks stop being settle-question candidates. `settle-stale-answer` unchanged.
- Modify: `src/engine/host/compiler-host.ts` (or vault-runtime startup) — wire the existing `pruneUnknownProcessors` mutator from `src/processors/execution-state.ts` at host startup with the registry in hand; log loudly what was pruned.
- Specs: `docs/wiki/specs/task-lifecycle.md` rewritten in place (attention-discounting sections retire); any `dome.attention` invariant docs/tests retire with AC3 lockstep intact.
- Test: overdue-only warden test (undated task → no question; 15-days-overdue → question); ranking test without discount; `pruneUnknownProcessors` wired test (host startup with a quarantine row for an unregistered processor → row pruned, log line); delete attention-discount tests.

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: no `dome.attention.*` fact namespace (Task 11's report card must not reference it).

**Steps:**
- [ ] Grep inventory (`attention-discount`, `attention-shared`, `dome.attention`); write the failing tests above.
- [ ] Delete + rewire + wire pruning; sweep `task-lifecycle.md`.
- [ ] Typecheck + scoped tests (`bun test tests/extensions/dome.daily tests/processors tests/engine`). Commit (`feat(dome.daily): staleness is overdue-only — retire attention-discount; prune unknown-processor quarantine state at startup`).

### Task 5: current-facts recharter — entities-only, capped, placeholder-filtered

**Files:**
- Modify: `assets/extensions/dome.claims/processors/` render-facts processor:
  - Scope guard: render digests on `wiki/entities/**` only. Non-entity page with an existing `current-facts` block → the existing splice-out branch REMOVES the block when the page is next touched.
  - Cap: **12 bullets, most-recent-`asOf`-first**, with a `+N more — dome query <subject>` tail line when capped (the To-decide cap pattern).
  - Placeholder filter: claims whose value matches template-shaped placeholder text (`[`…`]`-bracketed) never render.
- `stamp` and claim-index untouched.
- Specs: `docs/wiki/specs/claims.md` rewritten in place (§render-facts charter, scope, cap, filter, removal semantics; record cross-page subject attribution as claims-layer backlog per design §3).
- Test: entity page renders capped+sorted digest; non-entity touched page gets block removed; placeholder claim excluded; 13 claims → 12 + tail.

**Steps:**
- [ ] Write the four failing tests in the claims processor test file.
- [ ] Implement scope/cap/filter/removal; rewrite `claims.md`.
- [ ] Typecheck + scoped tests (`bun test tests/processors tests/extensions` claims files). Commit (`feat(dome.claims): current-facts digests are entities-only, capped at 12, placeholder-filtered`).

### Task 6: Run-ledger retention + size doctor probe

**Files:**
- Create: `src/ledger/retention.ts` — `pruneRunLedger(db, opts: { retentionDays: number; now: Date }): { deleted: number; reclaimedPages: number }`. Deletes `runs` rows (and any child rows, e.g. capability-use, by FK) with `started_at` older than the cutoff, EXCEPT rows whose outcome is a terminal failure referenced by open quarantine state (verify actual column/outcome names in `src/ledger/`). Runs `PRAGMA incremental_vacuum` / `VACUUM` only when deleted count exceeds 10,000 (avoid daily full-vacuum cost).
- Modify: `src/engine/host/compiler-host.ts` — invoke retention once at host startup and at most once per 24h thereafter (persist last-pruned timestamp beside other host state, NOT in the vault). Config key `ledger.retention_days`, default **30**, `0` disables; add to the vault-config zod schema + `src/cli/default-vault-config.ts` comment.
- Modify: `dome doctor` (Grep doctor findings registry) — new info finding `ledger.oversized` when `runs.db` exceeds 500 MB on disk.
- Specs: `docs/wiki/specs/run-ledger.md` (retention section — RunRecords are audit history with a bounded horizon; `EVERY_PROCESSOR_RUN_IS_LEDGERED` is about writing, not eternal retention — say this explicitly), `docs/wiki/specs/cli.md` doctor findings table if one exists.
- Test: `tests/ledger/retention.test.ts` — old rows pruned, fresh rows kept, quarantine-referenced rows kept, disabled by 0; host-startup wiring test; doctor finding test.

**Interfaces:**
- Produces: `pruneRunLedger` + `ledger.retention_days` config key.

**Steps:**
- [ ] Failing tests for retention semantics (fixture db with dated rows).
- [ ] Implement retention + host wiring + doctor probe + config key; write specs.
- [ ] Typecheck + scoped tests (`bun test tests/ledger tests/cli/commands/doctor* tests/engine`). Commit (`feat(ledger): 30-day run-ledger retention + ledger.oversized doctor probe`).

---

## Phase B — settle: the typed disposition op

### Task 7: `performSettle` collector — the commit-or-nothing settle seam

**Files:**
- Create: `src/surface/settle.ts` — `performSettle(vault, req: { blockId: string; disposition: 'close' | 'defer' | 'keep'; deferUntil?: string /* YYYY-MM-DD, required iff defer */ }): Promise<SettleResult>` where `SettleResult = { status: 'settled'; blockId: string; disposition: string; commit: string } | { status: 'not-found' | 'invalid'; message: string }`.
  - Mirrors `performCapture` (`src/surface/` — Grep it; it is the named reference implementation of the commit-or-nothing remote-write seam, per `docs/wiki/specs/capture.md`).
  - Semantics: locate the task line by its `^block-anchor` across adopted markdown (task-lifecycle block-id identity). `close` → set `- [x]`, and in the same commit append `- <task text> ([[<source page>#^<block>|from]])` under today's daily `### Done today` section (create the section via the shared skeleton helper if absent — Grep how compose-blocks creates skeleton sections). `defer` → rewrite/insert the `📅 YYYY-MM-DD` due token to `deferUntil`. `keep` → touch nothing in the body; record nothing (returns settled with a no-op commit? NO — `keep` returns `{status:'settled'}` WITHOUT a commit; it exists so surfaces can offer the same tri-state as settle-stale-answer).
  - Reuse, do not duplicate: the disposition-application logic already lives in `settle-stale-answer` (`assets/extensions/dome.daily/processors/`) — extract the pure line-rewrite helpers into a shared pure module BOTH can import. Processor-purity: the shared module must be pure text transforms (no fs); `performSettle` does the fs/git via the same machinery `performCapture` uses; the processor keeps emitting PatchEffects.
  - Commit message shape: `settle(<disposition>): <first 50 chars of task text>` authored as the human (settle is a decision, not engine authoring — same trust domain as capture).
- Specs: `docs/wiki/specs/task-lifecycle.md` gains the settle-operation contract (dispositions, block-id addressing, Done-today append, commit-or-nothing); `docs/wiki/specs/capture.md` §remote-capture seam gains one line naming settle as the second commit-or-nothing operation.
- Test: `tests/surface/settle.test.ts` — close checks the box + appends Done-today; defer rewrites the date token; keep commits nothing; unknown blockId → not-found, no commit; defer without date → invalid.

**Interfaces:**
- Produces: `performSettle` consumed verbatim by Task 8 (CLI/HTTP/MCP) and Task 9 (PWA via HTTP).

**Steps:**
- [ ] Extract the pure disposition helpers from settle-stale-answer into a shared module; keep the processor green (`bun test` its file).
- [ ] Failing tests for `performSettle` (all five cases above), then implement.
- [ ] Specs. Typecheck + scoped tests. Commit (`feat(surface): performSettle — settling is a decision, typed and commit-or-nothing`).

### Task 8: Settle surfaces — CLI, HTTP, MCP

**Files:**
- Modify: `src/cli/index.ts` + create `src/cli/commands/settle.ts` — `dome settle <blockId> <close|defer|keep> [--until YYYY-MM-DD] [--json]`; human output one line; exit 64 on invalid.
- Modify: `src/http/server.ts` — `POST /settle` `{ blockId, disposition, deferUntil? }` → SettleResult JSON (bearer-auth like `/resolve`).
- Modify: `src/mcp/server.ts` — `settle` tool beside `resolve`, same input schema.
- Specs: `docs/wiki/specs/cli.md` (primary-loop table gains settle beside resolve), `docs/wiki/specs/http-surface.md` (route), `docs/wiki/specs/mcp-surface.md` (tool), `docs/wiki/matrices/protocol-adapter.md` (row).
- Test: CLI test (mirrors `tests/cli/commands/` resolve test shape); HTTP route test; MCP tool listed + dispatch test (mirror existing MCP tests).

**Interfaces:**
- Consumes: `performSettle` from Task 7 exactly as typed.

**Steps:**
- [ ] Failing tests per surface; implement the three thin adapters (no logic beyond arg parsing — the collector owns semantics).
- [ ] Specs + matrix. Typecheck + scoped tests (`bun test tests/cli tests/http tests/mcp` — Grep actual test dirs). Commit (`feat(surfaces): dome settle / POST /settle / MCP settle — resolve's sibling for tasks`).

### Task 9: PWA checkbox settles for real

**Files:**
- Modify: `pwa/src/api/client.ts` — `settle(blockId, disposition)` calling `POST /settle`.
- Modify: `pwa/src/components/` Brief task row — the checkbox (currently decorative) fires `settle(blockId,'close')` with optimistic strike-through, revert-on-error; needs the today-view payload to carry `blockId` per task — verify `src/surface/` today-view collector already includes block ids (task-index facts carry them); if absent, add `blockId` to the today payload (`dome.daily.today/v1` — this is a versioned payload contract: adding an optional field is compatible; document in the view-contract seam spec `docs/wiki/concepts/surface-view-model.md` owning page).
- Test: `pwa/tests/` — checkbox dispatches settle + optimistic update + error revert (mirror existing PWA test style, e.g. the question-resolve optimistic test).
- Specs: PWA behavior note in `docs/wiki/specs/http-surface.md` §PWA or the pwa spec doc (Grep `pwa` in docs/wiki/).

**Steps:**
- [ ] Verify/extend the today payload with `blockId` (contract-first; update payload zod + fixture).
- [ ] Failing PWA test → implement client + checkbox wiring.
- [ ] `cd pwa && bun test` + `bunx tsc --noEmit -p pwa` (verify pwa's own check invocations from `pwa/package.json`). Commit (`feat(pwa): task checkbox settles via POST /settle — glance-and-settle closes`).

---

## Phase C — the weekly report card

### Task 10: Extend `questions.read` with resolved-window queries

**Files:**
- Modify: `src/engine/operational/operational-query-view.ts` — `questions(filter?)` gains `{ resolvedSince?: string /* ISO */ }` returning resolved rows (id, processorId, resolvedAt, answerValue) alongside the existing open-row shape; discriminate by a `state: 'open' | 'resolved'` field. Same capability (`questions.read`), no new grant vocabulary.
- Modify: run-ledger view — verify `ctx.operational.runs(filter?)` (the `run.read` capability used by orphan-run-recovery) can filter by `startedSince` and exposes `processorId, outcome, costUsd, durationMs`; add the since-filter + cost fields to the view if missing (read-only widening).
- Specs: `docs/wiki/specs/capabilities.md` §questions.read/run.read shapes rewritten in place.
- Test: extend `tests/engine/operational-query-view.test.ts` — resolvedSince returns only in-window resolved rows; runs since-filter + cost fields.

**Interfaces:**
- Produces: `ctx.operational.questions({resolvedSince})` + `ctx.operational.runs({startedSince})` with cost — consumed by Task 11.

**Steps:**
- [ ] Failing view tests; implement widenings; specs; typecheck + scoped tests. Commit (`feat(engine): questions.read resolved-window + run.read cost/since — read-side widening for the report card`).

### Task 11: `dome.health.report-card` — the weekly garden report

**Files:**
- Create: `assets/extensions/dome.health/processors/report-card.ts` — deterministic garden processor, cron `22 5 * * 1` (Monday 05:22, before brief 05:30), capabilities `run.read` + `questions.read` + patch grant for `meta/report-card.md` + today's daily.
  - Emits ONE PatchEffect covering two files:
    1. `meta/report-card.md` — full card, rewritten in place (deterministic render): per-processor table over the trailing 7 days (runs, failures, quarantines, model cost USD, last-productive note = count of non-no-op outcomes), questions opened/resolved counts by processor, retrieval-miss count (row present only when `meta/retrieval-misses.md` exists — read via declared file read, count entries this week by their date lines; Task 12 defines the entry grammar), and a "possibly idle" section listing processors with ≥50 runs and zero productive outcomes.
    2. Today's daily gains a `dome.health:report-card` generated block under a `## Weekly review` section (create via the shared skeleton pattern): ≤10 lines — total cost, top 3 spenders with productive-outcome counts, questions opened/resolved, misses count, `Full card: [[meta/report-card]]`. Register the block id in `DAILY_GENERATED_BLOCKS` + search strip list.
  - No model, no facts, no questions. Weekly only.
- Modify: `assets/extensions/dome.health/manifest.yaml` (processor, grants, doctor grantEntries).
- Specs: new section in `docs/wiki/specs/cli.md`? No — the owning spec is the health bundle: Grep for a health spec page; if none, add §"Report card" to `docs/wiki/specs/daily-surface.md` (block ownership table row + choreography row at 05:22 Monday) and the bundle matrix rows.
- Test: `tests/extensions/dome.health/report-card.test.ts` — fixture ledger rows + questions → expected two-file patch; idle-processor detection; byte-identical re-render no-ops; absent misses file → row omitted.

**Interfaces:**
- Consumes: Task 10's view widenings; Task 12's miss-entry grammar (date-prefixed `- YYYY-MM-DD …` bullets).

**Steps:**
- [ ] Failing renderer tests; implement processor + manifest + block registration.
- [ ] Specs (choreography + block table + matrices). Typecheck + scoped tests. Commit (`feat(dome.health): weekly report card — what ran, what it cost, what got acted on`).

---

## Phase D — recall-loop instrumentation

### Task 12: Retrieval-miss logging (`--miss`, MCP `report_miss`)

**Files:**
- Create: `src/surface/report-miss.ts` — `reportMiss(vault, req: { query: string; note?: string }): Promise<{ status: 'recorded'; commit: string }>` appending to `meta/retrieval-misses.md` (created with a header on first miss) the entry `- YYYY-MM-DD — "<query>" — <note ?? 'no note'>`, committed human-authored (`miss: <query first 40 chars>`) via the capture-style seam. Append-only convention (the `preferences/signals.md` precedent).
- Modify: `src/cli/commands/query.ts` + export-context command — `--miss [note]` flag: after printing results, records the miss.
- Modify: `src/mcp/server.ts` — `report_miss` tool `{ query, note? }`.
- Modify: vault AGENTS.md template (`src/cli/commands/init-templates.ts`) — the existing "note the miss in the relevant markdown" sentence becomes: report misses via `dome query "<text>" --miss "what was missing"` (interface, not itinerary — one sentence).
- Specs: `docs/wiki/specs/cli.md` (flag), `docs/wiki/specs/mcp-surface.md` (tool), `docs/wiki/specs/vault-layout.md` (meta/retrieval-misses.md file class beside the signals convention).
- Test: reportMiss creates + appends + commits; CLI flag test; MCP tool test.

**Interfaces:**
- Produces: the miss-entry grammar Task 11 counts (`- YYYY-MM-DD — "…" — …`).

**Steps:**
- [ ] Failing tests; implement collector + flag + tool + template sentence; specs. Typecheck + scoped tests. Commit (`feat(recall): retrieval-miss logging — the evidence base the memory plan gated on`).

### Task 13: Rename the interactive agent — `src/agent/` → `src/assistant/`

**Files:**
- Move: `src/agent/*` → `src/assistant/*` (git mv); update imports in `src/http/server.ts` + anywhere else (Grep `from '../agent`, `src/agent`). HTTP route paths `/agent`, `/agent/stream` are WIRE CONTRACT — unchanged (PWA depends on them). Internal names only: exported symbols keep their names unless they contain a confusing `DomeAgent`-style prefix (Grep; rename to `Assistant*` where they do).
- Specs: `docs/wiki/specs/http-surface.md` + `docs/wiki/concepts/client-model.md` — one in-place clarification sentence: the interactive assistant (`src/assistant/`, HTTP `/agent` routes) is a consumer surface, distinct from the `dome.agent` background bundle.
- Test: existing agent/http tests keep passing after the move (`bun test tests/` matching files — Grep test files importing src/agent).

**Steps:**
- [ ] git mv + import sweep + optional symbol renames; scoped tests + typecheck. Commit (`refactor(http): src/agent → src/assistant — one name per concept; wire routes unchanged`).

### Task 14: Promote the four buried views to real commands

**Files:**
- Modify: `src/cli/view-command-aliases.ts` — `DEDICATED_VIEW_COMMAND_ALIASES` gains `prep`, `agenda-with`, `stale-claims`, `orphan-pages` (Grep how query/export-context/lint are declared; mirror exactly, including arg passthrough — `prep <topic>`, `agenda-with <person>` take positional args; verify how the view processors receive command args via the view-phase contract).
- Modify: `src/cli/commands/init-templates.ts` — the template's `dome run prep` / `dome run agenda-with` instructions become the first-class verbs.
- Specs: `docs/wiki/specs/cli.md` — the four commands move from "hidden advanced" to the adopted-state-views section, one line each.
- Test: extend the CLI view-alias test (Grep `view-command-aliases` in tests/) — four new verbs dispatch to the right processors.

**Steps:**
- [ ] Failing alias tests; implement; template + spec sweep; typecheck + scoped tests. Commit (`feat(cli): prep / agenda-with / stale-claims / orphan-pages are real commands — no feature behind a debug verb`).

---

## Phase E — the patrol: coverage-based gardening

### Task 15: `dome.agent.patrol` — deterministic staleness patrol

**Files:**
- Create: `assets/extensions/dome.agent/processors/patrol.ts` — deterministic garden processor, cron `45 1 * * *` (nightly, before consolidate 02:00), no model.
  - Reads `wiki/entities/**`, `wiki/concepts/**`, `wiki/syntheses/**` + `meta/patrol-ledger.md`.
  - Ranks pages by staleness = `updated:` frontmatter date (fallback: skip pages without one), oldest first, EXCLUDING pages visited within the last 35 days per the ledger.
  - Emits ONE PatchEffect rewriting BOTH:
    1. `meta/patrol-queue.md` — today's pick: **5 pages**, one bullet each `- [[<page>]] — last updated <date>, <line count> lines`, header stating the contract ("tonight's consolidate reviews these; clean bill or proposal, then they leave the queue").
    2. `meta/patrol-ledger.md` — deterministic visit record, one line per page `- <YYYY-MM-DD> [[<page>]]`, pruned to the trailing 60 days on every render (bounded, not accreting).
  - Also emits `page.oversized` **info diagnostics** for any scanned page > 600 lines (self-clearing when the page shrinks) — the deterministic propose-split nudge.
- Modify: `assets/extensions/dome.agent/manifest.yaml` (processor, patch grant for the two meta files, doctor grantEntries).
- Specs: `docs/wiki/specs/autonomous-agents.md` gains §"Patrol" (deterministic selector; consolidate consumes the queue — Task 16); `docs/wiki/specs/vault-layout.md` meta/ table rows; bundle matrix row.
- Test: `tests/extensions/dome.agent/patrol.test.ts` — stalest-5 selection; 35-day revisit exclusion; ledger prune; oversized diagnostic; byte-identical no-op.

**Interfaces:**
- Produces: `meta/patrol-queue.md` grammar consumed by Task 16.

**Steps:**
- [ ] Failing tests; implement; manifest + specs. Typecheck + scoped tests. Commit (`feat(dome.agent): nightly patrol — the whole vault re-groomed on a cycle, not just what changes`).

### Task 16: Consolidate consumes the patrol queue

**Files:**
- Modify: consolidate's target-scope mechanism (Grep `consolidate_targets` under `assets/extensions/dome.agent/` and `docs/wiki/specs/autonomous-agents.md`) — the patrol queue's pages join the nightly consolidate scope; charter gains a patrol section: for each queue page, exactly one of (a) propose a split when the page is an accreted multi-document (propose-not-auto, `patch.propose`), (b) reconcile it against named topic-cluster duplicates, (c) refresh stale claim dates it can ground in sources, or (d) record a clean bill in the consolidation ledger. Budget note: queue pages ride the existing consolidate budget — no new spend scope.
- Test: charter test (patrol section present, references the queue file); scope test — queue pages land in consolidate targets (mirror how consolidate scope is currently tested); prompt-regression snapshot reviewed deliberately.
- Specs: `docs/wiki/specs/autonomous-agents.md` §consolidate rewritten in place.

**Steps:**
- [ ] Failing charter/scope tests; implement; spec sweep. Typecheck + scoped tests. Commit (`feat(dome.agent): consolidate reviews the patrol queue — clean bill or proposal, nightly`).

---

## Phase F — second-user kit

### Task 17: Brain on by default, loud when starved

**Files:**
- Modify: `src/cli/default-vault-config.ts` — `dome.agent` ships `enabled: true`. Verify the existing model-budget config (Grep `budget` in src/ + dome.agent manifest — the budget-scopes work from June) and set shipped defaults: daily model cap **$2.00/day**, per-run cap unchanged if one exists.
- Modify: the agent-bundle load path — when `dome.agent` is enabled and NO model provider is configured, emit a **warning diagnostic** `agent.no-model-provider` once per host start ("dome.agent is enabled but no model provider is configured; run `dome init --with-model-provider` or set enabled: false") instead of the silent skip. Grep where model-provider absence is currently swallowed (the historical silent no-op named in wedge §Diagnosis).
- Modify: `docs/getting-started.md` — the install path now yields a first brief within 24h of init + API key; rewrite §6/agent-enablement in place (it currently ships the bundle disabled to protect model dollars; the $2/day default cap is the new protection).
- Test: default-config test (`tests/integration/default-vault-config.test.ts`) — agent enabled + caps present; no-provider diagnostic test.

**Steps:**
- [ ] Failing tests; flip defaults + add diagnostic; rewrite getting-started + default-config spec prose. Typecheck + scoped tests. Commit (`feat(init): the brain ships on — $2/day cap is the guardrail, silence is not`).

### Task 18: `grants: standard` preset

**Files:**
- Modify: vault-config schema + loader (Grep where `.dome/config.yaml` is parsed/zod-validated) — a top-level `grants: standard` key expands at load time to the union of every enabled bundle's manifest default grants; an explicit per-processor grant map continues to win entirely (presence of the fine-grained block = preset ignored for those processors); `grants: standard` plus additions merges (additions layered over preset). Loader-level expansion — the broker sees only concrete grants.
- Modify: `dome init` writes `grants: standard` in fresh-vault config instead of the enumerated block (Grep the init config template).
- Specs: `docs/wiki/specs/capabilities.md` §vault grants rewritten in place (preset semantics, precedence, escape hatch).
- Test: loader test — preset expands to manifest defaults; fine-grained block wins; preset+additions merge; init writes the preset.

**Steps:**
- [ ] Failing loader tests; implement expansion + init template; spec. Typecheck + scoped tests (`bun test tests/cli/commands/init.test.ts` + config loader tests). Commit (`feat(config): grants: standard — one line where forty were; YAML stays the escape hatch`).

### Task 19: `NEEDS_ARE_LOUD` — the runtime invariant

**Files:**
- Modify: `src/processors/runtime.ts` (processor invocation construction) — when a processor's manifest-declared capability has an empty effective grant intersection, or a declared read-view context field (`ctx.operational.*` per declared `*.read` capability) is absent at invocation, the runtime emits a **warning diagnostic** `processor.need-unmet` (code carries processor id + the unmet need), deduped once per (processor, need) per host session. The processor still runs (degradation stays graceful; the silence is what dies).
- Create: `docs/wiki/invariants/NEEDS_ARE_LOUD.md` — *(shipped default)* "A processor whose declared capability or context dependency is absent at run time surfaces a warning diagnostic; silent degradation on a declared need is a defect." Cites the four incidents (brief questions block, grant-starved claims, provider no-op, refresh-config).
- Create: `tests/invariants/needs-are-loud.test.ts` (AC3 lockstep) — a processor declaring an ungranted capability runs AND a `processor.need-unmet` warning lands in diagnostics; granted processor → no diagnostic.
- Modify: `docs/index.md` invariants list + `docs/wiki/specs/processor-execution.md` (the runtime behavior, rewritten in place).
- Note: `dome doctor`'s grant-starvation probes remain (config-time detection); this is the run-time complement.

**Steps:**
- [ ] Failing invariant test; implement runtime emission + dedup; invariant doc + index + spec. Typecheck + scoped tests (`bun test tests/invariants tests/processors/runtime.test.ts`). Commit (`feat(runtime): NEEDS_ARE_LOUD — a declared need unmet is a warning, never a silent no-op`).

### Task 20: `--refresh-config` merges missing grant entries

**Files:**
- Modify: the `dome init --refresh-config` path (Grep `refresh-config` in src/cli/) — for each loaded bundle processor whose manifest `doctor.grantEntries` names a grant absent from the vault's user-owned grant block, ADD the entry via the yaml Document API (parseDocument → targeted node insert → stringify; the chunk8 comment-preserving precedent, commit b681311) and print a summary of added entries. Never removes or narrows existing entries. When `grants: standard` (Task 18) is in use, refresh is a no-op for grants.
- Specs: `docs/wiki/specs/cli.md` §dome init rewritten in place; strike the corresponding hazard line in `docs/cohesive/second-user-blockers.md` (that file is an accumulating ledger — strike-through with pointer, per its own convention; this is the ONE cohesive/ doc this plan edits, and only in its blessed strike-through form).
- Test: refresh adds missing entries preserving comments; existing entries untouched; preset short-circuit.

**Steps:**
- [ ] Failing tests; implement merge + summary; specs + ledger strike. Typecheck + scoped tests. Commit (`fix(init): --refresh-config merges new default grants — new processors stop arriving capability-starved`).

---

## Phase G — ops fixes

### Task 21: Lint-processor timeout fix

**Files:**
- Investigate: `assets/extensions/dome.markdown/processors/` lint-supersession + validate-wikilinks + normalize-frontmatter — live-vault evidence: repeated 30s timeouts at ~978 files. Profile with a synthetic 1,000-file fixture (script it in the test, generate temp files). Likely shapes: full-vault re-read per run instead of compileRange scoping, O(n²) cross-file link resolution, or per-file regex recompilation. Fix the measured hot path (e.g. build the link-target index once per run; scope re-validation to changed files + their referrers via the graph facts).
- Test: perf regression test asserting the processor completes a 1,000-file fixture in < 5s (generous CI margin; mark it so it can be skipped under load if the repo has a slow-test convention — Grep for existing perf/slow test markers).
- Specs: none unless behavior changes (pure perf).

**Steps:**
- [ ] Reproduce with the fixture + measure; fix the hot path; perf test green; existing lint tests green. Commit (`perf(dome.markdown): lint passes scale past 1k files — no more 30s timeouts`).

### Task 22: Ref-advance retry — no more hard lock failures

**Files:**
- Modify: `src/git.ts` ref-advance path (Grep `Failed to advance` / `cannot lock ref` — live evidence: 2 hard adoption failures + 24 waits in 14 days from concurrent hosts) — wrap the ref update in a bounded retry (5 attempts, 100ms→1.6s exponential backoff + jitter) when the failure is a lock-contention error (match the error shape precisely; other git errors still throw immediately).
- Test: `tests/git.test.ts` — injected lock failure succeeds on retry; non-lock error throws immediately; exhausted retries surface the original error.

**Steps:**
- [ ] Failing retry tests with an injected failing ref-writer; implement bounded retry; scoped tests. Commit (`fix(git): bounded retry on ref-lock contention — concurrent hosts stop failing adoption`).

---

## Post-merge rollout (controller-run operator steps, NOT subagent tasks)

1. Verify `main` tip unchanged since branch cut (concurrent-session hazard); `--no-ff` merge; delete branch + worktree; delete stale `pruning/build` + `questions-digest/build` + `daily/build` branches (design content is carried here).
2. Work vault config sweep: remove `dome.warden` stanza + `dome.attention.*` grants; add grants for compose/report-card/patrol per doctor output; flip nothing else.
3. Fix the http launchd plist PATH (`bun` missing → exit 127 flaps).
4. `dome restart`; watch one sync; `dome resolve` the two stale quarantine-recovery questions (ids 2, 3) after `pruneUnknownProcessors` clears the rows; confirm runs.db retention pruned (file size drop after vacuum).
5. Projection rebuild (clears `dome.attention.*` facts and non-entity digest facts).
6. Memory + docs index updates.
