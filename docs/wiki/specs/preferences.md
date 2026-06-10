---
type: spec
created: 2026-06-09
updated: 2026-06-09
sources:
  - "[[memory]]"
  - "[[wiki/specs/autonomous-agents]]"
  - "[[wiki/specs/vault-layout]]"
---

# Preference promotion

This spec is normative for Dome's preference-promotion mechanism (memory-quality
plan [[memory]] M5): how owner corrections become **signals** in markdown, how a
deterministic dream pass tallies them into **counter facts**, when a candidate
rule becomes a **promotion question**, and how the answer-mediated handler — the
single auto-writer to `core.md` — lands a **promoted preference** or a
**rejection tombstone**. No new primitive: two deterministic garden processors
plus one answer handler, all in the `dome.agent` bundle.

Decision 6 of the [[memory]] ledger is the contract: **promotion is
counter-based** (3 same-sign signals in 30 days → candidate; Wilson 95% lower
bound × 90-day freshness as confidence), never one-shot LLM judgment.

## The signal convention — `preferences/signals.md`

`preferences/signals.md` is an **append-only** markdown file of dated, signed
signal lines. By the [[wiki/specs/vault-layout]] category table it is
`external` — a documented convention, not a new category. One line per signal:

```markdown
- 2026-06-09 + filing:: meeting notes go under notes/, not entities/ (source: [[wiki/dailies/2026-06-09]])
- 2026-06-11 - filing:: kept this meeting page under entities/ on purpose (source: [[wiki/entities/danny]])
```

Grammar (one line, no wrapping):

```
- YYYY-MM-DD [+|-] <topic-slug>:: <rule text> [(source: [[...]])]
```

- **Date** — the day the signal was observed.
- **Sign** — `+` is a correction *supporting* the rule; `-` is evidence
  *against* it.
- **Topic slug** — lowercase `[a-z0-9-]`; the aggregation key (`filing`,
  `naming`, `formatting`, `scope-dailies`, …). Writers reuse an existing topic
  slug when the correction is about the same behavior.
- **Rule text** — the candidate standing preference, phrased as the rule
  itself (imperative, one line). The **most recent `+` line's rule text** is
  the candidate rule proposed verbatim at promotion time.
- **Source** — optional trailing `(source: [[wikilink]])` naming where the
  correction happened.

Parsing is defensive: blank lines, headings, and HTML comments are ignored; a
`- ` list line that fails the grammar is **malformed** — the counter processor
reports all malformed lines in one `info` diagnostic and never crashes
(config-fallback temperament, same as the consolidator). A `- ` list line
containing an HTML comment delimiter (`<!--` or `-->`) is malformed
regardless of the rest of its grammar: rule text is otherwise free-form, and
a crafted correction could smuggle the promoted-block markers through owner
promotion into `core.md` and mis-bound the generated block (the
marker-injection gotcha).

**Who writes signals:**

- **Background agents** (ingest / consolidate / brief): each charter carries
  one standing instruction — when the owner's content *explicitly corrects
  agent behavior* (filing location, naming, formatting, scope), append a
  signal line. This is an ordinary write within the agent's grant
  (`preferences/signals.md` is in each agent's `read` + `patch.auto`
  declaration), but the page is **append-only at every model seam**: ingest
  and consolidate enforce it at tool time (`signalsAppendOnlyGuard` in
  `vault-tools.ts` rejects any signals-page write that is not an append of
  well-formed signal lines, and refuses deletion outright — the model sees an
  ordinary tool error and self-corrects mid-loop), and the brief enforces the
  same rule post-run in its splice guard (a non-append signals edit is
  dropped as out-of-scope). Owner rejection tombstones can therefore never be
  rewritten or deleted by a model.
- **Foreground agents** (Claude Code et al.): the vault `AGENTS.md` template
  documents the same convention — append a signal line when the owner corrects
  vault-maintenance behavior.
- **The answer handler** appends rejection tombstones (below).

**Out of scope (follow-up):** git-derived signals — revert detection (owner
reverts an engine commit) and post-ingest file moves (owner re-homes a page
the agent filed) — would make signals partially implicit. Banked as future
work; v1 signals are explicitly written at correction time, keeping the
algorithm LLM-free and the file legible.

## Counter facts — `dome.agent.preference-signals`

A deterministic garden processor (read + `graph.write` over
`dome.preference.*` only — **rebuild-eligible**, like
`dome.daily.attention-discount`) parses `preferences/signals.md` and the
promoted block in `core.md`, and emits one `dome.preference.topic` fact per
topic:

```json
{
  "topic": "filing",
  "plusInWindow": 3,
  "minusInWindow": 0,
  "firstSignal": "2026-06-01",
  "lastSignal": "2026-06-09",
  "state": "candidate",
  "rule": "meeting notes go under notes/, not entities/",
  "confidence": 0.4386
}
```

- **Reference date** — the newest signal date in the file, NOT the wall clock
  (no-clock rule, same as attention discounting), so facts re-derive
  byte-identically on `dome rebuild` per
  [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]].
- **Window** — a signal is *in window* when `referenceDate − date ≤ 30 days`
  (inclusive at the boundary).
- **State machine** (first match wins):
  1. `rejected` — any owner-rejection tombstone for the topic, any age.
  2. `promoted` — the topic appears in `core.md`'s promoted-preferences block.
  3. `rebutted` — `minusInWindow ≥ 3`.
  4. `candidate` — `plusInWindow ≥ 3`.
  5. `building` — anything else.
- `rule` is the most recent `+` line's rule text (null when the topic has no
  `+` line); `confidence` is the formula below evaluated at the reference
  date.
- Subject: the `preferences/signals.md` page; sourceRefs point at the topic's
  most recent signal line. Vanished topics clear on any run (the projection
  sink clears inspected paths' facts before insert; inspection is
  all-readable-markdown).

## The confidence formula

```
confidence = wilson95(plusInWindow, plusInWindow + minusInWindow)
           × freshness(daysSinceLastSignal)
```

- **Wilson 95% lower bound** on the supporting share, z = 1.96:

  ```
  p̂ = plus / n          (n = plus + minus; n = 0 → confidence 0)
  wilson95 = (p̂ + z²/2n − z·√(p̂(1−p̂)/n + z²/4n²)) / (1 + z²/n)
  ```

  Three unopposed signals score ≈ 0.4385 — deliberately humble; small-n
  certainty is the failure mode Wilson exists to prevent.

- **Freshness decay** — linear from 1.0 at age 0 to 0.0 at 90 days since the
  topic's last signal (age measured against the reference date):

  ```
  freshness = max(0, 1 − daysSinceLastSignal / 90)
  ```

- Rounded to 4 decimals so emitted facts and question metadata are
  byte-stable.

The formula is implemented once in the shared bundle library
(`assets/extensions/dome.agent/lib/preferences-shared.ts`) with unit tests;
the counter processor, the promotion processor, and the answer handler all
call the same functions.

## Promotion questions — `dome.agent.preference-promotion`

A second deterministic garden processor (read + `question.ask`; signal
triggers on `preferences/signals.md` and `core.md`) emits one `QuestionEffect`
per **candidate** topic:

- **Condition** — state `candidate` exactly: ≥ 3 same-sign (`+`) signals in
  the 30-day window AND not already promoted (the `core.md` block is checked)
  AND not rebutted (≥ 3 `-` in window) AND not owner-rejected.
- **Question** — proposes the candidate rule **verbatim**, quoting the
  in-window evidence lines.
- **Options** — `promote`, `reject`.
- **Idempotency key** — `dome.agent.preference-promotion:<topic>:<rule-hash>`
  (an 8-hex FNV-1a hash of the rule text). One open question per
  topic + rule; re-emission refreshes the open row (projection-table
  semantics), an answered row stays answered — no re-ask, no duplicate while
  open. A *changed* candidate rule changes the hash and asks fresh.
- **Metadata** — `automationPolicy: "owner-needed"` (promotions change agent
  behavior — the owner decides; never auto-resolved), `confidence` from the
  formula above, and an `ownerNeededReason`.
- **SourceRefs** — one per quoted evidence line in `preferences/signals.md`.

## The answer handler — `dome.agent.preference-promotion-answer`

Garden processor with an `answer` trigger
(`questionProcessorId: dome.agent.preference-promotion`, key prefix
`dome.agent.preference-promotion:`). It re-derives the topic's candidate state
from the **current snapshot** (same shared lib) and verifies the rule hash in
the question key still matches; a stale question (signals moved on) yields an
`info` diagnostic and no write.

**On `promote`** — one `PatchEffect (mode: "auto")` splicing the rule into
`core.md`'s promoted-preferences generated block:

```markdown
<!-- dome.agent:promoted-preferences:start -->
- filing:: meeting notes go under notes/, not entities/ (confidence 0.44)
<!-- dome.agent:promoted-preferences:end -->
```

- Marker-delimited like the brief's daily-note blocks; markers are
  `<!-- dome.agent:promoted-preferences:start -->` /
  `<!-- dome.agent:promoted-preferences:end -->`.
- The block is created when absent — inserted after the
  `## Standing preferences` heading when present, appended at the end
  otherwise; an absent `core.md` is created with a minimal skeleton.
- Entries are **sorted by topic**, one line each:
  `- <topic>:: <rule text> (confidence <0.NN>)`. Re-promoting a topic
  replaces its line. Confidence is recomputed at answer time.
- Idempotent: when the spliced content equals the current page, no effect is
  emitted (answer-handler retries are harmless).
- **Marker hygiene** (defense in depth behind the parse-time delimiter ban):
  the splice strips the block markers and any leftover `<!--`/`-->`
  delimiters from the rule before rendering, and locates the existing block
  by a *line-anchored* marker scan — a marker counts only when it is the
  entire (trimmed) line, so prose or fenced mentions of the marker text are
  never mistaken for the block bounds.

**On `reject`** — one `PatchEffect (mode: "auto")` appending a tombstone
signal line to `preferences/signals.md`:

```markdown
- 2026-06-12 - filing:: rejected by owner
```

The tombstone is an ordinary `-` line whose rule text is exactly
`rejected by owner`; the counter parses it as an **owner rejection** and the
topic's state becomes `rejected` permanently — the promotion processor stops
re-proposing it. (Rebuttal without the owner: ≥ 3 `-` signals in the window
retire the topic to `rebutted` for as long as the window holds them.)

## The single-auto-writer exception (decision 4)

`core.md` is **propose-only for interactive agents**: it appears in every
agent's `read` declaration and in **no other** `patch.auto` declaration. The
promotion answer handler is the one exception — the question *was* the review,
so its write is owner-mediated by construction. The grant shape:

- **Manifest** — `dome.agent.preference-promotion-answer` declares `read` +
  `patch.auto` over exactly `core.md` and `preferences/signals.md`.
- **Vault config** — the bundle-level `dome.agent` grant keeps `core.md` out
  of `patch.auto` (the canonical propose-only shape); the handler gets a
  **per-processor replacement grant** under
  `extensions.dome.agent.processors.dome.agent.preference-promotion-answer.grant`
  with the same narrow pair. The broker resolves grants per processor
  (`grantsForProcessor`), so every other processor's `core.md` patch is still
  downgraded/denied.
- The manifest lockstep test pins the exception: `core.md` in the `patch.auto`
  declaration of exactly this one processor, bundle-wide.

## Lifecycle summary

```
owner corrects agent behavior
  → signal line appended (charters / foreground AGENTS.md / by hand)
  → dome.agent.preference-signals: dome.preference.topic facts (rebuildable)
  → ≥3 same-sign in 30d, not promoted/rebutted/rejected
  → dome.agent.preference-promotion: QuestionEffect (owner-needed,
    confidence = Wilson × freshness)
  → owner answers
      promote → handler splices core.md's promoted block (sole auto-writer)
      reject  → handler appends a tombstone; topic retired
  → counter sees promoted/rejected state and stays quiet
```

## Follow-ups — the full OSB lifecycle

This v1 ships the *acquisition* half of the Open Second Brain lifecycle.
Banked as future pressure, in dependency order:

1. **Applied/violated tracking.** Promoted rules do not yet track how often
   agents applied vs. violated them. The target: agents record
   applied/violated counters (deterministically derivable evidence, e.g.
   post-run lint of the rule), `applied ≥ 10 ∧ violated = 0` marks a rule
   high-confidence.
2. **Quarantine on violation.** When `violated ≥ applied`, the rule is
   quarantined — dropped from the injected block pending owner review — via
   the same question/answer machinery. Out of scope until (1) exists.
3. **Git-derived signals.** Revert detection and post-ingest move detection
   as implicit `-`/`+` signals (see §"The signal convention").
4. **Grant-level `core.md` exclusion from `dome.markdown`'s `patch.auto`.**
   The propose-only intent (memory decision 4) is enforced for interactive
   agents (`dome.agent`'s grant excludes `core.md`), but dome.markdown's
   deterministic hygiene processors still auto-write it under the default
   `**/*.md` grant. Excluding it today produces either an adoption-blocking
   deny/downgrade or a silently-dropped garden patch — not a review
   proposal (see [[wiki/specs/vault-layout]] §"`core.md`" for the full
   analysis). Gate the exclusion on the garden propose review queue (the
   `garden.patch-propose-review-unavailable` follow-up in
   [[wiki/specs/effects]]), then pin it with a test that a
   `normalize-frontmatter` patch against `core.md` lands on the visible
   review path instead of vanishing.

## Related

- [[memory]] — the plan of record; decisions 4 and 6
- [[wiki/specs/autonomous-agents]] §"Core-memory injection (`core.md`)" — the
  propose-only grant shape this spec's handler excepts
- [[wiki/specs/vault-layout]] §"`core.md`" and §"`preferences/signals.md`" —
  file conventions
- [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]] — why the counter is
  clock-free
- [[wiki/invariants/MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS]] — why the
  counter is deterministic (the bundle's model processors still declare no
  `graph.write`)
- [[wiki/specs/task-lifecycle]] §"Attention discounting" — the sibling
  deterministic-collect pattern (M4)
