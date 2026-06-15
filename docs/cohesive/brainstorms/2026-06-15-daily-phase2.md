---
type: brainstorm
tags:
  - design
  - daily
  - cockpit
  - sources
  - slack
  - capture
  - brief
  - task-lifecycle
  - second-brain
created: 2026-06-15
updated: 2026-06-15
status: approved-design
sources:
  - "[[cohesive/brainstorms/2026-06-15-task-origin-links]]"
  - "[[cohesive/brainstorms/2026-06-15-dome-today-readability]]"
  - "[[wiki/specs/daily-surface]]"
  - "[[wiki/specs/task-lifecycle]]"
  - "[[wiki/specs/sources]]"
  - "[[wiki/specs/vault-layout]]"
  - "[[wiki/specs/autonomous-agents]]"
  - "[[wiki/specs/capture]]"
---

# Daily Phase 2 — Slack source-links + content density

Approved design, 2026-06-15. Two coupled outcomes, planned together because both
converge on the brief and the daily's task surface:

1. **Source-links for any finding.** Every Slack-derived TODO carries a clickable
   backlink to its thread, *regardless of which path created it* — share/capture,
   the morning Slack scrape (foreground), or the brief.
2. **Content density at the source.** The daily gets materially less dense — short
   scannable task labels, related open loops grouped, stale-overdue surfaced for a
   decision — so `dome today` isn't just *rendered* calmly (Phase 1) but *is* calm.

## What's already true (so we don't rebuild it)

- **Render is universal and done** ([[cohesive/brainstorms/2026-06-15-dome-today-readability]]):
  `dome today` turns *any* inline `[label](url)` in a task body into a clickable
  `label↗` affordance — path-agnostic. Phase 2 is purely about getting the
  permalink onto the line at creation, then reducing volume.
- **Capture backlinks ship** ([[cohesive/brainstorms/2026-06-15-task-origin-links]]):
  the captured-task seam stamps `([↗](target))` deterministically; the grammar
  (`appendOriginMarker(line, target)`) already takes an arbitrary target.
- **Attention-discount exists:** `dome.attention.discount` facts demote
  surfaced-without-action loops; the brief already compresses stale loops into one
  bullet or an `askOwner`.
- **The captured-task seam is the safe task-creation path:** block-owned,
  `^id`-anchored, deduped. The brief's "no checkboxes" rule is about its *summary*
  blocks, not this seam.

## Decision of record

Three coherent sub-projects, designed as one, executed in one pass with a clean
merge per chunk:

- **P1 — Slack source-link foundation** (low risk): permalinks available + a shared
  convention, wired to the share/capture path.
- **P2 — Brief findings → linked tasks + title brevity** (medium): the brief emits
  actionable findings as short, source-linked `#task` lines through the captured
  seam.
- **P3 — Daily hygiene** (medium, meaning-loop): cluster related open loops and
  surface stale-overdue, both owner-questions (propose-not-auto).

---

## P1 — Slack source-link foundation

Render already makes `[thread](url)` clickable; P1 makes the permalink *available*
and gives every creator one way to stamp it.

### P1.1 `slack-day` grammar — optional per-entry permalink
[[wiki/specs/vault-layout]] §"`sources/slack/YYYY-MM-DD.md`". Each entry gains an
**optional trailing autolink**:

```markdown
## Mentions
- [#dome-dev] 22:41 alice: "look at the outbox retry PR?" <https://uniswap.slack.com/archives/C…/p…>
```

Backward-compatible: optional, the existing defensive parser ignores trailing
tokens, and `parseSlackDigest` (brief.ts) keeps its 15-entry/240-char caps. The
parser gains a `permalink?: string` field per entry, populated from a trailing
`<https://…slack.com/…>` autolink when present.

### P1.2 Fetch template emits permalinks
`assets/source-handlers/claude-slack.sh`: the prompt instructs emitting each
message's Slack permalink in the `<…>` autolink position (the Web API
`chat.getPermalink` / connector read tools return it). Template-only; consent
surface unchanged ([[wiki/specs/sources]] §"The Slack stance").

### P1.3 Shared source-link convention
The canonical way to attach a source to a task is **an inline markdown link in the
task body** (rendered clickable by Phase 1). A tiny shared helper standardizes
labels so every path looks identical:

```ts
// dome.daily — taskSourceLink: format an inline source link for a task body.
// slack → "thread", a vault path → "↗", a doc/url → host-derived or "link".
taskSourceLink(kind: "slack" | "capture" | "url", url: string): string  // → `[thread](url)` etc.
```

Captures keep the existing `([↗](path))` marker (capture path = a vault file);
external sources use a descriptive label (`[thread](url)`). Both render clickable.

### P1.4 Share/capture path stamps the URL
Extends [[cohesive/brainstorms/2026-06-15-task-origin-links]] Phase 1. When a
captured note carries a source URL — a `source_url:` frontmatter key, or a bare
Slack/URL detected in the body — `dome.agent.ingest` sets the captured task's
origin to that URL (a `[thread](url)` link) **instead of / in addition to** the
archived-capture backlink. Guard: only `https://…slack.com/…` (and generic
`https://`) targets are accepted as external; anything else falls back to the
capture backlink. The seam already stamps an arbitrary target — this only changes
*which* target ingest passes for a URL-bearing capture.

**P1 ships:** clickable Slack backlinks for the two paths that already create tasks
(share/capture + your foreground morning scrape, which now has permalinks in the
digest), with no meaning-loop reversal.

---

## P2 — Brief findings → linked tasks + title brevity

### P2.1 The brief may create findings-as-tasks (safely)
Today the brief writes Slack as summary bullets only. P2 lets it surface genuinely
*actionable* findings (a Slack mention asking you to do something, a meeting
prep action) as `- [ ] #task <label> [thread](permalink)` lines — written through
the **captured-task seam** (the same `appendToPage`→captured-block path ingest
uses), NOT as summary bullets. Why this is safe: the seam is block-owned and the
line becomes an `^id`-anchored origin extracted exactly once; the "no checkboxes"
rule stays in force for the brief's *summary* blocks (yesterday / meetings), which
remain plain `-` bullets. The brief charter gains: "an actionable Slack/meeting
finding may be written as ONE captured `#task` line carrying its `[thread](url)`
permalink via the captured-tasks tool; everything else stays a summary bullet."

Dedup: the captured seam already rejects duplicate-shaped lines, and a finding
re-seen on a later night matches an existing anchored task (reconcile), so a
re-run does not double-create. The brief records surfaced findings to avoid
re-emitting across nights (reuse the brief's existing seen-state / ledger posture).

### P2.2 Title brevity at the source
The locus is the same task-writing seam. Task-creating charters (ingest **and**
brief) get an explicit brevity instruction: **write a short, scannable label**
(the imperative + the who/what, target ≤ ~80 visible cols); the long context
belongs in the linked note/source, never the task line. Reuse the existing
`CAPTURED_LINE_MAX_CHARS` posture as the hard cap; the charter guidance is the soft
target. No new processor — this is charter + the existing seam cap. (Render's
`shortenLabel` is the safety net; this reduces how often it must fire.)

---

## P3 — Daily hygiene (open-loop pass)

Strengthen the brief's existing stale-loop pass into one **open-loop hygiene**
step, propose-not-auto (aligned with the warden principle: model judgment
transient, owner resolution durable; never auto-mutate the owner's tasks).

### P3.1 Stale-overdue surfacing
Deterministic input: tasks that are overdue beyond a threshold (default **14
days**) and/or carry a high `dome.attention.discount`. The brief raises **one**
owner question per night proposing a batch decision — close / defer / keep — over
the stale set, citing the tasks (it already has the discount data in its task
turn). No auto-close. This extends the brief's current "stale loops → one bullet
or askOwner" into a structured, resolvable question.

### P3.2 Related open-loop clustering
The brief detects clusters of related open loops — shared entity, `[[wikilink]]`,
or project (e.g. the routing-retention pile: Cody + Siyu + Charles + pod-level) —
and raises **one** owner question proposing to group them under a single tracked
thread (a wiki page / one umbrella task), never auto-merging. The grouping is the
owner's call; the brief only proposes and, on a `group` answer, writes the umbrella
(an answer-handler, like other wardens). Clustering signal: ≥3 open loops sharing
an entity/wikilink within the active set.

**P3 ships:** the daily stops accreting — stale items get a close/defer decision,
related piles collapse to one thread — which is what actually shrinks 239 → legible.

---

## Architecture & boundaries

- **No new primitive.** P2/P3 are garden-phase brief behavior (autonomous-agent
  model) + reused `dome.daily` seam/grammar. P1 is grammar + template + a shared
  helper. ([[wiki/specs/autonomous-agents]], [[wiki/invariants/MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS]]
  — questions are durable via answers.db, not facts.)
- **Propose-not-auto** for every owner-facing decision (P3). The brief never
  closes, merges, or deletes a task on its own.
- **Source links are committed markdown** (render-agnostic, rebuild-safe) — never a
  projection.
- **Re-ingestion safety** is the load-bearing constraint for P2; the captured seam
  + `^id` anchoring + reconcile provide it.

## Decomposition into plans

- **Plan 1 (P1):** slack-day grammar + parser field, `claude-slack.sh` template,
  `taskSourceLink` helper, ingest URL-stamping for captures. Tests: parser permalink
  extraction; helper labels; ingest stamps a `[thread](url)` for a `source_url:`
  capture; render shows it clickable (integration).
- **Plan 2 (P2):** captured-task tool added to the brief toolset; brief charter
  findings-as-tasks + brevity; seen-state to avoid cross-night dup. Tests: brief
  emits a captured `#task` with permalink through the seam; summary blocks stay
  checkbox-free; re-run doesn't double-create; brevity cap enforced.
- **Plan 3 (P3):** brief open-loop hygiene — stale-overdue question (threshold +
  discount) and related-loop clustering question + group answer-handler. Tests:
  stale set raises one question; cluster of ≥3 shared-entity loops raises one group
  question; `group` answer writes the umbrella; no auto-mutation.

## Non-goals
- No auto-close / auto-merge of tasks (always owner-decided).
- No change to the page consolidator (`dome.agent.consolidate` stays page-only).
- No new capture transport (the share path reuses existing `dome capture` +
  `source_url:` frontmatter or an in-body URL).
- Calendar/web-finding tasks beyond Slack are supported by the same grammar but not
  separately specced here (Slack is the driving case).

## Open decisions (flag for review)
- **Stale threshold** = 14 days overdue (and/or discount ≥ hero floor). Adjustable.
- **Cluster trigger** = ≥3 open loops sharing an entity/wikilink. Adjustable.
- **Capture URL source** = `source_url:` frontmatter (explicit) vs. first bare URL
  in the body (implicit). Spec picks `source_url:` as primary, in-body bare Slack
  URL as a fallback.
- **Brief task emission scope** = Slack + meeting actions only (not arbitrary
  findings), to bound the no-checkbox reversal.
