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
  - cohesion
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

# Daily Phase 2 — one task model: origin, creation, attention

Approved design, 2026-06-15. Revised after a full cohesion audit of the
`dome.daily` plugin, the `dome.agent` daily-writers, and the daily-surface /
task-lifecycle specs. **This Phase nets to a *smaller* surface, not a bigger one**:
it unifies grammars and mechanisms that had started to fragment, fixes two latent
bugs, finishes one half-built path, and deliberately cuts the one genuinely new
concept.

## The unified task model (the thing we are building toward)

A daily task has exactly **four properties**, each owned by **one** mechanism, and
every machine-created task flows through **one** creation seam. Phase 2 completes
and unifies these axes — it does not add new ones.

| Property | Single owner | Phase 2 work |
|---|---|---|
| **Identity** | `^id` block anchor (`stamp-block-id`) | none — already clean |
| **Origin** (where it came from) | one inline marker `([↗](target))` + the captured-task **seam**; surfaced as one structured field | **unify** the grammar, fix bugs, make it a first-class field, render it uniformly, extend target to Slack URLs |
| **Attention** (staleness) | `dome.attention.discount` facts → the brief's stale-loop pass | **finish** the half-built settle path |
| **Label** (brevity) | task-creating charters + the seam's length cap | **dedupe** into one shared charter fragment |
| **Creation seam** | the captured-task seam (`appendCapturedTaskLines` / `capturedAwareAppendTool`) | **one** caller becomes **two** (ingest + brief) |

## What this cleans up (audit findings → fixes)

1. **Three inline-link grammars → two.** Shipped today: `(from [[…]])`
   carry-forward *copy* suffix (internal, drives `reconcile`) and `([↗](target))`
   *origin* marker (user-facing). The earlier draft would have added a **third**
   (`[thread](url)` + a `taskSourceLink` helper). **Cut it.** Slack is just an
   external *target* of the existing origin marker. The two surviving grammars are
   distinct concepts (copy-provenance vs. source-provenance) and stay distinct.
2. **One marker, two regexes, one bug.** `ORIGIN_MARKER_RE` (detect, in
   captured-block) and `ORIGIN_MARKER_BODY_RE` (strip, in action-extraction) both
   describe `([↗](…))` but live in different files; the strip regex's `[^)]*`
   **breaks on a URL containing `)`** (a real Slack-permalink case). **Fix:** one
   shared, `)`-safe definition, imported by both.
3. **Origin renders two ways today — fix to one.** Capture markers are stripped
   and *invisible* in `dome today`; hand-authored `[thread](url)` links *show*. The
   cohesion rule (your call): **a task's origin renders as one clickable `↗`
   affordance in `today`, whatever path created it** — and origin becomes a
   first-class structured field so the render and the hash never fight.
4. **Stale loops: finish, don't fork.** The brief already receives
   `discount ≥ 0.4` items and is told to "raise one askOwner," but the question is
   unstructured and has **no answer-handler**, so nothing settles. **Finish it**
   into a structured settle question + handler. No new staleness channel.
5. **Charter brevity instruction would be a 4th copy-paste.** preference-signals /
   superseded-pages / untrusted-input are already duplicated across 3–4 charters.
   **Fix:** one shared charter-fragment module; brevity lives there once.
6. **Cut the clustering warden.** Auto-clustering related loops (a new warden + an
   umbrella-page answer-handler) is the only net-new *concept* and the largest new
   surface. **Deferred.** The stale-settle question may *note* related loops as
   context, but Dome does not auto-group.

---

## P1 — Complete and unify the origin axis

Render is already universal (Phase 1 today work turns any affordance clickable);
P1 makes "origin" one coherent, first-class thing and lets Slack ride it.

### P1.1 One shared marker primitive
A single grammar `([↗](target))`, target = a vault-relative path **or** an
external URL. One exported module owns three pure functions — `appendOriginMarker`,
`hasOriginMarker`, `stripOriginMarker` (and `parseOriginMarker(line) → {body,
target}`) — with **one** `)`-safe regex. `action-extraction` imports them; the
duplicate `ORIGIN_MARKER_BODY_RE` is deleted. `)`-safety: match the whole
`([↗](…))` to the final `))` (balanced), or require callers to percent-encode —
the primitive does the encoding so callers can't get it wrong.

### P1.2 Origin as a first-class field
`task-index` parses the origin target out of each task line via the shared
primitive and carries it as a **structured field** on the `dome.daily.open_task` /
`dome.daily.followup` projection; the marker is stripped from the body used for
objectString / hashing / dedup / reconcile keys (as today). So identity is
marker-free and origin is queryable — not smuggled in the display string.

### P1.3 One render rule
`today-view` carries `origin` onto `TodayTaskRow`; `formatTodayResult` renders it
as **one** trailing `↗` affordance for every task that has one: an external URL →
OSC 8 hyperlink to the URL; a vault path → OSC 8 hyperlink to `file://<abs>` so
⌘-click opens the capture/note. Capture and Slack origins look and behave
identically. (Obsidian keeps rendering the inline marker natively.)

### P1.4 Slack permalinks available
`slack-day` grammar gains an **optional trailing autolink** per entry
(`… <https://…slack.com/…>`); backward-compatible (the defensive parser ignores
unknown trailing tokens). `parseSlackDigest` gains a `permalink?` field.
`claude-slack.sh` instructs emitting each message's permalink (Web API
`chat.getPermalink` / connector tools return it). Template + grammar only.

### P1.5 Creation wires the target
`dome.agent.ingest` already stamps the origin via the seam. Extend: when a capture
carries a source URL (`source_url:` frontmatter, or a bare Slack URL in the body),
ingest passes that URL as the origin target (guard: `https://`, Slack-shaped
preferred) instead of the archived-capture path. The seam already takes an
arbitrary target — no seam change.

**P1 ships:** capture *and* Slack origins, created by share/capture or your
foreground scrape, render as one identical clickable `↗` in `dome today`. One
grammar, one field, one render, one strip.

---

## P2 — One task-creation seam (the brief joins ingest)

### P2.1 The brief writes findings through the *same* seam
The captured-task seam is the single sanctioned task-creation surface. The brief
gains the same `capturedAwareAppendTool` ingest uses (extract it so both bundles
construct it identically) and may write genuinely **actionable** Slack/meeting
findings as `- [ ] #task <label> ([↗](permalink))` lines **through that seam** —
never as checkboxes in its summary blocks. The "no checkboxes in summary blocks"
rule (R3) stays in force; the seam's per-line validation is the injection/format
fence for untrusted Slack text.

### P2.2 Required governance (the spec's own rule)
daily-surface.md §"The section contract" is normative: *any* new daily-writer must
claim a block-ownership + section-contract row before shipping. So P2 **must**
update the `dome.daily:captured` block-ownership cell and the `## Captured today`
section-contract row to name the brief as a co-writer-through-the-seam (alongside
the skeleton and ingest). This is the mechanism that prevents the very accretion
you're worried about — we use it.

### P2.3 Cross-night dedup without a registry
The brief must not re-emit the same finding nightly. Per `NO_ACCRETING_REGISTRIES`,
the seen-state is **not** a vault ledger — it's the existing reconcile/anchor
reality: a re-seen finding matches an already-`^id`-anchored task (the seam rejects
dup-shaped lines; reconcile matches by body), so a second night does not
double-create. A per-day brief-owned marker block records what was surfaced today
(same posture as `dome.agent.brief:sources`).

### P2.4 Brevity, once
A shared charter-fragment ("write a short scannable label — imperative + who/what,
≤ the seam cap; long context goes in the linked note, never the task line") is used
by **both** ingest and brief. The existing duplicated fragments (preference-signals,
superseded, untrusted-input) move into the same module in passing. Render's
`shortenLabel` stays the safety net; this reduces how often it fires.

---

## P3 — Finish the attention/stale path (no new channel)

The brief already gets `discount ≥ 0.4` items as deterministic pre-run DATA and is
told to "raise one askOwner." P3 makes that **resolvable**:

- **Structured settle question.** For tasks both heavily discounted (≥ 0.4) **and**
  overdue beyond a threshold (default **14 days**), the brief raises **one**
  `dome.agent.brief:settle-stale:<anchor>` question per night — options
  close / defer / keep — carrying the task anchors in metadata. No auto-close
  (propose-not-auto, R5).
- **A deterministic answer-handler** (`settle-stale-answer`, the established
  warden/answer pattern — like `sweep-answer`) applies the disposition: `close`
  marks the origin line `[-]` (which `reconcile` then propagates), `defer` snoozes
  (a due-date bump), `keep` records the acknowledgment so the question doesn't
  recur. Model proposes; the answer disposes; only the disposition is durable
  (`MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS`, R4).
- The question **may list related loops** (shared entity/wikilink) as context to
  help the batch decision — but Dome does not auto-group or auto-write umbrellas.

---

## Architecture & boundaries

- **No new primitive.** P1 = a shared pure module + a projection field + render.
  P2 = the brief calling an existing seam. P3 = a structured question + a
  deterministic answer-handler (the warden pattern). ([[wiki/specs/autonomous-agents]])
- **Propose-not-auto** for every owner decision (P3); the brief never closes,
  merges, defers, or deletes a task itself.
- **Markdown is source of truth.** The origin marker lives in committed markdown;
  the structured field is a rebuildable projection of it.
- **Block ownership is the write boundary** — P2 updates the normative tables; the
  brief writes the captured block only through the validated seam.
- **Re-ingestion safety** (the load-bearing P2 constraint) comes from the seam +
  `^id` anchoring + reconcile, exactly as for ingest.

## Decomposition into plans

- **Plan 1 — origin axis (the cohesion core):** shared marker primitive (one
  `)`-safe regex; delete the duplicate); origin as a structured projection field;
  one `today` render rule (URL + `file://`); `slack-day` permalink grammar + parser
  field + `claude-slack.sh`; ingest wires URL targets from captures. Tests: parse
  handles `)`-in-URL; capture & slack both render one clickable `↗` in today;
  hashing/dedup unaffected by markers; slack-day parses with/without permalink.
- **Plan 2 — one seam:** extract the captured-seam tool for shared use; brief emits
  findings-as-tasks through it; block-ownership + section-contract table updates;
  per-day seen-block; shared charter-fragment module (brevity + the deduped
  fragments). Tests: brief task lands in the captured block with a permalink marker;
  summary blocks stay checkbox-free; re-run doesn't double-create; cap enforced.
- **Plan 3 — finish stale:** structured `settle-stale` question (discount + overdue
  threshold) + `settle-stale-answer` handler (close/defer/keep). Tests: stale set
  raises one structured question; each disposition applies correctly and is
  idempotent; no auto-mutation without an answer.

## Non-goals (what we are deliberately NOT building)
- **No clustering warden / umbrella pages** (the one cut feature; deferrable later).
- **No `[thread](url)` grammar or `taskSourceLink` helper** (folded into the one
  origin marker).
- **No new staleness channel** (we finish the existing one).
- **No change to the page consolidator** (`dome.agent.consolidate` stays page-only).
- **No new capture transport** (share path reuses `dome capture` + `source_url:`).

## Open decisions (flag for review)
- **Stale threshold** = 14 days overdue *and* discount ≥ 0.4. Adjustable.
- **Capture URL source** = `source_url:` frontmatter (primary), bare in-body Slack
  URL (fallback).
- **Brief task-emission scope** = Slack mentions/DMs that read as a request + meeting
  prep actions only (bounds the no-checkbox reversal).
- **`file://` affordance for capture origins** in the terminal — included; if it
  proves noisy we can fall back to "external URLs only render in `today`, capture
  origins stay Obsidian-only" (your option B), a one-line render change.
