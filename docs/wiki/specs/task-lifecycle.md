---
type: spec
created: 2026-06-03
updated: 2026-06-13
sources:
  - "[[v1]]"
description: "Task substrate: move-stable ^block anchors, splice-guard generated blocks, stamp/reconcile/normalize, lastHumanChangedAt, attention discounting"
---

# Task lifecycle

This spec is normative for Dome's task-lifecycle substrate — the `^block-anchor` line-identity primitive, the three deterministic `dome.daily` task processors (stamp / reconcile / normalize), the `lastHumanChangedAt` freshness rule, **attention discounting** (dismissal-derived impression discounting), and the **warden** pattern (model-gated garden processors). It explains why each piece sits where it does and what contract it holds.

The task-lifecycle layer is the machinery behind "close a task in one place, close it everywhere." It introduces no new primitive: a "warden" is a [[wiki/specs/processors|Processor]] (`kind: llm`, garden phase), not a new concept beside Vault / Proposal / Processor / Effect. The four-concept core stays sealed.

## Block-anchor identity

A **block anchor** is a trailing `^id` token on a line, separated from the preceding text by whitespace — e.g. `- [ ] ship the thing ^t1a2b3c4`. The grammar is a core primitive at `src/core/block-anchor.ts`: pure (string-only, no IO), Obsidian-compatible, and rebuild-safe. The anchor is stamped *into the markdown itself*, so identity travels with the line.

Identity is anchored to the `^id`, not to a body-hash, because tasks **move**. A task line is rephrased, reordered within a list, or cut from one note and pasted into a daily's open-loop section. A body-hash identity would change on every rephrase and could not survive a move across files. A block anchor is **move-stable**: the same `^id` names the same task no matter which file it currently lives in or how its text is edited. Markdown remains the source of truth (per [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]]); the anchor is durable identity carried in that source.

## Generated-block markers (the splice-guard primitive)

A **generated block** is a marker-delimited region of a markdown page that a processor owns and regenerates — `<!-- <owner>:<block>:start -->` … `<!-- <owner>:<block>:end -->`, where the owner is a dome namespace matching `dome(\.\w+)*` (e.g. `dome`, `dome.daily`, `dome.agent.brief`) and the block name is a slug. Everything outside the markers is human prose; no two processors write the same region — block ownership is disjoint, and the canonical who-writes-which-block-in-the-daily table is [[wiki/specs/daily-surface]] §"Block ownership".

Generated-block bodies are excluded from task extraction with **one deliberate exception**: `dome.daily:captured` (the live capture landing zone) holds task *origins*, not projection copies, so its body stays inside extraction, stamping, normalization, and surfacing — see [[wiki/specs/daily-surface]] §"The `captured` block holds origins, not copies".

The grammar is a core primitive at `src/core/generated-block.ts` — pure (string-only, no IO), the sibling of `src/core/block-anchor.ts` — and it is the **only sanctioned marker implementation**. No processor hand-rolls marker matching, splicing, or stripping; the [[wiki/linters/generated-block-splice-guard]] fence fails CI when a non-test source file constructs marker text without importing the primitive. The primitive carries the two defenses every splice needs:

- **Line-anchored scanning.** A marker counts only when the entire trimmed line is the marker. Prose or fenced *mentions* of marker text, and marker text smuggled mid-line through model-derived content, never bound a block. The first line-anchored pair wins; duplicate pairs, unterminated starts, and orphan ends are reported as anomalies, never silently bound.
- **Body sanitization.** Model-derived block bodies pass through `sanitizeGeneratedBlockBody`, which drops every line carrying a `<!-- dome…` marker comment and strips stray bare `<!--`/`-->` fragments that could recombine downstream. Dome's HTML comments are exclusively generated-block markers, so no legitimate body line ever carries one.

This closes a bug class that shipped three times before the primitive existed: a smuggled second `dome.agent.brief:questions` pair fabricating a questions block in the daily note, injected `dome.daily:*` markers corrupting carry-forward, and promoted preference-rule text carrying the `promoted-preferences` end marker out of `core.md`'s generated block (the marker-injection gotcha named in [[wiki/specs/preferences]]).

**Anomalies are surfaced, never silent.** The scanner's anomaly report (`extra-start` / `extra-end` / `orphan-end` / `unterminated`) makes a smuggle attempt or hand-mangled marker inert — but inert is not invisible. Every splice call site that processes model-derived or human content (the brief's block splice, the preference answer handler's `core.md` splice, carry-forward's daily splice, `render-index`' index-block render) turns each anomaly into one **info-severity** DiagnosticEffect, code `dome.<bundle>.generated-block-anomaly`, message naming the block and anomaly kind, sourceRef anchored at the anomalous marker line. Info by design: an anomaly never blocks adoption (the splice already ignored it). Re-emission dedupes at the diagnostics sink's `(processor_id, code, proposal_id, subject_hash)` constraint, so steady-state re-runs stay quiet. The shared renderer is `generatedBlockAnomalyDiagnostics` in `src/core/generated-block-diagnostics.ts`.

## The three deterministic `dome.daily` task processors

Three garden-phase, `patch.auto` processors maintain task lines. All three are deterministic and idempotent — running them twice against the same adopted tree produces the same result — which keeps them rebuild-eligible under [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]].

- **`dome.daily.stamp-block-id`** stamps a `^id` anchor onto each action-item line that lacks one. Stamping is deterministic and idempotent: an already-anchored line is left untouched, and a freshly stamped line gets a stable id. This is the keystone — once a line carries an anchor, the other processors can name it across moves.
- **`dome.daily.reconcile-tasks`** propagates a *settled* state. When a daily's source-backed open-loop **copy** of a task is marked `[x]` (done) or `[-]` (dropped), reconcile writes that settled state back to the matching open task line in the named origin file (resolved from the copy's `(from [[origin]])` link). Matching is by normalized body, not by anchor — the generated copy carries no `^anchor` — so when the origin holds two open lines sharing a body the match is ambiguous and is **skipped** rather than guessed (carry-forward dedups surfaced copies by body, so the unambiguous case is the norm). It is **close-in-place**: it edits the origin's checkbox state and never deletes the line. This realizes "close in one place, close everywhere." It declares `inspection: all-readable-markdown` because the origin line may live in any readable markdown file, not just the changed one.
- **`dome.daily.normalize-task-syntax`** performs cosmetic task-syntax normalization (checkbox case, spacing) and **preserves anchors** — normalization must not strip or move the trailing `^id`. It also carries the **captured-today heading repair** for *today's* daily only: duplicate `# Captured today`/`## Captured today` headings (a real pre-D3 vault wart) are merged into the single owned section with every task line and anchor preserved, emitting one `dome.daily.captured-heading-repair` info diagnostic; historical dailies are never touched ([[wiki/specs/daily-surface]] §"Captured-today heading repair"). Same hygiene class — canonicalizing the *shape* of task surfaces without changing task semantics — same triggers, same grant, so it lives here rather than in a fourth processor.

All three are **garden** (not adoption) phase. The reason is the capability-failure surface. In the adoption phase a capability-denied auto-patch becomes a `severity: "block"` diagnostic that blocks the human's adoption — a cosmetic or convenience patch that cannot land would wedge the loop. In the garden phase the same denial degrades quietly (the patch is downgraded or skipped) without blocking the human's commit from being adopted. Task maintenance is convenience work; it must never gate the human. See [[wiki/specs/adoption]] §"The fixed-point adoption loop".

**Obsidian Tasks dashboards are left alone.** A file containing a fenced ` ```tasks ` query block is an Obsidian Tasks plugin dashboard — the plugin parses task lines and would be confused by an injected `^anchor`. All three rewriters skip such files entirely (`isObsidianTasksDashboard`), so a vault's `notes/tasks.md`-style query files stay user-maintained. This is interop, not a capability grant: the grant model matches paths with positive globs only (`notes/*.md` cannot subtract one file), so the exclusion lives in the processor logic. Read-only extraction (`task-index`) still projects those task lines into facts.

## Task origin (source provenance)

A task's origin — where it came from — is one inline marker, ` ([↗](target))`, where `target` is a vault-relative path (a capture file) or a percent-encoded external URL (e.g. a Slack permalink). The grammar is defined once in `action-extraction` (`appendOriginMarker`/`parseOriginMarker`/`stripOriginMarker`); the marker is stripped from the body used for identity, dedup, and reconcile keys, so origin never perturbs `^id` identity. Origin is projected as a parallel `dome.daily.task_origin` fact correlated to the task by stableId (the `open_task`/`followup` fact value stays the clean semantic body), surfaced as a structured field on the task, and rendered as one clickable `↗` affordance in `dome today` (the URL, or `file://` for a vault path). It is distinct from the `(from [[…]])` carry-forward *copy*-provenance suffix. Design: [[cohesive/brainstorms/2026-06-15-daily-phase2]].

## The `lastHumanChangedAt` freshness rule

Daily open-loop recency ranking must reflect *human* edit recency, not engine churn. The problem: stamping a `^block-anchor` (or any garden patch) produces an engine commit, which would reset a naive "last changed" timestamp and make a stale task look fresh.

`src/git.ts` exposes `lastHumanChangedAt` alongside `lastChangedAt`: it is the timestamp of the latest commit touching the line that does **not** carry a `Dome-Run:` trailer — i.e. the latest *human* (non-engine) change. Daily open-loop recency ranking uses `lastHumanChangedAt`, so an engine rewrite such as anchor stamping cannot reset a task's human-edit recency. This depends on the trailer convention pinned by [[wiki/invariants/ENGINE_COMMITS_CARRY_DOME_TRAILERS]]: engine commits carry `Dome-Run`, human out-of-band commits do not, which makes the human/engine split structurally queryable.

## Attention discounting

Items surfaced day after day without action stop earning their prominence. The attention-discount layer (memory-quality M4) derives an **implicit dismissal signal** from what the vault already records — which dailies showed an item, and when a human last touched its origin — and demotes accordingly. Per the memory plan's decision ledger (entry 5): dismissal is implicit, derived from git + markdown; demotion self-heals; due-dated and top-priority items are exempt. There is no explicit "dismiss" primitive (one may layer on later).

### The deterministic substrate: `dome.daily.attention-discount`

A garden-phase processor (`execution.class: deterministic`, capabilities `read` + `graph.write` over `dome.attention.*` only, `inspection: all-readable-markdown`) emits one `dome.attention.discount` fact per discounted open-loop item. Because it is deterministic, signal-triggered, and confined to the rebuild-safe capability set, it is **rebuild-eligible** (`isRebuildEligibleGardenProcessor` in `src/engine/host/projection-rebuild.ts`): `dome rebuild` re-derives every discount fact from adopted markdown + git history alone, per [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]].

Inputs, all derivable from the adopted tree and its git history — **no wall clock**:

- **Impressions** — the number of distinct daily notes (the configured `daily_path` glob, bounded to the most recent **30** dailies for cost) whose generated open-loops block carries an open copy of the item. Matching is by open-loop identity `(origin path, normalized body)` — the same identity carry-forward uses — because the generated copy carries no `^anchor`. A body edit changes the identity and naturally restarts the impression trail; an edit is action anyway.
- **Action signal** — `lastHumanChangedAt` of the item's origin file (the `Dome-Run` trailer split, §"The `lastHumanChangedAt` freshness rule"). Only impressions in dailies dated **strictly after** the last-human-touch date count: any human edit to the origin file resets the impression count to the dailies since.
- **Reference date** — the newest scanned daily's date, *not* the wall clock. "Days since last shown" is `newestDailyDate − lastShownDate`. This keeps the fact a pure function of the adopted tree: same content → same facts.
- **Scope** — only items whose origin line carries a stamped `^block-anchor` participate (anchored identity is the durable one; `stamp-block-id` anchors new items within a tick). Settled items (resolved `[x]` / dismissed `[-]` anywhere) get **no facts** — settling is the cleanup.

### The formula

```
discount = min(0.6, 0.1 × max(0, impressionsSinceLastHumanTouch − 2)) × 0.9^daysSinceLastShown
```

- **First 2 impressions are free** — being surfaced twice is the system doing its job, not evidence of dismissal.
- Each further actionless impression adds **0.1**, hard-capped at **0.6** — a discount never buries an item outright.
- The whole value decays by **0.9 per day since the item was last shown** (LinkedIn-style ImpCount × LastSeen decay).
- **Hard exemptions:** an item carrying a due date (`📅 YYYY-MM-DD`) or top priority (`🔺`) has discount 0, always. Deadlines and explicit top priority outrank inferred boredom.

The fact's value records `{ anchor, body, discount, impressions, lastShown }` (subject = the origin page; sourceRef pins the origin line + stable id). A fact is emitted only while `impressions ≥ 1`; it converges (re-runs over unchanged content emit identical facts, and the projection sink's per-path fact resolution clears stale rows).

**Recovery is built in — demotion self-heals.** An item that stops being shown decays at 0.9^days and climbs back on its own; a human edit to the origin file zeroes the impression count instantly. Nothing needs to be un-dismissed.

### Consumers: demote, compress — never delete

- **Open-loop ranking** (carry-forward, `today`, `prep`, `agenda-with`) demotes multiplicatively: where ranking compares recency, the effective score is `0.995^hoursSinceLastHumanChange × (1 − discount)` — implemented as an equivalent recency penalty of `log(1 − discount)/log(0.995)` hours (≈ 3 days at discount 0.3, ≈ 7.6 days at the 0.6 cap). Demotion **reorders within the same list and never drops an item**: the only truncation is the surface's pre-existing item cap. `today`/`prep`/`agenda-with` JSON rows carry an explainable `attention: { discount, impressions, lastShown }` field (`null` when undiscounted).
- **The morning brief** receives heavily-discounted items (discount ≥ 0.4) as deterministic pre-run DATA — "surfaced Nx without action" — and its charter compresses them into a single stale-loops line or one question instead of repeating them at full prominence. See [[wiki/specs/autonomous-agents]] §"`dome.agent.brief`".

The asymmetry is by construction, mirroring the Gmail lesson ("buried something important" must be the rare error): discounting compresses and reorders presentation; it never resolves, dismisses, or deletes the underlying task line. Markdown stays the source of truth; the discount is presentation-layer judgment derived from it.

## Wardens

A **warden** is an LLM-backed garden processor (`execution.class: llm`, `phase: garden`, granted `model.invoke`). It is not a new primitive — it is the model-gated shape of the existing Processor concept. The `dome.warden` bundle is **model-gated** and ships `enabled: false` by default. Two wardens ship:

### `dome.warden.integrity` — questions-only knowledge-integrity reviewer

The integrity warden reads `wiki/**/*.md`, asks the model to find knowledge-integrity problems (contradictions, stale claims, dangling references), and surfaces each finding as a **`QuestionEffect`** — never a fact and never a knowledge patch. Its capabilities are `read` + `model.invoke` + `question.ask`; it deliberately declares neither `patch.auto` over knowledge nor `graph.write`.

This is structurally required by [[wiki/invariants/MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS]]: a garden `model.invoke` processor is **not** re-run during projection rebuild (model calls are excluded from rebuild), so any `FactEffect` it emitted would silently vanish on `dome rebuild`. The warden's judgment is transient; it becomes durable only through the **resolution-is-durable** contract: a human or agent answers the question via `dome resolve`, the answer is recorded in `answers.db`, and rebuild rehydrates that answer. The companion **`dome.warden.integrity-answer`** handler (an `answer`-triggered garden processor, `read` only) reacts to the resolved answer. Model output proposes; the human/agent resolution disposes, and only the disposition is durable.

### Precision: the claims pre-filter + the confidence gate

The warden was over-flagging (legitimate synthesized prose tripping the self-corroboration / inference-as-fact classes). Two coupled mechanisms gate emission — both keep the questions-only / no-graph-write / rebuild-safe posture (the warden reads facts but still emits **only** `QuestionEffect`s, never a `FactEffect`):

- **Deterministic claim-collision pre-filter (the claims consumer).** The warden reads `dome.claims.claim` facts through its garden-phase `ctx.projection` view — garden processors get the same scoped read-only projection surface as view processors (see [[wiki/specs/processors]]; `dome.agent.brief` reads its open-question batch the same way). It groups claims by (page, normalized key) using the claims bundle's own `normalizeClaimKey`, and any key on one page asserted with **two or more distinct values** is a mechanical contradiction. Each collision becomes a **high-risk contradiction `QuestionEffect` directly** — no model call needed to re-derive it from prose — with an idempotencyKey keyed on the page content hash + the normalized key, so it settles when the page is reconciled. Cross-page contradiction stays the model's judgment; same-page key collision is the honest deterministic subset the facts make cheap. This wires `dome.claims.claim` to its intended consumer (see [[wiki/specs/claims]] §"Consumers").
- **Confidence floor + noisy-class suppression.** Model findings below `extensions.dome.warden.config.question_confidence_floor` (a number in `[0,1]`, conservative default `0.6`) do not become questions. Independently, the two noisiest classes — **self-corroborating** and **inference-as-fact** — are suppressed unless a same-page mechanical collision backs them; the deterministic pre-filter is the only signal trusted to un-suppress them. `historical-as-ongoing` and model `contradiction` findings are unaffected beyond the floor + the existing low-severity drop. The floor mirrors the `model_override` degrade-not-crash idiom (see [[wiki/specs/autonomous-agents]] §"Model routing"): a malformed value falls back to the default with one `dome.warden.confidence-config-invalid` warning diagnostic per run, never a crashed review.

### Stale-claim flags resolve via supersession

When the integrity warden flags a **stale claim** (a page asserting something the vault has since outgrown), the durable resolution is usually not a rewrite — it is the supersession status flip from [[wiki/specs/page-schema]] §"Supersession (ADR pattern)": set `status: superseded` + `superseded_by: "[[<current page>]]"` on the stale page (or move the stale portion under a `## Superseded` section on a mixed page). The flip lives in markdown, so it survives rebuild without violating [[wiki/invariants/MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS]] — the warden's transient judgment becomes durable through an ordinary resolved question whose disposition is a one-line frontmatter change, and lint + ranking take it from there deterministically.

### No-op without a model

The integrity warden **degrades to a clean no-op** when no model provider is configured. With `model.invoke` ungranted or no provider wired, the warden returns no effects rather than failing — it is never a failed run. This keeps a vault with the warden enabled but no model key fully green.

## Related

- [[wiki/invariants/MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS]] — the hard rule wardens hold: no garden `model.invoke` processor declares `graph.write`
- [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]] — why model judgment must not become a durable fact, and why attention-discount facts are clock-free
- [[memory]] — the memory-quality plan; M4 is attention discounting (decision ledger entry 5: implicit dismissal, self-healing, 📅/🔺 exempt)
- [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]] — anchors live in markdown; answers live in `answers.db`
- [[wiki/invariants/ENGINE_COMMITS_CARRY_DOME_TRAILERS]] — the `Dome-Run` split behind `lastHumanChangedAt`
- [[wiki/specs/capabilities]] — `model.invoke`, `graph.write`, `patch.auto`, `question.ask` tiers
- [[wiki/specs/processors]] — phases, triggers, `execution.class: llm`, idempotency
- [[wiki/specs/effects]] — `QuestionEffect`, `PatchEffect`, `FactEffect`
- [[wiki/specs/adoption]] — why garden-phase denials don't block the human
- [[wiki/specs/daily-surface]] — the daily note as a product surface; where the hygiene processors sit in the 24-hour choreography
- [[wiki/gotchas/garden-cascade-cap]] — why the briefing warden is cron-only
