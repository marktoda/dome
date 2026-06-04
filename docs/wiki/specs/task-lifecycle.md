---
type: spec
created: 2026-06-03
updated: 2026-06-03
sources:
  - "[[v1]]"
---

# Task lifecycle

This spec is normative for Dome's task-lifecycle substrate — the `^block-anchor` line-identity primitive, the three deterministic `dome.daily` task processors (stamp / reconcile / normalize), the `lastHumanChangedAt` freshness rule, and the **warden** pattern (model-gated garden processors). It explains why each piece sits where it does and what contract it holds.

The task-lifecycle layer is the machinery behind "close a task in one place, close it everywhere." It introduces no new primitive: a "warden" is a [[wiki/specs/processors|Processor]] (`kind: llm`, garden phase), not a new concept beside Vault / Proposal / Processor / Effect. The four-concept core stays sealed.

## Block-anchor identity

A **block anchor** is a trailing `^id` token on a line, separated from the preceding text by whitespace — e.g. `- [ ] ship the thing ^t1a2b3c4`. The grammar is a core primitive at `src/core/block-anchor.ts`: pure (string-only, no IO), Obsidian-compatible, and rebuild-safe. The anchor is stamped *into the markdown itself*, so identity travels with the line.

Identity is anchored to the `^id`, not to a body-hash, because tasks **move**. A task line is rephrased, reordered within a list, or cut from one note and pasted into a daily's open-loop section. A body-hash identity would change on every rephrase and could not survive a move across files. A block anchor is **move-stable**: the same `^id` names the same task no matter which file it currently lives in or how its text is edited. Markdown remains the source of truth (per [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]]); the anchor is durable identity carried in that source.

## The three deterministic `dome.daily` task processors

Three garden-phase, `patch.auto` processors maintain task lines. All three are deterministic and idempotent — running them twice against the same adopted tree produces the same result — which keeps them rebuild-eligible under [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]].

- **`dome.daily.stamp-block-id`** stamps a `^id` anchor onto each action-item line that lacks one. Stamping is deterministic and idempotent: an already-anchored line is left untouched, and a freshly stamped line gets a stable id. This is the keystone — once a line carries an anchor, the other processors can name it across moves.
- **`dome.daily.reconcile-tasks`** propagates a *settled* state. When a daily's source-backed open-loop **copy** of a task is marked `[x]` (done) or `[-]` (dropped), reconcile writes that settled state back to the matching open task line in the named origin file (resolved from the copy's `(from [[origin]])` link). Matching is by normalized body, not by anchor — the generated copy carries no `^anchor` — so when the origin holds two open lines sharing a body the match is ambiguous and is **skipped** rather than guessed (carry-forward dedups surfaced copies by body, so the unambiguous case is the norm). It is **close-in-place**: it edits the origin's checkbox state and never deletes the line. This realizes "close in one place, close everywhere." It declares `inspection: all-readable-markdown` because the origin line may live in any readable markdown file, not just the changed one.
- **`dome.daily.normalize-task-syntax`** performs cosmetic task-syntax normalization (checkbox case, spacing) and **preserves anchors** — normalization must not strip or move the trailing `^id`.

All three are **garden** (not adoption) phase. The reason is the capability-failure surface. In the adoption phase a capability-denied auto-patch becomes a `severity: "block"` diagnostic that blocks the human's adoption — a cosmetic or convenience patch that cannot land would wedge the loop. In the garden phase the same denial degrades quietly (the patch is downgraded or skipped) without blocking the human's commit from being adopted. Task maintenance is convenience work; it must never gate the human. See [[wiki/specs/adoption]] §"The fixed-point adoption loop".

## The `lastHumanChangedAt` freshness rule

Daily open-loop recency ranking must reflect *human* edit recency, not engine churn. The problem: stamping a `^block-anchor` (or any garden patch) produces an engine commit, which would reset a naive "last changed" timestamp and make a stale task look fresh.

`src/git.ts` exposes `lastHumanChangedAt` alongside `lastChangedAt`: it is the timestamp of the latest commit touching the line that does **not** carry a `Dome-Run:` trailer — i.e. the latest *human* (non-engine) change. Daily open-loop recency ranking uses `lastHumanChangedAt`, so an engine rewrite such as anchor stamping cannot reset a task's human-edit recency. This depends on the trailer convention pinned by [[wiki/invariants/ENGINE_COMMITS_CARRY_DOME_TRAILERS]]: engine commits carry `Dome-Run`, human out-of-band commits do not, which makes the human/engine split structurally queryable.

## Wardens

A **warden** is an LLM-backed garden processor (`execution.class: llm`, `phase: garden`, granted `model.invoke`). It is not a new primitive — it is the model-gated shape of the existing Processor concept. The `dome.warden` bundle is **model-gated** and ships `enabled: false` by default. Two wardens ship:

### `dome.warden.integrity` — questions-only knowledge-integrity reviewer

The integrity warden reads `wiki/**/*.md`, asks the model to find knowledge-integrity problems (contradictions, stale claims, dangling references), and surfaces each finding as a **`QuestionEffect`** — never a fact and never a knowledge patch. Its capabilities are `read` + `model.invoke` + `question.ask`; it deliberately declares neither `patch.auto` over knowledge nor `graph.write`.

This is structurally required by [[wiki/invariants/MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS]]: a garden `model.invoke` processor is **not** re-run during projection rebuild (model calls are excluded from rebuild), so any `FactEffect` it emitted would silently vanish on `dome rebuild`. The warden's judgment is transient; it becomes durable only through the **resolution-is-durable** contract: a human or agent answers the question via `dome resolve`, the answer is recorded in `answers.db`, and rebuild rehydrates that answer. The companion **`dome.warden.integrity-answer`** handler (an `answer`-triggered garden processor, `read` only) reacts to the resolved answer. Model output proposes; the human/agent resolution disposes, and only the disposition is durable.

### `dome.warden.daily-briefing` — generative briefing surface

The briefing warden generates a daily briefing page. It is granted `read` + `model.invoke` + `patch.auto` **scoped narrowly to the generated surface** `wiki/generated/briefing/*.md` — and, again, **no `graph.write`**. The briefing is a regenerated generated surface, not a durable fact: rebuild re-derives it by re-running the (cron-driven) processor against adopted state, so it stays consistent with [[wiki/invariants/MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS]] and [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]].

The briefing warden is **cron-only** (`schedule: "0 7 * * *"`), with no `document.changed` trigger. A document-change trigger would re-fire on the warden's own written output and cascade; a schedule trigger does not re-fire on the resulting sub-Proposal's document change, so the garden cascade converges. See [[wiki/gotchas/garden-cascade-cap]].

### No-op without a model

Both wardens **degrade to a clean no-op** when no model provider is configured. With `model.invoke` ungranted or no provider wired, the warden returns no effects rather than failing — it is never a failed run. This keeps a vault with wardens enabled but no model key fully green.

## Related

- [[wiki/invariants/MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS]] — the hard rule wardens hold: no garden `model.invoke` processor declares `graph.write`
- [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]] — why model judgment must not become a durable fact
- [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]] — anchors live in markdown; answers live in `answers.db`
- [[wiki/invariants/ENGINE_COMMITS_CARRY_DOME_TRAILERS]] — the `Dome-Run` split behind `lastHumanChangedAt`
- [[wiki/specs/capabilities]] — `model.invoke`, `graph.write`, `patch.auto`, `question.ask` tiers
- [[wiki/specs/processors]] — phases, triggers, `execution.class: llm`, idempotency
- [[wiki/specs/effects]] — `QuestionEffect`, `PatchEffect`, `FactEffect`
- [[wiki/specs/adoption]] — why garden-phase denials don't block the human
- [[wiki/gotchas/garden-cascade-cap]] — why the briefing warden is cron-only
