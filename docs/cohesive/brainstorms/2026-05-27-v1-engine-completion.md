# Brainstorm — Completing the v1 engine: runners + supporting infrastructure

> **Design evolution note (2026-05-28).** The plan went through three design passes on the question / answer / substrate-mutation surface area. The shape that landed:
> - **Questions are for content decisions where a bundle drives the resolution** (intake disambiguation, lint wikilink resolution, calendar conflict). The bundle that emits the question is the bundle that handles the answer — symmetric pattern via a new `answer` trigger kind.
> - **Operational substrate maintenance uses direct CLI verbs** (`dome outbox retry`, `dome quarantine reset`, `dome runs fail`) — small closed set, engine-owned, not bundle-extensible. Probes in `dome.health` emit Diagnostics pointing at the verbs.
> - **Question / answer is multi-surface from day one** — first-class on `AbstractSurface.questions.*`, rendered by CLI (`dome answer`) and MCP (`dome.questions.answer`) in Phase 4h, future HTTP / mobile / voice in v2. The long-term UX is conversational ("agent surfaces open questions in chat"), not CLI-driven.
> - **Open questions are non-blocking.** Pinned as `OPEN_QUESTIONS_DO_NOT_BLOCK` invariant — a processor's QuestionEffect emission completes its invocation; sibling work proceeds.
>
> Earlier passes considered (a) a new 8th Effect kind, (b) an engine-internal `(question.code → handler)` registry — both rejected. Option (c)'s `engine.substrate-mutate` capability tier with typed ProcessorContext handles was also rejected as overcomplicated for what is really mechanical engine self-maintenance. The shape above replaces option (c) entirely.

### Driving observation

The v1 engine ships only the adoption-phase pipeline. Garden + view phases — plus the entire supporting infrastructure they need (scheduler, signal pub/sub, JobEffect routing, drainProcessors, the `dome answer` channel) — are deferred to "Phase 4+" with no concrete plan. This came into focus while implementing [[wiki/specs/cli]] §"dome doctor" / §"dome answer" (the reserved-for-v1.x verbs from the CLI surface recut at [[cohesive/delta-ledgers/2026-05-27-cli-surface-recut]] — or its merge commit on main): every operation `dome.health` would need to perform sits on machinery that doesn't exist.

The recut framing was that `dome.health` would absorb the pre-recut admin-flag operations (`--outbox-replay`, `--reset-quarantined-processors`, etc.) into the existing processor + Effect taxonomy. But "the existing processor + Effect taxonomy" turns out to be load-bearing only on the adoption side. Half the substrate is documented but unimplemented.

This brainstorm is the plan for finishing it — every runner, every supporting subsystem, the order to ship them in, and the design decisions that need resolving before code lands.

### What "completing v1" means here

The runner-gap bucket. Concretely:

| # | Missing piece | What it unblocks |
|---|---|---|
| 1 | **Garden-phase runner** | [[wiki/specs/processors]] §"Garden phase" — `dome.intake` (LLM extract), `dome.links` (backlinks), `dome.daily` (cron creates), `dome.health` probes, every signal-triggered post-adoption flow |
| 2 | **View-phase runner** | [[wiki/specs/processors]] §"View phase" — `dome.lint` (registered but never fires today), `dome.stats`, `dome.export-context`, `dome doctor`, command-triggered renders |
| 3 | **Scheduler** | `schedule:` triggers per [[wiki/matrices/processor-phase-x-trigger]] — `src/processors/triggers.ts:21` confirms today's matcher returns no candidates for schedule triggers; every cron-driven processor waits on this |
| 4 | **Engine signal pub/sub** | The `engine.*` signal stream — terminal-failure, processor-quarantined, question.answered, adoption.blocked — that every reactive piece of `dome.health` and future automation needs |
| 5 | **JobEffect routing** | The 7-kind Effect taxonomy's deferred-work primitive ([[wiki/specs/effects]] §"JobEffect") — no implementer today |
| 6 | **Outbox dispatcher loop** | The daemon polling that fires `outbox.db` pending rows. `dispatch.ts` functions exist; the loop wiring them to `dome serve` may not |
| 7 | **`drainProcessors()` API** | Test determinism + the future `dome wait` verb + per [[wiki/gotchas/async-read-after-write-staleness]] §"Structural mitigation" |
| 8 | **`dome answer` command (real impl)** | The user-decision channel — today a 64-exit stub per the recut |
| 9 | **Answer-handler substrate-mutation channel** | The unresolved design: how does answering a Question cause `replayFailed` / `markAbandoned` / `failOrphanedRuns` to fire? |

### State of the engine today (the recon)

Confirmed by inspection of `src/processors/runtime.ts:17,130`, `src/processors/triggers.ts:18-21`, `src/engine/runner-contract.ts:5`, `grep "engine\\.outbox\\|publishSignal" src/`, and `ls assets/extensions/`:

**Shipped:**
- `adoptionRunner` in `src/processors/runtime.ts` — fires adoption-phase processors inside the fixed-point loop. Works end-to-end.
- The fixed-point loop `src/engine/adopt.ts`; the capability broker `src/engine/capability-broker.ts`; the effect applier `src/engine/apply-effect.ts`; the three sqlite stores (`projection.db`, `runs.db`, `outbox.db`); the `dome.markdown` bundle, the `dome.lint` bundle's manifest (the processor is registered but doesn't fire — no view runner), the capability/grants substrate.

**Not shipped (the runner-gap bucket above):**
- The runtime explicitly documents the gap: *"v1 ships only `adoptionRunner`. The garden + view runners are Phase 4+"* (`src/processors/runtime.ts:130`).
- The trigger matcher explicitly skips schedule triggers: *"this matcher returns no candidates for schedule triggers so a processor whose only trigger is `schedule` does not fire"* (`src/processors/triggers.ts:18-21`).
- `grep "engine\\.outbox\\|publishSignal\\|emitSignal" src/` returns only forward-looking *comment* references (e.g., in `src/outbox/dispatch.ts`) — no actual emitter or subscriber.
- Only two bundles ship in `assets/extensions/`: `dome.markdown` and `dome.lint`. The seven other first-party bundles ([[wiki/specs/processors]] §"First-party processors" lists nine) are spec-only.

So the engine is roughly **40% complete relative to the spec**. The adoption-phase substrate is mature; everything that runs after adoption is sketched but not wired.

### Design decisions that need resolving before code

Six points. Three I can settle myself with a brief defense; three are owner-decisions. Marked accordingly.

**A. Trigger union extension for engine signals.** *Decidable by me; flag for review.*

Today `Signal` is a closed literal-union of file-change names (`file.created`, `file.modified`, `file.deleted`, `document.changed`, `frontmatter.changed`, `region.changed`, `link.added`, `link.removed` per [[wiki/specs/processors]] §"Triggers and signals"). Engine signals (`engine.outbox.terminal-failure` etc.) need to coexist.

**Proposal:** keep the closed-union spirit via a typed prefix scheme. Signal names are either `file.<event>` (file events) or `engine.<name>` (engine events). The Trigger validator at bundle load checks the prefix and the inner enum. Code change is small (extend `Signal` literal-union to include the `engine.*` names; extend matcher to dispatch by prefix). No new trigger kind required.

**B. Where the scheduler runs.** *Decidable by me.*

Three candidates: (i) inside `dome serve`'s poll loop only — the daemon owns cron; (ii) inside both `dome serve` and `dome sync` — every adoption attempt fires due crons; (iii) a separate `dome scheduler` daemon.

**Proposal: (ii).** One mechanism, fires whenever an adoption attempt runs. Matches the at-most-once-per-sync clamp from [[wiki/gotchas/scheduled-hook-idempotency]]. Users who only ever invoke `dome sync` (no daemon) still get scheduled work executed — important for non-daemon harnesses.

**C. JobEffect runtime queue.** *Decidable by me.*

Spec at [[wiki/specs/effects]] §"JobEffect" says: *"in-memory `p-queue` plus persistent `projection_store.scheduled_jobs` for survival across restarts."*

**Proposal:** ship the persistent table now (its schema is already in [[wiki/specs/projection-store]] §"`scheduled_jobs`"). The in-memory dispatcher uses Bun's native promise scheduling rather than pulling `p-queue` (one less dep, fewer constraints). Re-evaluate if concurrency limits become a problem in practice — adding a queue library is a one-file change later.

**D. The question / answer / substrate-mutation surface area.** **Resolved 2026-05-28 — see design evolution note at top of doc.**

The shape that landed:

1. **Questions are for content decisions** (intake disambiguation, lint resolution, calendar conflict, daily catch-up, recommendation confirmation). Bundles emit, bundles handle.

2. **The handler pattern is symmetric**, implemented via a **new `answer` trigger kind**:

   ```ts
   type Trigger =
     | { kind: "signal";   name: string; pathPattern?: string }
     | { kind: "path";     pattern: string }
     | { kind: "schedule"; cron: string }
     | { kind: "command";  name: string }
     | { kind: "answer";   codePrefix: string };  // NEW
   ```

   A bundle declares both a normal trigger (e.g., `signal: file.created`) and an `answer` trigger (`codePrefix: "intake."`). On normal fire it may emit a Question; on answer fire it receives `ctx.input = { kind: "answer", question, answer }` and emits the resolution Effect.

3. **Questions are non-blocking.** Emitting a QuestionEffect completes the processor's invocation. The pause is data-shaped (a `projection.db.questions` row), not control-shaped. Pinned by the `OPEN_QUESTIONS_DO_NOT_BLOCK` shipped-default invariant added in Phase 4k.

4. **Question / answer is multi-surface.** First-class on `AbstractSurface.questions.list/answer/openCount`. Rendered by CLI (`dome inspect questions` / `dome answer <key> <value>`) and MCP (`dome.questions.list` / `dome.questions.answer`) in Phase 4h. Long-term UX is conversational ("agent surfaces open questions in chat at session start" — see AGENTS.md template additions in Phase 4k).

5. **Operational substrate maintenance uses direct CLI verbs** — `dome outbox retry/abandon/retry-by-capability`, `dome quarantine reset/list`, `dome runs fail`. Small closed set; engine-owned; not bundle-extensible. Probes in `dome.health` emit `DiagnosticEffect`s pointing at the relevant verb when substrate gets stuck.

The earlier proposals (new Effect kind / engine-internal handler registry / `engine.substrate-mutate` capability tier with typed ProcessorContext handles) were all rejected. They tried to squeeze mechanical engine self-maintenance into the question-answer flow that was actually designed for content decisions; the resulting complexity didn't earn its keep.

**E. Signal pub/sub mechanism — sync or async.** *Decidable by me.*

Sync: when the engine emits a signal, immediately invoke matching processors. Async: enqueue the signal and fire on next garden tick.

**Proposal: async.** Keeps the engine's hot path (adoption + broker) from being held by garden work. Matches the existing "garden is async by design" framing in [[wiki/specs/processors]] §"Garden phase". Signal emission becomes a non-blocking enqueue; the garden runner drains the signal queue alongside its other work.

**F. `dome answer` question-id shape.** *Decidable by me.*

Today the spec just says `<question-id>`. Options: raw row id (integer), idempotency-key (string, stable), fuzzy text match.

**Proposal: idempotency-key.** Stable, human-typable, already on the row per [[wiki/specs/effects]] §"QuestionEffect". Surfaced via `dome inspect questions` so users can copy-paste. Avoids the brittleness of integer row ids (which differ across vaults) and the ambiguity of fuzzy text match.

### Phased implementation plan

Ten phases. Each is reviewable in isolation; some parallelizable.

#### Phase 4a — Garden-phase runner (foundation)

**Scope:** Implement `gardenRunner` in `src/processors/runtime.ts` mirroring `adoptionRunner`. Garden runs *after* adoption completes, processing signal-triggered + path-triggered garden processors. Effects route via `applyEffect` with `phase: "garden"`. PatchEffects emitted from garden become sub-Proposals via [[wiki/specs/proposals]] §"Garden-emitted Proposals" (the engine constructs a new Proposal and routes through adoption).

**Code locations:**
- `src/processors/runtime.ts` — add `gardenRunner` function + tests for trigger matching, exception synthesis, context wiring (mirror existing `adoptionRunner` tests).
- `src/engine/garden.ts` (new) — the orchestrator: invoked after `adopt()` returns `adopted: true`, walks garden processors, dispatches matching ones, routes sub-Proposals back through the adoption loop.
- `src/engine/adopt.ts` — hook in garden invocation at the adoption-success path. Behind a runtime flag initially to keep regression-test surface controlled.
- Wire from `dome serve`'s poll loop + `dome sync`'s one-shot path.

**Tests:**
- Garden processor with `signal: file.created` trigger fires after adoption; emitted FactEffect lands in `projection.db.facts`.
- Garden-emitted PatchEffect becomes a new Proposal that runs through adoption (recursive case; bounded by sub-Proposal depth cap to prevent infinite cascades).
- Garden run failure is ledgered with `status: "failed"`; doesn't affect already-adopted state per [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]].
- Adoption + garden sequence has correct ledger ordering (adoption RunRecords precede garden RunRecords).

**Risks:**
- **Sub-Proposal cascades.** A garden processor emits a patch that triggers another garden processor that emits a patch... need a depth cap (default 10), diagnostic on cap-hit. Mirror the fixed-point divergence pattern from [[wiki/gotchas/processor-fixed-point-divergence]].
- **Concurrency between back-to-back garden runs.** v1 single-user scope keeps this simple (serialize via the runtime queue).

**Substrate updates:** [[wiki/specs/processors]] §"Garden phase" implementation-status; the deferred markers from [[wiki/specs/cli]] §"dome serve" garden-phase wiring.

**Estimate:** ~5 days focused work including tests + substrate updates.

#### Phase 4b — View-phase runner (parallel to 4a)

**Scope:** Implement `viewRunner` for command + schedule triggered processors. Returns ViewEffect to caller; rejects mutation effects with `phase-mismatch` diagnostic per [[wiki/matrices/effect-router-targets]]. Wire to `AbstractSurface.commands.<name>.invoke(args)`.

**Code locations:**
- `src/processors/runtime.ts` — `viewRunner`.
- `src/engine/surface.ts` (likely new) or extension to vault-runtime — implement `AbstractSurface.commands` registry built from loaded bundles' view-phase command-triggered processors.
- Wire `dome lint` (existing bundle) to route through the runner. Today its `dome.lint.markdown-format` processor is registered but never fires.

**Tests:**
- `vault.commands["lint"].invoke({})` runs `dome.lint.markdown-format` and returns ViewEffect.
- A view-phase processor emitting PatchEffect is rejected with phase-mismatch diagnostic.
- Multiple bundles registering command-triggered processors with the same name = `cli-command-collision` bundle-load error per [[wiki/specs/sdk-surface]] §"Bundle-loader error taxonomy".

**Substrate updates:** [[wiki/specs/processors]] §"View phase"; remove "deferred to Phase 4+" markers.

**Estimate:** ~3 days. Smaller than 4a because the contract is simpler (no sub-Proposal recursion).

#### Phase 4c — Scheduler

**Scope:** Wire `schedule:` triggers. Reads `projection.db.schedule_cursors`, fires due processors, updates `last_fire = now` with the at-most-once-per-sync clamp from [[wiki/gotchas/scheduled-hook-idempotency]].

**Code locations:**
- `src/engine/scheduler.ts` (new) — `findDue(processors, now)`, `updateCursor(processorId, now)`. Use `cron-parser` npm package (small, vetted, no AI/MCP dependencies — preserves [[wiki/invariants/ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY]]).
- Hook into `dome serve` poll loop tick + `dome sync` post-adoption.
- Schedule-triggered processors dispatch via `gardenRunner` or `viewRunner` depending on phase per the matrix at [[wiki/matrices/processor-phase-x-trigger]].

**Tests:**
- A garden processor with `schedule: "0 * * * *"` fires when an hour has passed since `last_fire`.
- Missed intervals collapse: if 3 hours passed but only one tick, only one fire (the at-most-once-per-sync rule).
- New processor (no cursor row) fires on first sync.
- Removed processor → stale cursor is cleaned up (or ignored — gentler default).

**Depends on:** 4a (garden schedule processors) and 4b (view schedule processors).

**Substrate updates:** [[wiki/specs/projection-store]] §"`schedule_cursors`" — remove deferral notes.

**Estimate:** ~3 days.

#### Phase 4d — Engine signal pub/sub + `answer` trigger kind

**Scope:** Engine event bus that emits typed signals at structural locations; processors with `signal: "engine.<name>"` triggers fire on matching emissions per design decision (A). **Also adds the new `answer` trigger kind** for the symmetric question-answer handler pattern per design decision (D).

**Code locations:**
- `src/engine/signals.ts` (new) — typed signal emission API. Async enqueue per decision (E).
- Touch points that emit:
  - `src/engine/adopt.ts` — `engine.adoption.blocked`, `engine.fixed-point.divergence`, `engine.adoption.adopted`.
  - `src/outbox/dispatch.ts` — `engine.outbox.dispatch-failed` (per attempt), `engine.outbox.terminal-failure` (status → failed).
  - `src/engine/vault-runtime.ts` — `engine.openVault`, `engine.processor-quarantined` (when quarantine triggers).
- Extend `Signal` literal-union in `src/core/processor.ts` per decision (A).
- Update `triggers.ts:matchTriggers` to dispatch by prefix (`file.*` vs `engine.*`).
- Validator at bundle load: reject `signal: "engine.<name>"` if name doesn't match a known engine signal.
- **Extend `Trigger` union with `answer` kind** per decision (D). Triggered when a user answer matches `codePrefix`. Carries `ctx.input = { kind: "answer", question, answer }`.
- Update `triggers.ts` to match `answer` triggers against incoming answers (separate from signal triggers).

**Tests:**
- An outbox row going to `status: "failed"` emits `engine.outbox.terminal-failure`; a processor with that signal trigger fires.
- An adoption block emits `engine.adoption.blocked`; a processor reacts.
- Unknown engine signal name in a manifest → bundle-load failure with clear error.
- A processor with `answer` trigger declaring `codePrefix: "intake."` fires when an answer to question code `intake.disambig` lands. Receives the question + answer in `ctx.input`.
- Invalid codePrefix (e.g., empty, or with whitespace) → bundle-load failure.

**Depends on:** 4a.

**Substrate updates:** [[wiki/specs/processors]] §"Triggers and signals" — extend the `Signal` shape + add the `answer` trigger kind; new gotcha/matrix row for engine signals; update [[wiki/matrices/processor-phase-x-trigger]] to add the `answer` column (allowed in garden phase only — answers always trigger async resolution work).

**Estimate:** ~4 days (was 3; added the `answer` trigger kind).

#### Phase 4e — JobEffect routing

**Scope:** Implement the `scheduled_jobs` table read/write + the in-memory dispatcher per [[wiki/specs/effects]] §"JobEffect".

**Code locations:**
- `src/engine/jobs.ts` (new) — `enqueueJob`, `dequeueDue`, `markRunning`, `markSucceeded`, `markFailed` (mirror the outbox shape at `src/outbox/dispatch.ts`).
- `src/engine/apply-effect.ts` — route `JobEffect` to `enqueueJob`.
- The dispatcher fires due jobs as garden-phase invocations of the named processor.

**Tests:**
- A garden processor emitting `JobEffect { processorId: "x.y", runAfter: T+5min }` produces a `scheduled_jobs` row; the engine fires it at T+5min.
- Failed jobs retry with exponential backoff up to `maxAttempts`.
- Job idempotency-key deduplicates re-emissions.

**Depends on:** 4a (jobs run as garden work).

**Substrate updates:** [[wiki/specs/effects]] §"JobEffect" — remove deferred markers; document the implemented contract.

**Estimate:** ~3 days.

#### Phase 4f — Outbox dispatcher loop

**Scope:** The daemon loop that polls `outbox.db` for `pending` rows and fires them via registered external-handlers. The dispatch *functions* exist in `src/outbox/dispatch.ts`; the loop that calls them on a cadence does not.

**Code locations:**
- `src/outbox/dispatcher-loop.ts` (likely new). Poll-based, like the daemon's adoption polling. Configurable interval (default 5s).
- Hook into `dome serve`.

**Tests:**
- `ExternalActionEffect` emitted → `outbox` row inserted with `status: "pending"` → dispatcher fires registered handler → row transitions to `sent`.
- Handler failure → row retries with exponential backoff → terminal failure → `status: "failed"` → emits `engine.outbox.terminal-failure` (Phase 4d signal).

**Depends on:** 4d (for the terminal-failure signal emission).

**Substrate updates:** [[wiki/specs/projection-store]] §"Outbox" lifecycle — clarify dispatcher cadence.

**Estimate:** ~3 days, less if skeleton exists.

#### Phase 4g — `drainProcessors()` API

**Scope:** Make `vault.drainProcessors()` actually idempotent + comprehensive per [[wiki/specs/sdk-surface]] §"Vault surface" / [[wiki/gotchas/async-read-after-write-staleness]] §"Structural mitigation". Awaits all in-flight work.

**Code locations:**
- `src/engine/vault-runtime.ts` — `drainProcessors()`: await garden queue empty + scheduled-jobs in-flight completion + outbox in-flight dispatches.

**Tests:**
- Submit a Proposal that emits garden work; `drainProcessors()` blocks until garden completes.
- Idempotent: calling twice in succession produces no error.

**Depends on:** 4a + 4c + 4e + 4f.

**Estimate:** ~1 day.

#### Phase 4h — `AbstractSurface.questions` operations (CLI + MCP)

**Scope:** Question / answer is a first-class `AbstractSurface` operation, rendered by both CLI and MCP in this phase. Long-term it also renders to HTTP (v2), voice (v2), mobile (v2), and is the surface an agent uses to surface pending questions in conversation per the AGENTS.md template additions in Phase 4k.

**The AbstractSurface contract:**

```ts
interface AbstractSurface {
  // ...existing
  readonly questions: {
    list(filter?: QuestionFilter): Promise<QuestionEffect[]>;
    answer(idempotencyKey: string, value: string): Promise<AnswerResult>;
    openCount(): Promise<number>;  // for the "blocking gardening" metric
  };
}
```

**Code locations:**
- `src/engine/surface.ts` (or extension to vault-runtime) — implement `surface.questions.list/answer/openCount` against `projection.db.questions`. `answer()` writes `answered_at` + `answer`, then emits `engine.question.answered` via Phase 4d.
- `src/cli/commands/answer.ts` (new) — thin renderer over `surface.questions.answer()`. Accepts `<question-id> [<value>]`; resolves question-id (idempotency-key per decision F). Replaces the v1.0 stub at the current `src/cli/commands/answer.ts` location (no `--repair`-style flag work).
- `src/cli/index.ts` — register the `answer` case.
- `src/projections/questions.ts` — add `recordAnswer(db, opts)` if not present.
- **MCP renderer in `src/protocols/mcp/`** — register two new tools:
  - `dome.questions.list` — wraps `surface.questions.list()`.
  - `dome.questions.answer` — wraps `surface.questions.answer()`.
  - Both consume the same underlying engine path as the CLI renderer.

**Tests:**
- CLI: `dome answer <key> retry` → row updated → signal fires → matching `answer` trigger (Phase 4d) fires.
- MCP: `dome.questions.answer({ idempotencyKey, value })` → same engine path → same signal → same trigger.
- Both renderers produce identical effects (test via SurfaceFixture that swaps the renderer but reuses the engine).
- Unknown question-id: error result (CLI: 64 exit; MCP: structured error).
- Already-answered question: error result with clear message.
- `surface.questions.openCount()` returns the right number after answer + after garden-phase resolution.

**Depends on:** 4d (for the `answer` trigger kind + signal pub/sub), 4b (for `AbstractSurface` substrate from view runner work).

**Substrate updates:**
- [[wiki/specs/cli]] §"dome answer" — remove reserved-for-v1.x markers; lock in the question-id shape (idempotency-key per decision F).
- [[wiki/specs/mcp-surface]] — add the two new tools; clarify "question/answer writes" are not vault writes (they're operational signals; the resulting Effects still go through the broker).
- [[wiki/matrices/protocol-adapter]] — new row for "Resolve question" mapping `surface.questions.answer` to its per-protocol renderers.

**Estimate:** ~3 days (was 2; added MCP renderer + AbstractSurface lifting).

#### Phase 4i — Operational substrate CLI verbs

**Scope:** Per design decision (D), operational substrate maintenance ships as a small closed set of CLI verbs — engine-owned, not bundle-extensible. These replace the pre-recut admin flags (`--outbox-replay`, `--reset-quarantined-processors`, etc.) that the recut retired.

The set is **closed and engine-owned** because operational substrate is engine-owned. A third-party bundle that wants its own substrate-mutation pattern (rare; usually an anti-pattern) would need to merge code into the engine.

**Verbs (each a top-level command):**
- `dome outbox retry <key>` — reset a failed row to pending (calls `outbox.replayFailed`).
- `dome outbox abandon <key>` — mark a failed row abandoned (calls `outbox.markAbandoned`).
- `dome outbox retry-by-capability <cap>` — bulk retry every failed row for a capability (after a credential rotation, etc.).
- `dome quarantine reset <processor-id>` — clear quarantine state for a specific processor.
- `dome quarantine list` — list currently-quarantined processors.
- `dome runs fail <run-id>` — manually transition an orphan run to failed (the engine-asks framing for orphan-run recovery).

**Code locations:**
- `src/cli/commands/outbox.ts` (new) — subcommand router for `retry`, `abandon`, `retry-by-capability`. Wraps existing `outbox.replayFailed` / `outbox.markAbandoned` functions; writes a `RunRecord` per invocation for audit.
- `src/cli/commands/quarantine.ts` (new) — subcommand router for `reset`, `list`. Wraps existing quarantine-store helpers.
- `src/cli/commands/runs.ts` (new) — subcommand router for `fail`. Wraps `runs.failOrphaned`.
- `src/cli/index.ts` — register the three new top-level commands.
- `src/cli/help.ts` — extend usage with the new verbs.

**Tests:**
- `dome outbox retry <key>` resets the row and writes a RunRecord with `processor_id: "cli.outbox.retry"`.
- `dome outbox retry-by-capability calendar.write` resets every failed row matching the capability; single RunRecord per row.
- `dome quarantine reset <id>` clears the quarantined.json entry.
- Each verb returns 64 (EX_USAGE) on missing required args.
- The audit trail is visible via `dome inspect runs --processor cli.outbox.*`.

**Depends on:** none (these wrap existing functions; no engine work required).

**Substrate updates:**
- [[wiki/specs/cli]] — add §"dome outbox", §"dome quarantine", §"dome runs" sections.
- Update gotchas: [[wiki/gotchas/outbox-stuck]] — the recovery flow names these verbs explicitly (replaces the engine-asks-model framing from the recut).
- Update [[wiki/invariants/INBOX_IS_EPHEMERAL]] — the quarantine-recovery flow uses `dome quarantine reset` instead of the engine-asks model.
- Update [[wiki/specs/projection-store]] §"Outbox" lifecycle — point at the verbs.
- Update [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]] — orphan-run recovery uses `dome runs fail` instead of the engine-asks model.

**Estimate:** ~2 days (thin wrappers; the existing functions do the work).

#### Phase 4j — `dome.health` bundle (probe-only)

**Scope:** Probe-only bundle that detects stuck operational substrate and surfaces it via DiagnosticEffects. The diagnostics name the recovery verb so the user knows what to run. **No question-answer handlers** — those collapsed into direct CLI verbs in Phase 4i.

**Four processors:**

- **`dome.health.detect-outbox-failure`** — garden, `signal: engine.outbox.terminal-failure`. Emits a `DiagnosticEffect`:
  ```
  severity: warning
  code: dome.health.outbox-failure
  message: "Outbox dispatch failed terminally for <capability>/<key>: <last error>.
            Recover with: `dome outbox retry <key>` or `dome outbox abandon <key>`."
  ```
- **`dome.health.detect-orphan-runs`** — garden, `schedule: "0 * * * *"` (hourly). Queries `runs.db` for rows stuck in `status: "running"` past a threshold; emits `DiagnosticEffect` per orphan with `message` pointing at `dome runs fail <id>`.
- **`dome.health.detect-quarantine`** — garden, `signal: engine.processor-quarantined`. Emits `DiagnosticEffect` pointing at `dome quarantine reset <processor-id>`.
- **`dome.health.render-report`** — view, `command: doctor`. Walks `projection.db.diagnostics` (the recent operational diagnostics) and `surface.questions.openCount()` (the blocked-gardening metric); returns `ViewEffect` with an assembled report.

**Code locations:**
- `assets/extensions/dome.health/manifest.yaml`
- `assets/extensions/dome.health/processors/*.ts` — four processors per above.
- `assets/extensions/dome.health/preamble.md` — bundle conventions for AGENTS.md per [[wiki/matrices/extension-bundle-shape]]. Teaches the agent: "if `dome inspect diagnostics` surfaces a `dome.health.*` code, surface the recovery verb to the user."
- Wire `dome doctor` to invoke `dome.health.render-report` (replace the v1.0 stub in `src/cli/commands/doctor.ts`).

**Tests:**
- End-to-end: outbox dispatch fails 3× → engine emits terminal-failure → `detect-outbox-failure` emits a Diagnostic visible via `dome inspect diagnostics` → user runs `dome outbox retry <key>` → row transitions to `pending` → next dispatch succeeds (clears the diagnostic).
- Orphan-run flow: cron fires `detect-orphan-runs` → finds stuck row → emits diagnostic → user runs `dome runs fail <id>` → next probe sees no orphans → diagnostic resolves.
- Doctor verb: `dome doctor` invokes the render-report processor, prints the assembled view of diagnostics + open-question count + blocked-gardening summary.

**Depends on:** 4a (garden runner), 4b (view runner), 4c (scheduler), 4d (engine signals). **Does NOT depend on 4h or 4i** — the probes emit Diagnostics; recovery happens via the CLI verbs from 4i (which are independent).

**Substrate updates:**
- [[wiki/specs/cli]] §"dome doctor" — remove reserved-for-v1.x markers.
- [[wiki/matrices/built-in-extensions-x-phase]] — new row for `dome.health`.
- [[wiki/specs/processors]] §"First-party processors" — add `dome.health` row.

**Estimate:** ~3 days (was 4; one fewer processor, simpler semantics, no end-to-end answer-handler integration to test).

#### Phase 4k — Substrate polish + new invariants

**Scope:** Pick up everything we promised but didn't ship inline. The substrate-doc-first discipline of earlier phases will catch most of it; this phase is the sweep for what's left.

**Includes:**

*New substrate docs:*
- New `docs/wiki/concepts/processor-class.md` — names the implicit pure / model-backed / external dimension (load-bearing for capability declarations across all the new bundles).
- New `docs/wiki/matrices/processor-class-x-phase.md` — pins "adoption ⇒ pure" as a matrix row.
- New `docs/wiki/gotchas/sub-proposal-cascade.md` (from Phase 4a risk) — the depth-cap gotcha.

*New invariants:*
- New `docs/wiki/invariants/OPEN_QUESTIONS_DO_NOT_BLOCK.md` *(shipped default)*. Statement: open questions in `projection.db.questions` never block other processor invocations. A processor that emits a QuestionEffect completes its invocation; the question is durable state, not a held lock. Sibling processors, new triggers, scheduled work, and adoption all proceed unaffected. The only suspended unit is the specific work that asked, which resumes via the `answer` trigger when the user replies. Pinned by `tests/invariants/open-questions-do-not-block.test.ts` — fixture vault with an open question + concurrent garden work; asserts sibling processors fire and complete while the question stays pending. Specifically asserts `drainProcessors()` returns while questions are open (drain awaits machine work, not human work).

*AGENTS.md template additions* (so the agent surfaces pending questions in conversation per the long-term UX vision):
- Update `src/cli/commands/init.ts` AGENTS.md template to include a new section:
  ```markdown
  ## Pending questions

  At session start, check pending questions via `dome inspect questions
  --json` (or the `dome.questions.list` MCP tool if mounted). If there
  are open questions, mention them to the user alongside whatever else
  you're doing — they represent garden work blocked waiting on a
  decision the user is best placed to make.

  When the user replies, translate the response to a structured answer
  and submit via `dome answer <key> <value>` (or the
  `dome.questions.answer` MCP tool).
  ```
- Lockstep test ensuring the section is present in the templated portion of every newly-init'd vault per [[wiki/invariants/AGENTS_MD_IS_ORIENTATION_SURFACE]].

*Cleanups:*
- [[wiki/specs/processors]] §"Idempotency" — name the per-class idempotency contracts.
- [[wiki/specs/cli]] — remove every remaining "reserved for v1.x" marker now that they ship.
- Convert the design-evolution note from this doc into a [[cohesive/delta-ledgers/2026-05-28-v1-engine-completion]] entry capturing the design pivots for the historical record.

**Estimate:** ~3 days substrate polish (was 2; added AGENTS.md template work + new invariant).

### Sequencing graph

```
                                  ┌─────────────────┐
                                  │ 4a Garden runner│
                                  │ (foundation)    │
                                  └────────┬────────┘
                                           │
              ┌────────────────────────────┼─────────────────────────┐
              │                            │                         │
     ┌────────▼─────────┐         ┌────────▼────────┐       ┌────────▼────────┐
     │ 4b View runner   │         │ 4d Signal pub/  │       │ 4e JobEffect    │
     │ (parallel to 4a) │         │    sub          │       │    routing      │
     └────────┬─────────┘         └────────┬────────┘       └─────────────────┘
              │                            │
              └────────────┬───────────────┘
                           │
                  ┌────────▼────────┐
                  │ 4c Scheduler    │
                  │ (needs garden+  │
                  │  view runners)  │
                  └────────┬────────┘
                           │
                  ┌────────▼────────┐
                  │ 4f Outbox       │
                  │    dispatcher   │
                  └────────┬────────┘
                           │
                  ┌────────▼────────┐
                  │ 4g drainPro-    │
                  │    cessors      │
                  └────────┬────────┘
                           │
                  ┌────────▼────────┐
                  │ 4h Abstract-    │
                  │  Surface.       │
                  │  questions      │
                  │  (CLI + MCP)    │
                  └────────┬────────┘
                           │
              ┌────────────┼────────────┐
              │                         │
     ┌────────▼─────────┐      ┌────────▼─────────┐
     │ 4i Operational   │      │ 4j dome.health   │
     │  CLI verbs       │      │  bundle (probe-  │
     │  (independent)   │      │  only)           │
     └────────┬─────────┘      └────────┬─────────┘
              │                         │
              └────────────┬────────────┘
                           │
                  ┌────────▼────────┐
                  │ 4k Substrate    │
                  │  polish + new   │
                  │  invariants     │
                  └─────────────────┘
```

**Critical path:** 4a → 4c → 4f → 4g → 4h → 4k.
**Parallel-able:** 4b alongside 4a; 4d + 4e alongside 4a; 4i and 4j alongside each other (both depend on the earlier phases but are independent of each other since 4j is probe-only now).

### Effort estimate

| Phase | Days | Δ from original |
|---|---|---|
| 4a Garden-phase runner | 5 | — |
| 4b View-phase runner | 3 | — |
| 4c Scheduler | 3 | — |
| 4d Signal pub/sub + `answer` trigger kind | 4 | +1 |
| 4e JobEffect routing | 3 | — |
| 4f Outbox dispatcher loop | 3 | — |
| 4g `drainProcessors()` API | 1 | — |
| 4h `AbstractSurface.questions` (CLI + MCP) | 3 | +1 (MCP + AbstractSurface lifting) |
| 4i Operational CLI verbs | 2 | −1 (collapsed from substrate-mutate channel) |
| 4j `dome.health` bundle (probe-only) | 3 | −1 (one fewer processor) |
| 4k Substrate polish + new invariants | 3 | +1 (AGENTS.md template + invariant) |
| **Total** | **~33 days focused work** | +1 net |

Real calendar time depends on review velocity + how often Phase-12-style work lands concurrently (this estimate doesn't include rebase/merge-conflict tax).

### Open scope questions

All originally-listed design decisions have settled (see Design Evolution note at top of doc + the Design Decisions section). The remaining process questions:

1. ~~**Design decision (D) — substrate-mutation channel.**~~ **Resolved 2026-05-28.** Question / answer is for content decisions with bundle-driven symmetric handlers (new `answer` trigger kind, multi-surface via AbstractSurface). Operational substrate uses direct CLI verbs. See Phase 4d + 4h + 4i.

2. **One PR per phase, or one PR end-to-end?** **Resolved: one PR end-to-end** per owner direction 2026-05-28. Will involve a thorough self-review pass at the end to verify cohesion + robustness + completeness before merge.

3. **Substrate-doc-first or code-first per phase?** Recommend **substrate-doc-first per phase**, given the AGENTS.md directive "Read the substrate before changing code." Each phase opens with a spec update naming what shipped + what changed; the code follows.

### Recommended starting move

Per owner direction (2026-05-28): **one end-to-end PR** rather than one per phase. The work happens in a fresh worktree (`.claude/worktrees/v1-engine-completion` per the harness convention from `~/.claude/CLAUDE.md`). The flow:

1. **Phase-by-phase implementation in the worktree**, substrate-doc-first per phase per process Q3. Each phase's commits land on the branch; the branch grows linearly through Phase 4a → 4b → 4d → ... → 4k.
2. **Thorough self-review pass at the end** before opening the PR — verifies cohesion + robustness + completeness across all phases. Cross-checks every substrate update against the code, every test against the spec, every closed gotcha against the new behavior. Catches what slipped between phases.
3. **Open the end-to-end PR**; review pass; merge.

Phase 4a alone unblocks every garden-phase processor across every shipped + future bundle. It's the highest-leverage single piece in the bucket; everything stacks on it. The end-to-end PR approach means each subsequent phase can reference and verify against the prior phases' work in-tree rather than waiting for separate merges.

**Self-review checklist (to be expanded as phases land):**
- [ ] Every spec update reflects what actually shipped (no aspirational language).
- [ ] Every test in the phase's plan is implemented and passing.
- [ ] The `OPEN_QUESTIONS_DO_NOT_BLOCK` invariant is structurally enforced.
- [ ] `drainProcessors()` returns cleanly with open questions outstanding.
- [ ] Bundle-load failures surface clear diagnostics.
- [ ] Sub-Proposal cascades respect the depth cap.
- [ ] All retired `dome doctor --<flag>` admin flags are removed from substrate (no leftover references).
- [ ] AGENTS.md template includes the pending-questions section.
- [ ] MCP `dome.questions.list/answer` tools route through `AbstractSurface.questions.*` (same engine path as the CLI).
- [ ] `dome inspect diagnostics` + `dome doctor` both render the new `dome.health.*` diagnostics with their recovery-verb hints.
- [ ] No leftover scaffolding or commented-out code.
- [ ] Existing tests (303 from main) still pass alongside the new phase-specific tests.

### Risks and unknowns

- **Bun.sqlite quirks under concurrent garden + adoption.** Need to verify the existing handle-sharing model holds when garden runs are async. Phase 4a tests should exercise this.
- **`cron-parser` license + size.** Confirm acceptable before pulling. Alternatives: hand-rolled minimal cron (the cases dome supports are narrow — once-daily / once-hourly / once-weekly).
- **Signal-trigger naming collision** if a bundle's processor declares `signal: "engine.outbox.terminal-failure"` and the engine renames the signal. Mitigation: lockstep test pinning every emitted signal name to a canonical constant — matches the [[wiki/invariants/AGENTS_MD_IS_ORIENTATION_SURFACE]] delimiter-lockstep pattern.
- **Cascading sub-Proposals** (Phase 4a risk above). Depth cap is the structural fence; need to pick the default carefully.
- **Test determinism for the scheduler.** Probably need a clock-injection seam in `src/engine/scheduler.ts` so tests can fast-forward without sleeping.

### Related substrate

*Specs touched by multiple phases:*
- [[wiki/specs/processors]] — every phase touches this; adds `answer` trigger kind, engine signals, garden + view phase status
- [[wiki/specs/effects]] — JobEffect, QuestionEffect, ExternalActionEffect routing (no new kinds added; closed taxonomy preserved)
- [[wiki/specs/adoption]] — where garden hooks into the adoption-success path
- [[wiki/specs/projection-store]] — `schedule_cursors`, `scheduled_jobs`, `questions` tables
- [[wiki/specs/cli]] — `dome answer`, `dome doctor`, `dome outbox/quarantine/runs` verbs, `dome wait` (future)
- [[wiki/specs/mcp-surface]] — new `dome.questions.list/answer` tools (Phase 4h)
- [[wiki/specs/sdk-surface]] — new `AbstractSurface.questions.*` operations

*New substrate to be added:*
- New invariant `OPEN_QUESTIONS_DO_NOT_BLOCK` (Phase 4k) — *shipped default*
- New concept doc `processor-class.md` (Phase 4k) — pure / model-backed / external
- New matrix `processor-class-x-phase.md` (Phase 4k) — pins "adoption ⇒ pure"
- New gotcha `sub-proposal-cascade.md` (Phase 4k) — from Phase 4a risk
- New delta-ledger `2026-05-28-v1-engine-completion.md` (Phase 4k) — captures the design pivots for historical record

*Gotchas referenced:*
- [[wiki/gotchas/scheduled-hook-idempotency]] — at-most-once-per-sync clamp
- [[wiki/gotchas/processor-fixed-point-divergence]] — cascade-cap pattern to mirror for sub-Proposals
- [[wiki/gotchas/async-read-after-write-staleness]] — `drainProcessors()` callers
- [[wiki/gotchas/outbox-stuck]] — recovery flow names the new CLI verbs from Phase 4i

*Matrices touched:*
- [[wiki/matrices/processor-phase-x-trigger]] — every cell becomes load-bearing for the first time; adds new `answer` row
- [[wiki/matrices/effect-router-targets]] — view/garden columns are documented but not implemented today; this work implements them
- [[wiki/matrices/protocol-adapter]] — new row for "Resolve question" mapping `surface.questions.answer` to per-protocol renderers
- [[wiki/matrices/built-in-extensions-x-phase]] — new row for `dome.health`
