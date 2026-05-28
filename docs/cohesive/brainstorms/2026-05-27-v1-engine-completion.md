# Brainstorm — Completing the v1 engine: runners + supporting infrastructure

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

**D. Answer-handler substrate-mutation channel.** **★ Owner decision.**

The load-bearing design question. How does a Question being answered cause the substrate mutation (replay an outbox row, reset quarantine state, fail an orphan run) to fire? Three options:

- **(a) New 8th Effect kind (`OperationalEffect`).** Answer-handlers emit an Effect carrying `{ kind: "operational", op: "outbox.replay", key: "..." }`; the engine routes it through `apply-effect.ts`. Pros: stays inside the Effect taxonomy. Cons: breaks the closed 7-kind promise; [[wiki/specs/effects]] §"Why a closed taxonomy" explicitly says new kinds are design moves.
- **(b) Engine-internal registry of `(question.code → handler)` mappings.** Bundles register handlers via manifest; engine subscribes to `engine.question.answered` and dispatches. Bypasses the processor model for this narrow case. Pros: simple. Cons: creates a parallel control path that doesn't go through the broker, the run ledger, or capability enforcement.
- **(c) Answer-handlers are garden-phase processors** with `signal: "engine.question.answered"` triggers + a **new capability tier** `engine.substrate-mutate` (granular sub-grants like `outbox.replay`, `outbox.abandon`, `quarantine.reset`, `runs.fail`). The broker enforces. ProcessorContext exposes typed handles (`ctx.outbox.replay(key)`) gated by the granted capability.

**Recommendation: (c).** Preserves "every behavior is a processor." Adds one capability tier; no new Effect kind. Broker enforcement uniformity is preserved. The cost is the new capability tier — a substrate addition, not a contract break. This needs to settle before Phase 4i.

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

#### Phase 4d — Engine signal pub/sub

**Scope:** Engine event bus that emits typed signals at structural locations; processors with `signal: "engine.<name>"` triggers fire on matching emissions per design decision (A).

**Code locations:**
- `src/engine/signals.ts` (new) — typed signal emission API. Async enqueue per decision (E).
- Touch points that emit:
  - `src/engine/adopt.ts` — `engine.adoption.blocked`, `engine.fixed-point.divergence`, `engine.adoption.adopted`.
  - `src/outbox/dispatch.ts` — `engine.outbox.dispatch-failed` (per attempt), `engine.outbox.terminal-failure` (status → failed).
  - `src/engine/vault-runtime.ts` — `engine.openVault`, `engine.processor-quarantined` (when quarantine triggers).
- Extend `Signal` literal-union in `src/core/processor.ts` per decision (A).
- Update `triggers.ts:matchTriggers` to dispatch by prefix (`file.*` vs `engine.*`).
- Validator at bundle load: reject `signal: "engine.<name>"` if name doesn't match a known engine signal.

**Tests:**
- An outbox row going to `status: "failed"` emits `engine.outbox.terminal-failure`; a processor with that signal trigger fires.
- An adoption block emits `engine.adoption.blocked`; a processor reacts.
- Unknown engine signal name in a manifest → bundle-load failure with clear error.

**Depends on:** 4a.

**Substrate updates:** [[wiki/specs/processors]] §"Triggers and signals" — extend the `Signal` shape; new gotcha/matrix row for engine signals.

**Estimate:** ~3 days.

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

#### Phase 4h — `dome answer` + question.answered signal

**Scope:** Replace the [[wiki/specs/cli]] §"dome answer" stub with real impl + emit signal on answer per [[wiki/specs/effects]] §"QuestionEffect" §"When the user answers".

**Code locations:**
- `src/cli/commands/answer.ts` (new) — accepts `<question-id> [<value>]`; resolves question-id (idempotency-key per decision F); writes `answered_at` + `answer` to `projection.db.questions`; emits `engine.question.answered` via Phase 4d.
- `src/cli/index.ts` — register the `answer` case (currently absent).
- `src/projections/questions.ts` — add `recordAnswer(db, opts)` if not present.

**Tests:**
- `dome answer <key> retry` updates the row, fires the signal, a processor subscribed to the signal observes the answer.
- Unknown question-id: 64 exit code with helpful error.
- Already-answered question: error (or replace, depending on policy — open Q).

**Depends on:** 4d.

**Substrate updates:** [[wiki/specs/cli]] §"dome answer" — remove reserved-for-v1.x markers; lock in the question-id shape.

**Estimate:** ~2 days.

#### Phase 4i — Answer-handler substrate-mutation channel

**Scope:** Per design decision (D) option (c). New capability tier `engine.substrate-mutate` with sub-grants. ProcessorContext exposes typed handles for granted operations. Broker enforces at the boundary.

**Code locations:**
- `src/capabilities/index.ts` — declare the new tier + sub-grants (`outbox.replay`, `outbox.abandon`, `quarantine.reset`, `runs.fail`).
- `src/engine/capability-broker.ts` — enforce on the typed handles.
- `src/core/processor.ts` — extend `ProcessorContext` with optional `outbox`, `quarantine`, `runs` mutation handles (typed; present only when capability granted).
- `docs/wiki/specs/capabilities.md` — substrate update for the new tier.

**Tests:**
- A garden processor with the right grant can call `ctx.outbox.replay(key)`.
- Without the grant, the call fails with a capability-deny diagnostic.
- A processor that declares the grant but the vault config doesn't grant it gets downgrade/deny diagnostics on attempt per [[wiki/gotchas/capability-downgrade-surprise]].

**Depends on:** 4d + 4h.

**Substrate updates:** [[wiki/specs/capabilities]] §"Capability tiers" — new row; [[wiki/matrices/effect-x-capability]] — new column for substrate-mutate.

**Estimate:** ~3 days (the capability work is the bulk).

#### Phase 4j — `dome.health` bundle

**Scope:** Now the bundle actually works. Five processors:

- **`dome.health.detect-outbox-failure`** — garden, `signal: engine.outbox.terminal-failure`, emits `QuestionEffect` with options `["retry", "abandon", "wait"]`.
- **`dome.health.detect-orphan-runs`** — garden, `schedule: "0 * * * *"` (hourly), queries `runs.db`, emits diagnostics + Questions for stuck rows.
- **`dome.health.detect-quarantine`** — garden, `signal: engine.processor-quarantined`, emits Question with options `["reset", "keep", "uninstall"]`.
- **`dome.health.handle-answer`** — garden, `signal: engine.question.answered`, dispatches per question code (calls `ctx.outbox.replay(key)`, `ctx.outbox.abandon(key)`, `ctx.quarantine.reset()`, `ctx.runs.fail(id)`).
- **`dome.health.render-report`** — view, `command: doctor`, walks `projection.db.diagnostics` + `projection.db.questions`, returns ViewEffect with the assembled health report.

**Code locations:**
- `assets/extensions/dome.health/manifest.yaml`
- `assets/extensions/dome.health/processors/*.ts`
- `assets/extensions/dome.health/preamble.md` — bundle conventions for AGENTS.md per [[wiki/matrices/extension-bundle-shape]]
- Wire `dome doctor` to invoke `dome.health.render-report` (replace the v1.0 stub in `src/cli/commands/doctor.ts`).

**Tests:**
- End-to-end: outbox dispatch fails 3× → engine emits terminal-failure → detect-outbox-failure emits a Question → user runs `dome answer <key> retry` → handle-answer invokes `ctx.outbox.replay(key)` → row transitions to `pending`.
- Doctor verb: `dome doctor` invokes the render-report processor, prints the assembled view of diagnostics + questions.

**Depends on:** 4a, 4b, 4c, 4d, 4h, 4i — basically everything before.

**Substrate updates:** [[wiki/specs/cli]] §"dome doctor" — remove reserved-for-v1.x markers; [[wiki/matrices/built-in-extensions-x-phase]] — new row for `dome.health`; [[wiki/specs/processors]] §"First-party processors" — add `dome.health` row.

**Estimate:** ~4 days.

#### Phase 4k — Substrate polish

**Scope:** Pick up everything we promised but didn't ship inline. The substrate-doc-first discipline of earlier phases will catch most of it; this phase is the sweep for what's left.

**Includes:**
- New `docs/wiki/concepts/processor-class.md` — names the implicit pure / model-backed / external dimension (we discussed this; it's now load-bearing for capability declarations across all the new bundles).
- New `wiki/matrices/processor-class-x-phase.md` — pins "adoption ⇒ pure" as a matrix row.
- [[wiki/specs/processors]] §"Idempotency" — name the per-class idempotency contracts.
- [[wiki/specs/cli]] — remove every remaining "reserved for v1.x" marker now that they ship.
- New `wiki/gotchas/sub-proposal-cascade.md` (from Phase 4a risk) — the depth-cap gotcha.

**Estimate:** ~2 days substrate polish.

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
                  │ 4h dome answer  │
                  │  + answered sig │
                  └────────┬────────┘
                           │
                  ┌────────▼────────┐
                  │ 4i Substrate-   │
                  │  mutate cap +   │
                  │  ProcessorCtx   │
                  └────────┬────────┘
                           │
                  ┌────────▼────────┐
                  │ 4j dome.health  │
                  │    bundle       │
                  └────────┬────────┘
                           │
                  ┌────────▼────────┐
                  │ 4k Substrate    │
                  │    polish       │
                  └─────────────────┘
```

**Critical path:** 4a → 4c → 4f → 4g → 4h → 4i → 4j → 4k.
**Parallel-able:** 4b alongside 4a; 4d + 4e alongside 4a.

### Effort estimate

| Phase | Days |
|---|---|
| 4a Garden-phase runner | 5 |
| 4b View-phase runner | 3 |
| 4c Scheduler | 3 |
| 4d Signal pub/sub | 3 |
| 4e JobEffect routing | 3 |
| 4f Outbox dispatcher loop | 3 |
| 4g `drainProcessors()` API | 1 |
| 4h `dome answer` + signal | 2 |
| 4i Substrate-mutate channel | 3 |
| 4j `dome.health` bundle | 4 |
| 4k Substrate polish | 2 |
| **Total** | **~32 days focused work** |

Real calendar time depends on review velocity + how often Phase-12-style work lands concurrently (this estimate doesn't include rebase/merge-conflict tax).

### Open scope questions

Before kicking off Phase 4a:

1. **Design decision (D) — substrate-mutation channel.** Confirm option (c) — new `engine.substrate-mutate` capability tier with typed handles on ProcessorContext. Or pick (a) or (b). **Blocks Phase 4i; only affects code after 4h.**

2. **One PR per phase, or one PR end-to-end?** Recommend **one PR per phase, stacked** (the Phase 12 precedent on main shows this is house style). Lets reviewers digest the work in chunks; catches issues phase-by-phase.

3. **Substrate-doc-first or code-first per phase?** Recommend **substrate-doc-first per phase**, given the AGENTS.md directive "Read the substrate before changing code." Each phase opens with a spec update naming what shipped + what changed; the code follows.

### Recommended starting move

Phase 4a in a fresh worktree (`.claude/worktrees/phase-4a-garden-runner` per the harness convention from `~/.claude/CLAUDE.md`). The flow:

1. Substrate update first: [[wiki/specs/processors]] §"Garden phase" implementation status, removing the deferral markers and naming what's about to ship.
2. Code: `gardenRunner` in `src/processors/runtime.ts` + `garden.ts` orchestrator + the wiring from `adopt()`.
3. Tests covering the four scenarios named in Phase 4a.
4. Open the PR; review pass; merge.
5. Move to Phase 4b (parallel) or Phase 4d (the next critical-path dep).

Phase 4a alone unblocks every garden-phase processor across every shipped + future bundle. It's the highest-leverage single piece in the bucket; everything stacks on it.

### Risks and unknowns

- **Bun.sqlite quirks under concurrent garden + adoption.** Need to verify the existing handle-sharing model holds when garden runs are async. Phase 4a tests should exercise this.
- **`cron-parser` license + size.** Confirm acceptable before pulling. Alternatives: hand-rolled minimal cron (the cases dome supports are narrow — once-daily / once-hourly / once-weekly).
- **Signal-trigger naming collision** if a bundle's processor declares `signal: "engine.outbox.terminal-failure"` and the engine renames the signal. Mitigation: lockstep test pinning every emitted signal name to a canonical constant — matches the [[wiki/invariants/AGENTS_MD_IS_ORIENTATION_SURFACE]] delimiter-lockstep pattern.
- **Cascading sub-Proposals** (Phase 4a risk above). Depth cap is the structural fence; need to pick the default carefully.
- **Test determinism for the scheduler.** Probably need a clock-injection seam in `src/engine/scheduler.ts` so tests can fast-forward without sleeping.

### Related substrate

- [[wiki/specs/processors]] — every phase touches this
- [[wiki/specs/effects]] — JobEffect, QuestionEffect, ExternalActionEffect routing
- [[wiki/specs/adoption]] — where garden hooks into the adoption-success path
- [[wiki/specs/projection-store]] — `schedule_cursors`, `scheduled_jobs`, `questions` tables
- [[wiki/specs/capabilities]] — new tier in Phase 4i
- [[wiki/specs/cli]] — `dome answer`, `dome doctor`, `dome wait` (future) surfaces
- [[wiki/gotchas/scheduled-hook-idempotency]] — at-most-once-per-sync clamp
- [[wiki/gotchas/processor-fixed-point-divergence]] — cascade-cap pattern to mirror for sub-Proposals
- [[wiki/gotchas/async-read-after-write-staleness]] — `drainProcessors()` callers
- [[wiki/matrices/processor-phase-x-trigger]] — every cell in this matrix becomes load-bearing for the first time
- [[wiki/matrices/effect-router-targets]] — view/garden columns are documented but not implemented today
- [[wiki/matrices/effect-x-capability]] — new column for substrate-mutate in Phase 4i
