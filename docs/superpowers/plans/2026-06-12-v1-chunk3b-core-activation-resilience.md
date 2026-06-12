# Dome v1 Chunk 3b — core.md Activation + Resilience Trio — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn core.md from a starving stub into a live personalization layer (foreground signal contract, seed interview recipe, generated Active-projects block), and harden the three known garden failure modes (brief crash, sweep poison pairs, consolidate scoping) — completing WS1 of the v1 plan (`docs/cohesive/brainstorms/2026-06-11-dome-v1-plan.md`).

**Architecture:** All processor/adapters work over the sealed core. The foreground signal contract lands in the init AGENTS.md template (the conversation layer is where preferences are uttered — chunk 3a's root-cause finding). Active projects becomes a second marker-delimited generated block in core.md, written by a new deterministic garden processor with its own narrow per-processor grant — evolving the "single auto-writer" contract into a **two-gated-writers, block-scoped** contract (promotion-answer owns `promoted-preferences`; the new processor owns `active-projects`; both deterministic, both block-anchored, owner prose untouched). Brief failure stays roll-back-atomic but now leaves a deterministic fallback stub + an acknowledgeable question. Sweep poison pairs settle via a new `escalated` ledger disposition (no file moves — materials are often dailies). Consolidate gains `consolidate_targets` mirroring `sweep_targets`.

**Tech Stack:** Bun + TypeScript, `bun:test`, existing generated-block + preference + sweep-ledger machinery.

**Verified context constraints (from code exploration — executors re-verify):**
- Promotion-answer is THE auto-writer to core.md today, pinned in: manifest per-processor grant (`dome.agent/manifest.yaml` ~286-307), the per-processor replacement grant in `default-vault-config.ts` (~138-141), `docs/wiki/specs/preferences.md` §single-auto-writer, `vault-layout.md` §core.md, and **the no-accreting-registries fence pins the promotion-answer grant EXACTLY** (`tests/invariants/no-accreting-registries.test.ts`) — all must learn the second writer deliberately.
- Promoted block markers: `dome.agent:promoted-preferences`; multi-block coexistence is safe iff distinct block names + the shared `findGeneratedBlock` API (no raw indexOf).
- Signal grammar (preferences-shared.ts): `- YYYY-MM-DD [+|-] <topic-slug>:: <rule> [(source: [[page]])]`; HTML comment delimiters banned in signal lines.
- Carry-forward's open-loop collection + ranking lives in dome.daily libs and reads the SNAPSHOT (not projection); cross-bundle lib import has precedent (brief.ts uses dome.daily's renderDailySkeleton helpers).
- Brief failure today: roll-back-atomic, one `dome.agent.brief-failed` warning diagnostic (brief.ts ~213-226). create-daily (06:00) and carry-forward run independently, so open loops survive a brief crash — what's lost is the digest/meetings content.
- Sweep: `ESCALATE_AFTER_FAILURES = 3`; `failed` ledger rows keep the pair eligible and hold the cursor back; escalation emits a question but nothing settles the pair.
- The init AGENTS.md template has managed sections + a user-prose block preserved across `--refresh-instructions`; it mentions neither preferences/signals.md nor `dome log` (3a deferred item — fold in here).
- `dome recipe <kind>` exists (chunk 1); adding a kind = one branch + text function + tests.

---

## File structure

| File | Role |
|---|---|
| Modify `src/cli/commands/init.ts` | scaffold `preferences/signals.md`; AGENTS.md template gains foreground-signal contract + core.md seeding pointer + `dome log` mention |
| Modify `src/cli/commands/recipe.ts` | new `core-seed` recipe kind (owner interview prompt) |
| Create `assets/extensions/dome.agent/lib/active-projects.ts` | pure: open-loop candidates → block body |
| Create `assets/extensions/dome.agent/processors/active-projects.ts` | deterministic garden processor writing the `dome.agent:active-projects` block in core.md |
| Modify `assets/extensions/dome.agent/manifest.yaml` + `src/cli/default-vault-config.ts` | second narrow core.md grant |
| Modify `assets/extensions/dome.agent/processors/brief.ts` | failure → fallback stub + acknowledgeable question |
| Modify `assets/extensions/dome.agent/processors/sweep.ts` + `lib/sweep-queue.ts` + `lib/sweep-ledger.ts` | `escalated` disposition settles poison pairs |
| Modify `assets/extensions/dome.agent/processors/consolidate.ts` (+ its charter/tools if scope-gated) | `consolidate_targets` config |
| Modify `tests/invariants/no-accreting-registries.test.ts` | two-writer contract |
| Modify specs: `preferences.md`, `vault-layout.md`, `autonomous-agents.md`, `cli.md`, `capture.md` if touched | lockstep |
| Tests | per task below |

Run tests: `bun test <path>`; full suite `bun test`; typecheck `bun run typecheck`.

---

### Task 1: init scaffolds the signal surface + foreground contract

**Files:** Modify `src/cli/commands/init.ts`; test wherever init template content is pinned (`tests/cli/commands.test.ts` per exploration — read it first).

- [ ] **Step 1 (failing tests):** (a) `runInit` on a fresh dir creates `preferences/signals.md` with a short header comment explaining the grammar (`- YYYY-MM-DD + <topic-slug>:: <rule> (source: [[page]])`) and that lines are appended, never edited; (b) the generated AGENTS.md contains a managed section "Preference signals" instructing the foreground agent: *when the owner expresses a durable preference or corrects agent behavior in conversation, append one well-formed signal line to `preferences/signals.md` (same grammar; explicit statements only — never infer from silence); promotion to core.md stays owner-mediated*; (c) AGENTS.md mentions `dome log` as the activity view (3a deferred item); (d) `--refresh-instructions` on a vault with existing user prose preserves the prose and adds the new sections.
- [ ] **Step 2:** Run; FAIL. **Step 3:** Implement — scaffold file in the init step list (mirror how core.md is written; signals.md must NOT be overwritten if present); template additions in `renderAgentsMd`'s managed sections, matching the template's existing voice and length discipline (short paragraphs, exact grammar quoted once). **Step 4:** Run init tests + `bun test tests/cli`. **Step 5: Commit** `feat(init): preference-signal surface + foreground signal contract in vault instructions`.

### Task 2: `dome recipe core-seed`

**Files:** Modify `src/cli/commands/recipe.ts`; test `tests/cli/commands/recipe.test.ts` (extend).

- [ ] **Step 1 (failing tests):** `runRecipe({kind: "core-seed"})` exits 0 and prints: the three core.md sections by name; an interview prompt the owner pastes into a foreground session (ask about role/team/standing preferences/current focus; draft `## Who I am` + `## Standing preferences` for owner edit; keep under the 6,000-char budget; NEVER write inside marker-delimited blocks); a note that `## Active projects` is generated (do not hand-author). Unknown-kind error message now lists both kinds (`available: ios, core-seed`).
- [ ] **Step 2-5:** FAIL → implement (one text function, mirror `iosRecipe`'s shape) → PASS (`bun test tests/cli/commands/recipe.test.ts`) → **Commit** `feat(cli): dome recipe core-seed — owner interview for core memory`.

### Task 3: active-projects pure renderer

**Files:** Create `assets/extensions/dome.agent/lib/active-projects.ts`; test `tests/extensions/dome.agent/active-projects-lib.test.ts`.

Contract: `renderActiveProjects(items: ReadonlyArray<ActiveProjectItem>, opts: {limit: number}): string` where `ActiveProjectItem = { page: string; openLoops: number; lastTouched: string /* YYYY-MM-DD */ }`. Output: sorted by (openLoops desc, lastTouched desc, page asc), capped at `limit` (default 5 lives in the processor), lines `- [[<page-sans-md>]] — <n> open loop(s), last touched <date>`; empty input → `_(no active projects detected — open loops feed this block)_`. Deterministic; no Date.now.

- [ ] **Step 1 (failing tests):** sorting/cap/singular-plural/empty-state/determinism (reversed input → identical output). **Step 2-5:** FAIL → implement → PASS → **Commit** `feat(dome.agent): pure active-projects block renderer`.

### Task 4: `dome.agent.active-projects` processor — the second gated core.md writer

**Files:** Create `assets/extensions/dome.agent/processors/active-projects.ts`; modify `manifest.yaml`, `src/cli/default-vault-config.ts`, `tests/invariants/no-accreting-registries.test.ts`, `src/extensions/maintenance-loops.ts` + docs matrices (lockstep tests will demand); test `tests/extensions/dome.agent/active-projects.test.ts`.

Design (executor verifies APIs against carry-forward.ts and the dome.daily libs):
- Deterministic garden processor; triggers: schedule `20 5 * * *` (after the 05:15 index render, before the 05:30 brief so the brief's core-memory injection sees fresh data) + signal `document.changed` on `wiki/dailies/*.md`.
- Reads open-loop candidates via dome.daily's snapshot-reading collection lib (the same machinery carry-forward uses — import cross-bundle like brief.ts imports renderDailySkeleton; if the lib's shape resists reuse, collect open-loop lines from dailies directly with the same parser and report the divergence). Group candidates by their source wiki page (the page an open loop links to / lives in, excluding dailies themselves); compute `openLoops` count + max `lastTouched` per page; render via Task 3's lib.
- Splice into core.md's `dome.agent:active-projects` block via `generatedBlockMarkers`/`findGeneratedBlock`/`replaceGeneratedBlock` ONLY. Block absent → create it under the `## Active projects` heading (mirror how the promotion answer creates the promoted block under `## Standing preferences`). Diff-before-emit: byte-identical → zero effects. Marker anomalies → info diagnostics (3a's render-index posture). The promoted-preferences block and owner prose must be byte-untouched (test pins this with both blocks + prose present).
- PatchEffect reason: `dome.agent: refresh active-projects block (<n> projects)`.
- **Grant:** per-processor replacement grant — read `["core.md", "wiki/dailies/*.md", "wiki/**/*.md"]` (whatever the collection lib needs; keep minimal), patch.auto `["core.md"]`. Manifest narrow capabilities to match.
- **Contract evolution:** core.md now has exactly two gated writers, each owning one named block. Update the fence test: the per-processor exact-grant pin becomes a two-entry table (promotion-answer: core.md+signals.md; active-projects: core.md) and add the rule "every core.md patch.auto holder must own a distinct generated block name" as a comment anchor. Update the manifest "THE single auto-writer" comment.
- [ ] **Step 1 (failing tests):** vault fixture with two dailies carrying open-loop lines linking two wiki pages + a core.md containing owner prose AND a promoted-preferences block → one PatchEffect writing only the active-projects block (prose + other block byte-identical); empty-candidate fixture → block carries the empty-state line; idempotent second run → zero effects; anomaly fixture → info diagnostic, no patch.
- [ ] **Step 2-5:** FAIL → implement → run `bun test tests/extensions tests/invariants tests/integration` (fix what bundle-matrix/maintenance-loops/doctor lockstep demands, as in 3a) → **Commit** `feat(dome.agent): active-projects generated block — core.md gains its second gated writer`.

### Task 5: brief-failure recovery

**Files:** Modify `assets/extensions/dome.agent/processors/brief.ts`; test wherever brief failure is covered (find the existing brief-failed test).

In the existing catch (roll-back stays atomic): keep the warning diagnostic; ADD (a) a deterministic PatchEffect splicing a fallback stub into the daily's brief-owned block region (executor: read how brief writes its blocks; reuse the same block name): `_Morning brief failed (<flattened error, ~120 chars>). Yesterday's note: [[wiki/dailies/<yesterday>]]. Retry: \`dome run dome.agent.brief\`._` — only when the daily file exists or the seeded skeleton was part of this run's edits (re-seed minimally if needed, mirroring the existing skeleton helper); (b) a QuestionEffect, idempotency `dome.agent.brief-failed:<date>`, options `["retried", "skip-today"]`, metadata `automationPolicy: "agent-safe"`, `recommendedAnswer: "retried"`, question text naming the retry command. NO answer handler (resolution is the durable acknowledgment; nothing fires on it — document this choice in the processor comment).

- [ ] **Step 1 (failing tests):** force the agent loop to throw (existing test technique) → effects contain warning diagnostic + fallback patch (stub text + yesterday link) + question with the pinned idempotency key; second failure same day → question idempotent (same key); fallback block content does NOT duplicate on re-failure (splice, not append).
- [ ] **Step 2-5:** FAIL → implement → `bun test tests/extensions` → **Commit** `feat(dome.agent): brief failure leaves a deterministic fallback stub + acknowledgeable question`.

### Task 6: sweep poison pairs settle via `escalated` disposition

**Files:** Modify `assets/extensions/dome.agent/lib/sweep-ledger.ts`, `lib/sweep-queue.ts`, `processors/sweep.ts`, `processors/sweep-answer.ts`; tests: the existing sweep test files (extend).

Executor first reads the real threshold behavior (sweep.ts ~471-498), then implements: at `failedCount >= ESCALATE_AFTER_FAILURES`, the run writes an `escalated` ledger row for the pair (new disposition in the ledger grammar; update the parser + writer) **alongside** the existing question. Queue builder excludes pairs with an `escalated` row (they stop consuming attempts and stop holding the cursor back — verify the cursor math treats `escalated` as settled). The sweep-answer handler gains the disposition: owner answer `skip` (or whatever the existing question options are — match them) → confirm the escalated row stands (no-op, idempotent); answer that requests integration → existing settle path; the pair becomes eligible again only if the owner answer says retry (write a `retry-granted` row? — NO: YAGNI; re-eligibility = owner deletes the escalated row by hand, documented in the spec).

- [ ] **Step 1 (failing tests):** ledger with 3 `failed` rows for a pair → run emits question + `escalated` row; next run's queue excludes the pair AND the cursor advances past its materialDate; parser round-trips the new disposition; sweep-answer on the escalated question settles without re-queuing.
- [ ] **Step 2-5:** FAIL → implement → `bun test tests/extensions` → **Commit** `feat(dome.agent): sweep poison pairs settle via escalated disposition — no indefinite requeue`.

### Task 7: `consolidate_targets` config

**Files:** Modify `assets/extensions/dome.agent/processors/consolidate.ts` (+ charter if it names scope); tests: existing consolidate test files (extend).

Mirror `sweep_targets` exactly (validation, grant-probe via globMatch, malformed → defaults + warning diagnostic `dome.agent.consolidate-config-invalid` — match the existing config-diagnostic code pattern). Default: current whole-wiki behavior (`["wiki/"]`). The targets gate which pages the run treats as in-scope for drift hunting and merging (executor reads how scope is currently expressed in the charter/task-turn and threads targets there); MAX_CHANGED_FILES cap unchanged.

- [ ] **Step 1 (failing tests):** config `consolidate_targets: ["wiki/entities/"]` → task turn / scope reflects only that prefix; malformed → defaults + warning; valid config produces no diagnostic.
- [ ] **Step 2-5:** FAIL → implement → `bun test tests/extensions tests/integration/agent-prompt-regression.test.ts` (snapshot updates deliberate) → **Commit** `feat(dome.agent): consolidate_targets scope config`.

### Task 8: spec lockstep

**Files:** `docs/wiki/specs/preferences.md` (single-auto-writer → two-gated-writers block-scoped contract), `vault-layout.md` (core.md section: active-projects block generated, seeding via recipe, signals.md scaffolded by init), `autonomous-agents.md` (brief failure contract, sweep escalated disposition, consolidate_targets, active-projects processor entry + grants tables), `cli.md` (recipe kinds list + core-seed section), `docs/wiki/specs/capture.md` only if it references recipe kinds. Read each spec fully first; house voice; run `bun test tests/integration` + full suite; fix what docs-coupled pins demand.

- [ ] **Commit** `docs(specs): two-writer core.md contract, brief recovery, sweep escalation, consolidate targets`.

### Task 9: full verification + merge

- [ ] Full `bun test` + `bun run typecheck` green. E2E smoke: scratch vault → seed a daily with open-loop lines → `dome run dome.agent.active-projects` → core.md gains the block; `dome recipe core-seed` prints; init scaffold check (`preferences/signals.md` exists, AGENTS.md sections present).
- [ ] Final whole-branch review (cross-task consistency: fence ↔ grants ↔ manifest ↔ specs; work-vault blast radius: what happens on first tick — active-projects writes core.md's block on a vault whose core.md is the untouched stub: verify it creates the block under `## Active projects` without disturbing the skeleton comment).
- [ ] `--no-ff` merge per repo convention; suite green on main.

---

## Self-review notes (already applied)

- **Spec coverage:** foreground contract (T1), seed-as-event (T2 — recipe, not folklore), generated active-projects (T3-4), pruning explicitly deferred (nothing promoted yet to demote — YAGNI until signals accrue; core-size lint is the backstop), brief recovery (T5), sweep poison (T6 — ledger disposition, not file moves: materials are dailies), consolidate scope (T7), lockstep (T8).
- **Deliberate scope cuts:** no answer handler for the brief question (resolution = acknowledgment); no preference-demotion machinery; no retry-granted sweep flow (owner hand-edits the ledger, documented); active-projects derivation is open-loop-count-based (the simplest deterministic "what's actually active" — revisit if it reads wrong in practice).
- **Verify-against-reality flags:** (a) the dome.daily open-loop collection lib's exact exports + whether cross-bundle import passes the engine-import-direction fence; (b) brief's block names + skeleton helper; (c) sweep threshold/cursor real behavior + question options; (d) how consolidate scope reaches the model (charter vs task turn); (e) init template test location; (f) the fence's exact-grant pin shape.
