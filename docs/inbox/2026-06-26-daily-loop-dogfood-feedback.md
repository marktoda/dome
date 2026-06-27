# Dome feedback: the daily-loop, live in production

**Date:** 2026-06-26
**Source:** V1 dogfood — a full day operating the `work` vault through a live Claude Code agent (morning brief, carry-forward triage, entity-page authoring, claims). Code grounded in `src/engine/core/adopt.ts`, `src/git.ts`, `src/cli/commands/serve.ts`, `assets/extensions/dome.daily`, `assets/extensions/dome.claims`.
**Audience:** Dome maintainers.
**TL;DR:** The daily-loop scaffolding earned its keep — carry-forward + open-loops carried every thread with provenance, and the auto-brief was a genuinely good synthesis. Two issues fight a *live* collaborator and should be fixed first: **(1) the daemon re-materializes working-tree files out from under an open editor** (diagnosed below — confirmed root cause), and **(2) claims-promotion is too eager**, stamping conversational session-summary lines as durable current-facts. Three smaller items below.

---

## What worked

- **Carry-forward + open-loops did its job.** Thomas tasks, OpenAI sub, bonus pass, Guillaume memo all carried into today with `(from …)` provenance intact. No drops.
- **The morning brief was a genuine synthesis.** "Thomas comp chase + RH July-1 as the two highest-stakes threads" was the right read, auto-generated.

---

## 1. The daemon mutates working-tree files mid-edit  *(highest-stakes; root cause confirmed)*

**Symptom.** Carry-forward and claims re-stamped `danny.md`, `kristie.md`, `christian-angelopoulos.md`, `gas-abstraction.md` *between* a live agent's `Read` and its `Edit`, multiple times in one day. The `Edit` then fails its string-match (the on-disk content changed under the read snapshot), forcing fallback to atomic whole-file writes. For an agent collaborating live on the vault, this is the day's biggest papercut.

**Root cause (traced).** The `dome serve` daemon owns working-tree materialization, and it has no coordination with an external editor that has files open:

1. Scheduler fires a garden processor (`dome.daily.carry-forward`, `dome.claims`) on its cron cadence — `src/engine/operational/scheduler.ts` `dispatchGardenRun`. The serve loop polls every `DEFAULT_POLL_INTERVAL_MS = 500ms` and runs operational work every `DEFAULT_OPERATIONAL_INTERVAL_MS = 1000ms` (`src/cli/commands/serve.ts:89-90`), **independent of whether a human committed anything**.
2. The processor emits a `PatchEffect` writing e.g. `danny.md` (`assets/extensions/dome.daily/processors/carry-forward.ts`).
3. The patch is applied to an in-memory candidate tree (git plumbing only — `src/engine/core/apply-patch.ts`), adoption converges, and `refs/heads/<branch>` is advanced to the closure commit (`src/engine/core/adopt.ts:835-840`).
4. **The working tree is then materialized via `materializeBranchTarget` → `checkoutPathsAtRef` → `git.checkout({ filepaths, noUpdateHead: true })`** (`src/engine/core/adopt.ts:855-860`, `src/git.ts:972-980`). This is the step that writes the bytes of `danny.md` on disk.

**What is and isn't protected.** `validateBranchMaterialization` (`adopt.ts:972-996`) runs a **dry-run checkout with `force: false`** before the ref moves. isomorphic-git throws `CheckoutConflictError` if a target path has *uncommitted local edits*, and the daemon then emits a `block` diagnostic and aborts the advance ("the work will be re-derived on the next sync") — so **committed or in-progress on-disk edits are NOT silently clobbered.** The unprotected case is the one the agent hit: a file that has been **Read but is still clean** (no edit landed yet). The daemon re-materializes it freely, the read snapshot goes stale, and the next `Edit` fails. The only on-disk signal of "a human/agent is editing here" is a write that hasn't happened yet — so nothing in the current guard can see it coming.

**Secondary hazard.** If the agent *does* land an uncommitted edit to a file the eager garden processors also want, the daemon's next tick hits the conflict guard and **blocks its own adoption**, re-deriving every tick — eager processors + an active editor can wedge the daemon into repeated aborts.

**Fix shapes (ranked — this is a design call, see the session thread):**

- **A. Worktree quiescence / debounce (recommended immediate fix).** Before advancing the ref, treat "the vault saw a recent external working-tree write (mtime within an N-second window)" as a soft conflict that aborts→re-derives next tick — reusing the existing `validateBranchMaterialization` abort path, which already does exactly this for hard conflicts. During an active editing session there's a steady stream of writes, so the daemon politely stays out of the way; when the session goes quiet, garden catches up. Small, local to `adopt.ts`, no editor cooperation required. Must happen **before** the ref advance, not after — deferring materialization post-advance is the "phantom user edits" state the finalize-journal comment at `adopt.ts:824-827` explicitly warns about. Risk: a perpetually-touched file starves materialization → bound with a force-after-K-deferrals.
- **B. Advisory worktree lock as part of the compiler boundary (principled direction).** Expose `.dome/state/locks/worktree.lock`; teach harnesses (via the AGENTS.md compiler-boundary contract) to hold it across a Read→Edit transaction; the daemon's materialize step defers while it's held. This is the only thing that closes the pure read-then-edit window, and it generalizes to any external editor — but Claude Code's native Read/Edit won't take the lock without a hook/wrapper. Ship daemon-side respect now, harness-side acquisition as a documented protocol + optional hook.
- **C. Slow/batch the eager garden processors (mitigation; converges with item 2).** Debounce carry-forward + claims so they only re-stamp when the daily note actually changed, or on a much slower cadence. Reduces collision frequency; doesn't close the race. Overlaps the over-eager-claims fix below — both say "garden processors are too eager."

Recommendation: **A now** (kills the papercut, reuses existing abort machinery), **B as the documented multi-writer contract.**

**Resolution (shipped).** Implemented a variant of A, simplified after diagnosis. Rather than mtime-quiescence on materialization, `dome serve` now **skips the entire compiler tick while the working tree is dirty** (`isWorkingTreeDirty` in `src/git.ts`, gated in the serve loop). Why the whole tick and not just garden materialization: the clobbering garden processors (carry-forward, claims-stamp) are `document.changed`-triggered and key on the *adoption diff*, so deferring tend while still advancing adoption would **lose the trigger** (no future drift re-fires it). Skipping the whole tick lets the same work re-derive once the tree is clean; scheduled work catches up via its cursor. This honors "Dome works at the git commit boundary" — the daemon stays off the working tree entirely while you have uncommitted work. Accepted tradeoff: adoption also waits during a dirty session (bounded by going clean once). Option B (advisory worktree lock) remains the documented direction for the pure read-then-edit window.

---

## 2. Claims-promotion is too eager

Dome promoted conversational lines into durable current-facts claims — e.g. a Thomas "Net: positive, comp is the live lever" line and a "Tension to hold" bullet got `^c`-stamped as facts. Current-facts should be **durable** claims, not session summaries; promoting prose-of-the-moment adds noise to those blocks. The promotion gate needs a durability test (is this a standing fact about the entity, or a momentary read?). Pairs naturally with item 1's option C — both are "the garden phase acts too often / too freely."

**Resolution (shipped).** Added a conservative **discourse-marker denylist** in `claimsFromMarkdown` (the single grammar chokepoint feeding both the `^c` stamp and the fact index): keys like `Net`, `Tension to hold`, `TL;DR`, `Takeaway`, `Bottom line`, `My read`, `Verdict`, `Caveat`, `Aside`, `Update`, `Note`, `Summary`, `Context` no longer promote. Matched on the normalized key (case/spacing-insensitive), so it's a key test, not a value scan — a durable claim whose value happens to contain "net positive" still promotes. Deliberately conservative: under-excludes (lets a borderline claim through) rather than dropping a real fact, and the list is a one-line constant to extend as dogfooding surfaces more markers.

---

## 3. Owner-needed question backlog is accumulating (no triage affordance)

`dome check` showed **57 open (50 owner-needed)** this morning. Dome surfaces them but offers no way to triage or clear them in bulk — it quietly accrues attention-debt. Wanted: a triage surface (group/age/dismiss/batch-resolve), not just a count.

---

## 4. Brief staleness: "first post-on-site workday"

The brief called today (Fri) the "first post-on-site workday" when the calendar still had today as the **last** onsite day — an off-by-one on the onsite-window boundary in brief generation.

---

## 5. "Integrated Overnight" block is the weakest surface block

It's an adoption-provenance view — "here are the ~20 entity/concept pages the overnight pass touched from yesterday's daily." Honest read: it reports **what was touched, not what to do or know** — already covered better by the Yesterday narrative (synthesis) and Open Loops (tasks), so it's a third, lower-value view of the same day. Its only actionable signal is the "⚠ pending your answer" markers, and they're cryptic (pending *what?*). Recommendation: demote it to `dome log` / `dome inspect` (debug/audit surface), not the morning work surface. If it stays, collapse it to just the pending-your-answer items **with what's actually pending stated** — the bare link list is noise.

---

## Non-bug noted: duplicate comp TODO was double-authoring, not a Dome defect

Two open tasks for the same Thomas comp commitment — `^t3a07f4c6` ("Chase a comp increase for Thomas T", written on the 6/25 daily note) and `^te55110ce` ("Comp increase for Thomas, going forward", written on Thomas's entity page). Same commitment captured in two vault locations → each got its own stable `^t` anchor → carry-forward faithfully surfaced both. **Dome did exactly the right thing** (track + carry every open task); the duplication was authoring. Distinct from the carry-forward-duplication *defect* fixed earlier. Resolution: keep the entity-page anchor (`^te55110ce`) as canonical (a durable retention lever belongs on the person's page) and convert the 6/25 daily line into a pointer (`→ tracked on [[thomas-t]] ^te55110ce`) so it stops being a second tracked task without falsely marking the chase "done."
