# Dome feedback: daily notes, task lifecycle, and LLM "wardens"

**Date:** 2026-06-03
**Source:** V1 dogfood session — a full day operating the `work` vault through a foreground Claude Code agent (planning, ingest, query, triage, and a large to-do consolidation). Feedback grounded in reading the Dome source (`assets/extensions/dome.daily`, `assets/extensions/dome.markdown`, `src/core`, `src/extensions/maintenance-loops.ts`).
**Audience:** Dome maintainers.
**TL;DR:** Dome already indexes tasks and lints markdown well. The gap that caused ~all the day's friction is that **tasks are indexed but their lifecycle isn't owned**, and the *judgment-shaped* hygiene work was being imagined as deterministic rules. The proposal: keep a small **deterministic skeleton** (identity, move, close, normalize) and wrap it in a few broad **LLM wardens** (read-for-meaning, propose-with-confidence, escalate people-judgment) running in the **garden phase** — which is exactly what Dome's existing `model.invoke` + `model-safe` + garden-phase machinery was already reaching toward.

---

## 1. What Dome already does well (so this lands as build-on, not ignorance)

Grounded in the code:

- **Tasks are already projected into the graph.** `dome.daily.task-index` extracts every checkbox/directive action item into `dome.daily.open_task` (and `…followup`) facts with stable IDs and source refs (`assets/extensions/dome.daily/processors/task-index.ts`).
- **`carry-forward` aggregates "source-backed open loops"** into today's generated Open Loops block, ranked by freshness, capped at 12, deduped, with settled (resolved/dismissed) tracking (`carry-forward.ts`, `daily-shared.ts`).
- **Rich markdown linting already exists:** `validate-wikilinks` (+ repair, + ambiguous-answer), `simplify-indexes`, `normalize-frontmatter` / `lint-frontmatter`, `broken-images`, `duplicate-detection` (+ auto-merge answer), `stale-dates` (frontmatter `updated:` vs git date drift), `refresh-updated`, `raw-immutable`, `orphan-pages`.
- **Processors are organized into named maintenance loops** with settlement checks (`src/extensions/maintenance-loops.ts`: `dome.open-loop.continuity`, `dome.link-concept.coherence`, `dome.capture.digest`, `dome.context.packet`, `dome.question.continuity`).
- **The LLM machinery is already present:** a `"llm"` processor kind with `modelCallTimeoutMs`, `ctx.modelInvoke` behind a `model.invoke` capability, an `automationPolicy` enum of `agent-safe | model-safe | owner-needed`, and existing LLM operators in `dome.intake.synthesize-*`.

This is a strong substrate. The feedback is the missing 10%, not a rewrite.

---

## 2. Core diagnosis

**Dome indexes tasks but does not own their lifecycle.** It knows every task exists (facts) and can render a ranked slice (open loops), but no processor owns:

- **identity across instances** — `openLoopStableId = sha256(normalizedSourcePath + normalizedBody)` (`daily-shared.ts:501`). Identity is **path-scoped**, so the same logical task ("Ship Conv-1 follow-up") hand-copied into four daily notes is **four different tasks** to Dome. Nothing can dedup, move, or co-close them.
- **carry-by-move** — `carry-forward` is a **read-only aggregator**: it regenerates today's Open Loops block but never mutates origin files. Combined with the freshness rank + 12-item cap, **old hand-typed daily tasks are indexed as facts but fall below the fold forever** — never surfaced, never closable. They silently accumulate.
- **cross-instance closure** — marking one occurrence `[x]` does nothing to its siblings.
- **status reconciliation** — nothing asks "is this still true / still open / already done?"

Everything painful in the dogfood day fell into this gap: manually closing ~30 duplicate checkboxes across six dailies, hand-deciding tactical-vs-durable for ~25 tasks, and repeatedly asking the human "did this actually happen?" because the vault didn't know.

Separately, a **knowledge-integrity** failure showed up: a completed promotion (Alan Wu, UNI-1→UNI-2, mid-2025) was recorded as an *outstanding* nomination; an agent Slack-scan then cited *"per wiki"*, making the wiki's own misread its corroborating source; and an agent-invented level label ("L3→L4") had hardened into apparent fact. No deterministic rule would have caught this gestalt.

---

## 3. The architectural principle

> **Determinism for what is *structurally* true; LLM judgment for what *reading-with-meaning* reveals.**

A hash knows two tasks are identical. Only a reader knows a promo is mischaracterized, a task is effectively abandoned, or a claim is self-corroborating. The earlier instinct to write deterministic checks for staleness/integrity was the wrong tool: such rules fire on the wrong things (a legitimately-still-open task; a correctly-historical fact) and miss the unenumerable long tail.

Re-sorted:

| Concern | Side | Rationale |
|---|---|---|
| Task identity, dedup, move-forward, close-siblings | **Deterministic (hands)** | Structural; a hash + a rewrite. Don't pay an LLM to do what `sha256` does, and don't let it nondeterministically decide identity. |
| Frontmatter / wikilink / index / task-syntax normalization | **Deterministic** | Mechanical correctness. |
| "Is this fact stale / mischaracterized / contradictory / under-sourced?" | **LLM warden** | Judgment over meaning; unenumerable. |
| "Is this task actually done, given context?" | **LLM warden** | Reads surrounding signal, not a due-date field. |
| Tactical vs durable routing | **LLM warden** | Judgment. |
| Anything touching people / management | **LLM warden, `owner-needed`** | Judgment *and* never auto-acted — surfaced to the human. |

The deterministic processors are the **floor** (guarantees that always hold — idempotent, auditable, can't drift). The LLM wardens are the **ceiling** (open-ended coverage). The mistake is making either do the other's job.

---

## 4. Running nondeterministic wardens inside a convergent compiler

This is the one hard problem, and Dome already drew the key line: **`model.invoke` is never granted to the adoption phase** (`src/core/processor.ts:214`). Lean into that. The mechanism:

1. **Wardens run in the garden phase** (scheduled — nightly and/or post-adoption batch), never per-change. Adoption stays deterministic and instant. This bounds both cost and re-entrancy.
2. **Ledger-memoize the model call** keyed by `hash(mandateVersion + assembledContext)`. A rebuild or re-tick with unchanged input **replays the recorded judgment** instead of re-calling the model. The LLM's output becomes a *recorded fact with provenance* (model id, prompt version, input hash), not a live recomputation — preserving rebuildable projections.
3. **Settle by content-hash.** Each raised flag/question records the hash of the span it concerns and is only re-raised when that span changes. A dismissed flag stays dismissed until the underlying text moves. (Same pattern as `settledSourceBackedOpenLoops` in `carry-forward`.)
4. **Propose, don't mutate.** Wardens emit `question` / `diagnostic` / proposed-`patch` effects with confidence + `automationPolicy`. `model-safe` high-confidence outputs may auto-apply; everything else queues. Markdown stays the source of truth; the warden holds **no hidden state** — its memory is the vault + the ledger.

This quartet (garden-phase + memoize + content-hash settlement + propose-not-mutate) is what lets an LLM "primary operator" live inside a system that still guarantees idempotency, audit, and rebuildability. It also respects the existing gotchas (`processor-idempotency`, `processor-fixed-point-divergence`, `processor-version-drift`).

---

## 5. Proposed processor taxonomy (the larger change)

Split processors into two clearly-typed kinds and bundle them as a new `dome.task.lifecycle` loop alongside the existing loops.

### 5a. Deterministic processors (many, small; adoption + mechanical garden)

The "hands." `patch.auto`, exact, idempotent. The **only** things permitted to auto-edit content — and scoped away from sensitive judgment.

- **Body-stable task identity (keystone).** Change identity from `hash(path + body)` to a path-*independent* logical ID — `hash(normalizedBody)` optionally salted by a linked entity, or adopt Obsidian block-refs (`^id`) as a carried identity that survives moves. Then `task-index` yields **one** node per logical task with N occurrences. Everything else depends on this.
- **`dome.daily.task-reconcile` (evolve `carry-forward`).** Garden phase, `patch.auto` over `notes/**` + `wiki/**`:
  - **move, don't copy** — open tactical tasks in past dailies are rewritten into today's note and **removed from the origin**; today's daily becomes the single tactical surface automatically.
  - **close-everywhere** — when a logical task is `[x]` in any occurrence, propagate closure (rewrite to `[x]` with a tombstone — never delete) to its siblings.
  - **dedup-to-canonical** — collapse identical-body open tasks to one home (the durable wiki page if one exists, else today's daily).
- **Task-syntax normalization** (new markdown linter) — enforce `#task` tag presence; well-formed `🔺/⏫/🔼/🔽`, `📅 YYYY-MM-DD`; require `✅ date` when `[x]`.

### 5b. LLM wardens (few, broad; garden phase; `model.invoke`)

A *mandate* (NL charter) instead of a rule, a *context recipe*, a *bounded effect palette*, and per-effect confidence + policy. Auditable not by reading code but by the **ledgered trail of effects + sourceRefs + confidence** they emit.

Three to build:

1. **Knowledge-integrity warden** — flags stale/mischaracterized/contradictory/self-corroborating/agent-inference-as-fact claims. (Full sketch in §6.) Catches the entire Alan-Wu class.
2. **Task-reconciliation warden** — the judgment layer *on top of* the deterministic hands: reads the day's open tasks in context, decides which look done/abandoned/misrouted (tactical vs durable), and emits intents the deterministic move/dedup/close processors execute. LLM decides; hands do.
3. **Daily-briefing warden** — writes the morning hand-off to the foreground agent (§7).

---

## 6. Concrete sketch — the knowledge-integrity warden

The one that would have caught the dogfood day's bug, and which exercises every part of the warden pattern.

```yaml
- id: dome.integrity.review
  version: 0.1.0
  kind: llm
  phase: garden
  modelCallTimeoutMs: 60000
  triggers:
    - kind: schedule
      cron: "30 5 * * *"          # nightly, after refresh-updated/stale-dates
  capabilities:
    - kind: read
      paths: ["wiki/**/*.md", "notes/*.md"]
    - kind: model.invoke           # garden-only; barred from adoption by design
    - kind: question.ask
    - kind: graph.write
      namespaces: ["dome.integrity.*"]
  module: processors/integrity-review.ts
```

**Mandate (charter prompt, versioned — the memoization key includes its version):**

> You are a knowledge-integrity reviewer for a personal work vault. For each candidate page, judge whether any claim is: (a) a **completed/historical event framed as ongoing** (e.g., "submitted/shipped/promoted" + still described as pending); (b) **internally or cross-page contradictory**; (c) **self-corroborating** — its only support is a source that itself cites this vault; (d) **agent-inference dressed as sourced fact** — an interpretive label (a level, a rating, a category) with no primary source. Prefer flagging over editing. Never propose edits to people/management content; surface those for the owner. Cite the exact span and the provenance chain for each flag.

**Context recipe (what Dome assembles deterministically before the call — keeps it cheap + grounded):**
- pages changed since the warden's last ledgered run (delta, not the whole vault);
- their linked neighbors (1 hop via `dome.graph.links`);
- the **provenance subgraph** from `sourceRefs` for each load-bearing claim (so it can see "this fact's only source is a scan that cites this page");
- frontmatter `created/updated` + git last-changed date;
- inbound-link count per claim (load-bearing-ness).

**Effect palette + policy logic:**
- `questionEffect` — for each flag. `automationPolicy` chosen by subject: any page typed `entity` about a person, or `notes/**` management content → **`owner-needed`**; low-stakes structural claims → **`model-safe`**. `metadata.confidence` from the model; `recommendedAnswer` as a hint.
- `factEffect` in `dome.integrity.*` — record a provenance tier, e.g. `predicate: "dome.integrity.assertion_tier"`, `object: "inferred" | "needs-confirmation"`, so deterministic surfacing (and the daily-briefing warden) can treat unconfirmed inferences differently from sourced facts.
- `diagnosticEffect` — non-blocking informational flags.
- **No `patch.auto`.** Knowledge claims are proposed/flagged, never silently rewritten (honors the vault's "never silently overwrite" rule and `MARKDOWN_IS_SOURCE_OF_TRUTH`).

**Idempotency / settlement:**
- memoize the model call by `hash(mandateVersion + assembledContext)`;
- per flag, settle by `hash(spanContent + checkClass)`; re-raise only when that span changes;
- resolved/dismissed answers flow through the existing `dome.question.continuity` loop and are not re-litigated.

Applied to the Alan-Wu page, this warden would have emitted an `owner-needed` question: *"`alan-wu.md` frames a promotion as 'outstanding (as of 2026-05-27)' but the nomination was submitted ~2025-07-22 (~10mo prior), and the only corroboration is `alan-wu-slack-scan` citing this wiki; the 'L3→L4' label has no primary source. Concluded / still-open / agent-inference?"* — i.e., it catches the gestalt a rule never could, at the cost of a dismissible question.

---

## 7. Foreground/background contract — two LLM tiers

With wardens, the division isn't smart-foreground vs dumb-background; it's two LLM tiers with different economics:

- **Background wardens (Dome):** cheap, narrow-mandate, *always-on* (every commit / nightly), no human in the loop, propose-and-confirm. They read **everything**.
- **Foreground agent:** expensive, high-context, conversational, handles the novel/ambiguous/sensitive, human-in-the-loop. Sees only what's in front of it in a session.

The background warden is the foreground agent's **tireless junior**: it watches every change, flags what's off, drafts reconciliations, and *queues judgment*. The connective tissue is the **daily-briefing warden**, which writes a structured hand-off — *what changed, what I auto-fixed, what looks stale/contradictory, what's overdue, what needs your judgment* — so a foreground session **starts from a briefing instead of grepping**.

`model-safe` vs `owner-needed` is precisely the handoff valve between the tiers: model-safe = a background/foreground agent may resolve it; owner-needed = it waits for the human.

---

## 8. Markdown-lint gaps (deterministic, quick wins)

Already strong; missing:
- **Task-syntax normalization** (see §5a).
- **Backlink suggestion** — page A links B but B has no See-Also backlink → diagnostic (you have `dome.graph.links`).
- **Contradiction *candidates*** as a cheap deterministic pre-filter that hands the integrity warden a shortlist (same (entity, attribute) asserted with different values across pages).

---

## 9. Guardrails

- **People/management content is always `owner-needed`, never auto-patched.** Wardens may *surface*; only the deterministic hands hold `patch.auto`, and they're scoped away from judgment. Flexible *catching*, hard human gate on *acting*.
- **Wardens flag; they don't rewrite knowledge.** Auto-apply is reserved for mechanical/structural edits.
- **Garden-phase + memoize + content-hash settlement** keep the compiler convergent and bound cost.
- **Tombstone, don't delete** on close/dedup (preserve an audit trail; `Dome-*` trailers already support this).
- **Coexist with Obsidian's Tasks plugin** — Dome owns canonical state; the plugin just renders. Don't fight `notes/tasks.md`.

---

## 10. Prioritization

1. **Deterministic keystone — body-stable task identity + `task-reconcile` (move / close-siblings / dedup).** Converts the entire day's manual task-janitoring into a background loop. Highest impact-per-effort.
2. **Knowledge-integrity warden (§6).** Catches the class of bug that bit the dogfood day; exercises the full warden pattern as the reference implementation.
3. **Daily-briefing warden (§7).** Makes the daily note the cockpit and wires the two-tier handoff.
4. **Task-reconciliation warden + task-syntax lint.** Judgment routing on top of the deterministic hands.

---

## Appendix — grounded code references

- Path-scoped task identity: `assets/extensions/dome.daily/processors/daily-shared.ts:501` (`openLoopStableId`), `:490` (`openLoopIdentity`), `:497` (`openLoopSurfaceKey`).
- Read-only aggregation + 12-cap + freshness rank: `carry-forward.ts:44` (`OPEN_LOOP_SURFACE_LIMIT`), `:147` (`collectOpenLoopSources`), `:250` (`mergeRetainedOpenLoops`).
- Task facts: `task-index.ts` (`OPEN_TASK_PREDICATE`, `FOLLOWUP_PREDICATE`).
- "Source-backed" eligibility (daily-source vs `isSurfaceEligibleNonDailyAction`): `daily-shared.ts:355` (`openLoopSurfaceSources`).
- LLM machinery: `src/core/processor.ts:113` + `:618` (`"llm"` kind), `:214` (**`model.invoke` never granted to adoption phase**), `:258` (`ModelInvokeCapability`); `src/processors/context.ts:92` (`modelInvoke`); `src/core/effect.ts:226` + `:586` (`automationPolicy: agent-safe | model-safe | owner-needed`).
- Existing LLM operators: `assets/extensions/dome.intake/processors/synthesize-capture.ts`, `synthesize-rollup.ts`.
- Existing staleness (frontmatter-only, deterministic — the thing to *augment* with judgment, not replace): `assets/extensions/dome.markdown/processors/stale-dates.ts`.
- Loop framing: `src/extensions/maintenance-loops.ts` (`dome.open-loop.continuity`, `dome.link-concept.coherence`, etc.).
