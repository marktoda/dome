---
type: brainstorm
tags: [design, dome.agent, ingest, garden, reconciliation, eventual-consistency]
created: 2026-06-16
status: approved-design
---

# Inbox ingest as a level-triggered reconciler

Approved approach 2026-06-16 (owner: "targeted reconciler"). Goal stated by the
owner: *"dump stuff into the inbox and have it eventually ingested — robust,
clean, obviously correct."*

## Problem

`dome.agent.ingest` (garden phase) lifts captures from `inbox/raw/*.md` into
tasks. It is triggered ONLY by `file.created` / `document.changed` **signals**
on `inbox/raw/*.md`, and the garden phase fires each processor **at most once
per adoption** (no fixpoint loop; garden failures don't roll back adoption — the
adopted ref advances regardless). So ingest's one firing for a capture happens
in the garden phase of the adoption whose commit-range contains the capture's
commit.

If that single firing is missed — starved by garden churn (the render↔stamp
loop, since fixed), lost to the open serve-level garden-signal race, or crashed —
the work is **lost permanently**: once the adopted ref advances past the commit,
the signal is derived from `adopted..candidate` and is never regenerated, and
the file just sits inert in `inbox/raw/` producing no new delta. The only
"safety net", `dome.agent.inbox-stale-check`, merely emits an `inbox.stale`
warning diagnostic — it does not re-ingest. Observed live: a capture committed at
12:18 still un-ingested hours later, `adopted == HEAD`, zero recent ingest runs,
no open ingest question, budget healthy ($4.80 / $15 daily) — i.e. genuinely
dropped, not deferred.

### Root cause: edge-triggering a level-based need

A capture sitting in `inbox/raw/` is a **standing fact (a level)**, not an
**edge**. Edge-triggering a level is fragile by construction: miss the edge and
the work is lost. The clean dividing line among garden processors:

- **Derivation processors** (`render-facts`, `stamp`, `render-index`, …) compute
  an artifact *from* current state. Edge-triggering is fine — their inputs keep
  changing and any later edit re-triggers them; a missed run self-corrects on the
  next relevant commit.
- **Queue-consumer processors** (`ingest`) *consume and remove* items from a
  seam. A missed edge has **no natural re-trigger** — the item generates no new
  delta. These need **level-triggering**: act on the standing contents.

Tellingly, ingest's queue-consuming siblings are already level-triggered:
`dome.agent.consolidate` (`cron 0 2 * * *`) and `dome.agent.brief`
(`cron 30 5 * * *`) reconcile via `ctx.snapshot.listMarkdownFiles()`, not
`changedPaths`. Ingest is the lone consume-a-queue processor that is signal-only.

## Fix: ingest reconciles the standing inbox

Make ingest's behavior a pure function of the *standing* contents of
`inbox/raw/`, woken by two triggers that mean the same thing — "reconcile now":

- the existing **signals** (`file.created` / `document.changed` on
  `inbox/raw/*.md`) — the **prompt happy path** (ingest runs on the very next
  adoption tick after a capture is committed; latency is dominated by the
  capture-drain interval and the agent loop, never the cron); and
- a new **hourly `schedule` trigger** (`cron "0 * * * *"`, matching
  `inbox-stale-check`) — the **failure backstop**. It governs only
  recovery-from-a-miss latency, not normal ingestion latency.

### Change set (targeted)

1. **Manifest** (`assets/extensions/dome.agent/manifest.yaml`): add a
   `kind: schedule, cron: "0 * * * *"` trigger to `dome.agent.ingest`, alongside
   its existing signal triggers.
2. **Input selection** (`assets/extensions/dome.agent/processors/ingest.ts`,
   line 33): replace `ctx.changedPaths.filter(isRawCapturePath)` with the
   **standing set** — `ctx.snapshot.listMarkdownFiles()` filtered by
   `isRawCapturePath`. Both triggers now find lingering captures; behavior no
   longer depends on the commit delta. Empty set → early-return with **no model
   call** (idle cron passes are free).
3. **Deterministic order + per-run bound:** sort the standing set by filename
   (captures are timestamp-prefixed, so lexical order = chronological =
   deterministic — no `mtime`, preserving processor purity) and process the
   **oldest N per run** (default `MAX_CAPTURES_PER_RUN = 10`). A backlog drains
   over successive passes instead of risking the agent's execution timeout in a
   single run. Pure function of the snapshot.
4. **Atomicity (unchanged):** keep the existing single-`PatchEffect`-per-run
   batch (ingest.ts:77-81 — "the whole batch lands as a SINGLE PatchEffect"). A
   successful capture's task-write and its archive-out-of-`inbox/raw/` land in
   the same commit; a failed/partial run commits nothing and the next pass
   retries cleanly. The `INBOX_IS_EPHEMERAL` invariant + `source-unarchived`
   warning are preserved.
5. **`inbox-stale-check` → meaningful poison alarm:** with the reconciler in
   place, a capture still present after several cron passes genuinely means
   ingest *cannot* process it. Keep the processor, but set its age threshold to
   comfortably exceed a couple of cron intervals (e.g. ≥ 3h) so it flags real
   poison (malformed/oversize/repeatedly-failing captures) rather than a capture
   merely awaiting its next reconciliation pass. (Oversize already self-escalates
   as a `question` in ingest; this covers the rest.)

## Idempotency / why it is obviously correct

- **Reconciliation invariant:** desired state is "`inbox/raw/` is empty"; ingest
  drives current → desired idempotently and retries every pass until it gets
  there. Behavior depends only on standing state, not on catching a transient
  event.
- **No partial committed state:** single atomic patch ⇒ never "task created but
  file left behind". Re-runs after success are no-ops (the file is gone).
- **Race-safe:** concurrent signal + cron runs reading the same snapshot produce
  the *same* task line for the same capture; the engine's 3-way patch merge
  (shipped 2026-06-16) collapses identical edits, so a race does not duplicate a
  task.
- **Budget-safe:** a budget-exhausted run defers to the next pass (next hour, or
  next day when the daily cap resets) — correct eventual behavior.
- **Robust against the open garden-signal race:** the cron path runs through the
  operational-work drain (a different path than the garden signal phase), so it
  recovers a dropped signal without that race needing a fix first.

## Scope / non-goals

- **In:** the ingest manifest trigger; ingest's standing-set input + ordering +
  per-run bound; the `inbox-stale-check` threshold tweak; tests.
- **Out (deferred):** engine-level durable/at-least-once garden signal delivery
  (Approach B) — the general fix for *all* garden processors, but it overturns
  the deliberate "fire once per adoption" invariant and adds retry/dedup/ack
  machinery that is not obviously correct. The reconciler makes ingestion robust
  without it. Fixing the serve-level garden-signal race itself is also separate.
- **Unchanged:** the signal happy-path (prompt ingestion); the single-PatchEffect
  atomicity; the captured-task seam; budget/cost semantics.

## Testing

Scenario-harness tests (real git, real bundle, `tick()` = one `dome sync`):

1. **The recovery proof (must fail pre-fix):** commit a capture into
   `inbox/raw/` such that the signal-triggered garden run does not lift it
   (simulate the miss), then run a **scheduled** tick → assert the capture is
   ingested (task created in the daily, file moved out of `inbox/raw/`). Pre-fix
   ingest no-ops on a cron tick (empty `changedPaths`); post-fix it reconciles
   the standing file.
2. **Idle cron is free:** scheduled tick with empty `inbox/raw/` → no patch, no
   model invocation.
3. **Bounded drain:** a backlog > N captures → one pass ingests the oldest N;
   remaining drain over subsequent passes; deterministic oldest-first order.
4. **Idempotent re-run:** after a successful ingest, another tick produces no
   patch and no duplicate task.
5. Full suite green.
