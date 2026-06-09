# Concept Consolidator — the vault-janitor agent — design

- **Status:** Draft for review (brainstorm output; not yet normative)
- **Date:** 2026-06-09
- **Author:** Mark Toda (with Claude)
- **Builds on:** the `dome.agent` autonomous-agent framework (`docs/wiki/specs/autonomous-agents.md`) and the multi-source shared-accumulator fix.
- **Normative home (later):** a section in `docs/wiki/specs/autonomous-agents.md` (it's a second agent definition on the same framework), landing with the implementation.

---

## 1. Motivation

A knowledge vault fed by aggressive ingest drifts toward **sprawl**: duplicate pages, several slightly-varied versions of the same concept, and single pages that grew by *appending* ("## Update", "## More notes", repeated facts) instead of merging. The consolidator is the **contractive counterweight** to ingest's generative pressure — a weekly "vault janitor" that finds scattered/duplicated knowledge and fuses it into fewer, denser, canonical pages.

It is the second agent on the `dome.agent` framework. The thesis we settled on: **the agent's judgment is the power; the tools are just how it navigates.** Deterministic duplicate-finders are weak — they decide what's a dup with brittle heuristics. Instead we give the agent general primitives plus a rich charter, and let *its judgment* range over the vault using the vault's own map.

---

## 2. Decisions locked in brainstorming

- **Posture: auto-merge + commit** (not propose-only). Git + the integrity warden are the safety nets, same as ingest. **With one guardrail:** a merge must be **lossless for source-grounded facts** (fuse them, never drop), and when a merge is *genuinely ambiguous* (are these the same concept or two distinct ones?) the agent **asks rather than guesses** (a `QuestionEffect`) instead of silently fusing distinct knowledge. Auto for the confident common case; ask only for the rare ambiguous one.
- **Merge mechanic: hard-delete + link-rewrite.** Absorbing page B into canonical page A means: write the merged A, **delete B**, and **rewrite every inbound `[[…/B]]` to `[[…/A]]`** across the vault. End state = genuinely fewer pages, no dangling links, honest `index.md`.
- **Scope: (1) merge duplicate/near-duplicate pages + (2) tidy within-page append-drift.** Both *contractive*. **Defer (3)** reorganization (re-homing/splitting misfiled content) — that's generative and belongs to a later "librarian" agent.
- **Architecture: agent-driven (not a deterministic candidate-finder), made to scale via progressive disclosure over the vault's own map.**

---

## 3. Architecture — agent + primitives + the vault's own map

The agent **navigates** the vault rather than reading it. Scale comes from progressive disclosure (the context-engineering discipline): work from cheap compact maps down to full reads only where judgment is applied.

```
weekly schedule → dome.agent.consolidate (garden, kind: llm) run(ctx):
  1. read index.md (the catalog map) + log.md (recent activity) + the ledger
  2. cross-check index.md against listPages() → note orphans/strays
  3. grep for suspects: similar titles, shared inbound links, dupe phrases, drift markers
  4. read ONLY the 2–4 finalist pages in a candidate cluster
  5. adjudicate: real duplicate? confident → merge; ambiguous → ask (QuestionEffect)
  6. merge = writePage(canonical, losslessly-fused) + deletePage(absorbed)
            + rewrite inbound [[…/B]] → [[…/A]] + update index.md/log.md/ledger
  7. within-page drift: rewrite an append-drifted page into one coherent page
  8. record progress in the ledger; stop at the per-run cap
  → one cumulative PatchEffect (+ QuestionEffects for ambiguous cases)
```

**There is no `vaultOutline` tool and no candidate-finder.** `index.md` *is* the outline (path · one-line description, by type); `log.md` is the change history. The agent reads them as its map and builds its own picture with `grep`.

---

## 4. Tools — general primitives, one new addition

Reuses the framework's general tools; the only genuinely new one is `deletePage`.

| Tool | Status | Use |
|---|---|---|
| `readPage(path)` | have | read `index.md`/`log.md`/ledger and finalist pages (capped) |
| `listPages()` | have | filesystem ground truth → find orphans/strays vs `index.md` |
| `searchVault(query)` | have | substring → matching paths (inbound links, dupe phrases, drift markers) |
| `writePage(path, content)` | have | write the merged canonical page; rewrite a linking page; update index/log/ledger |
| **`deletePage(path)`** | **new** | delete the absorbed page (accumulate a `delete` edit — `archiveSource` is inbox-only) |

- **Link-rewrite uses baseline primitives:** `searchVault("[[wiki/…/B]]")` → `readPage` each → `writePage` with the link repointed to A. No special tool required.
- **Optional optimizations (flagged, not v1):** upgrade `searchVault` to a real **`grep`** (regex + return matching *lines* not just paths — lets the agent judge more without full-reads); a bulk **`rewriteLinks(from, to)`** if a page's inbound-link count makes per-link read+write too step-heavy.

---

## 5. The charter — where the intelligence lives

The charter (a bundled prompt, `lib/consolidate-charter.ts`) is the bulk of the work. It teaches:

- **Vault layout:** `index.md` = the catalog (start here); `log.md` = recent activity; pages live under `wiki/{entities,concepts,sources,syntheses}/`; cross-refs are full-path `[[wikilinks]]`; `wiki/sources/` pages are faithful records (do not merge two distinct sources just because their topics overlap).
- **The top-down hunt:** read `index.md` → scan for clusters of suspiciously-similar titles/descriptions → confirm with `searchVault` (a distinctive phrase, shared inbound links) → `readPage` only the finalists → decide.
- **Grep recipes:** inbound links = `[[wiki/<type>/<slug>]]`; within-page drift = repeated headings / `## Update` / duplicated lines; scattered topic = a distinctive phrase appearing across multiple pages.
- **Canonical selection:** prefer the page with the better slug/title, more inbound links, and richer history; fold the others into it.
- **Lossless fuse:** the merged page must retain **every source-grounded fact and `[[wikilink]]`** from all absorbed pages and union their `sources:` frontmatter. Dedupe prose, never drop facts.
- **Merge execution:** `writePage(canonical, fused)` → `deletePage(absorbed)` → rewrite all inbound links → update `index.md` (remove absorbed entries, refresh the canonical description) and append a `log.md` entry.
- **Ambiguity rule (the guardrail):** if you are not confident two pages are the *same* thing, **do not merge — `askOwner`** ("Merge `X` ← `Y`? they look related but may be distinct"). Never fuse distinct concepts to look tidy.
- **Within-page tidy:** when a single page has append-drift, rewrite it into one coherent, de-duplicated page preserving all facts + links + `## See Also`.
- **Bounded, convergent:** consult the **ledger** first (skip pairs already judged not-duplicates); prioritize recently-changed pages (fresh ingest is where new dupes are born), then rotate through one un-swept region; stop at the per-run cap and record the coverage cursor.

---

## 6. Cross-run memory — the consolidation ledger

A plain markdown file, `consolidation-ledger.md`, read/written with the same `readPage`/`writePage` tools (zero new machinery). It records:
- **Merges performed** (date, canonical ← absorbed).
- **Pairs judged NOT duplicates** — so the agent never re-litigates the same pair every week (prevents thrash/oscillation).
- **Coverage cursor** — where the last sweep stopped, so runs resume rather than restart.

This turns coverage from a *context* problem into a *time* problem: a messy vault converges over a few weekly passes; a clean vault is a cheap near-no-op.

---

## 7. Framework reuse — shared accumulator + bounded action

- **Shared in-run accumulator + single PatchEffect.** The consolidator makes many edits across the vault in one run (cluster after cluster), so it uses the *same shared-state / overlay-read* mode we just built for multi-source ingest: each merge sees prior merges' in-run edits (so link-rewrites and index updates compose), and the whole run lands as **one cumulative PatchEffect**. Per-cluster `try/catch` so a single bad merge doesn't roll back the run.
- **Bounded action + budget.** A per-run cap (`maxSteps`) and `maxDailyCostUsd`; the agent prioritizes high-confidence/recent clusters and defers the rest (via the ledger cursor). Hitting the cap emits a truncation diagnostic, not a failure.

---

## 8. Trigger, capabilities, bundle

- **Trigger:** `schedule` (weekly cron, e.g. `0 4 * * 1`), configurable; plus a `command` trigger so you can run it on demand.
- **Bundle / definition:** a new agent definition `dome.agent.consolidate` in the `dome.agent` bundle (charter + trigger + tools + grant) — no new framework primitive.
- **Grant:** `read` (`wiki/**/*.md`, `index.md`, `log.md`, `consolidation-ledger.md`) · `patch.auto` (`wiki/**/*.md`, `index.md`, `log.md`, `consolidation-ledger.md`) · `model.invoke` (`{ maxDailyCostUsd: 10 }`) · `question.ask`. Harness `budget.maxSteps: 50` (a vault-wide sweep surveys + merges several clusters; bounded action + the ledger keep one run finite). **Not `graph.write`** (`MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS`) — durable output is markdown + questions.

---

## 9. Data flow (one weekly run)

1. Schedule fires `dome.agent.consolidate`.
2. Agent reads `index.md` + `log.md` + the ledger; reconciles `index.md` vs `listPages()`.
3. Hunts top-down for candidate clusters (recent first, then a rotating region), confirming with `searchVault`, reading only finalists.
4. For each confident cluster: fuse → `writePage(canonical)` + `deletePage(absorbed)` + rewrite inbound links + update index/log/ledger. For ambiguous clusters: `askOwner`. For drifted pages: rewrite in place.
5. Stops at the per-run cap; records the cursor + decisions in the ledger.
6. Emits **one cumulative PatchEffect** (+ `QuestionEffect`s) → garden Proposal → adoption → commit (`Dome-Run` trailer).
7. `dome.markdown.validate-wikilinks` backstops any missed dangling link; the integrity warden reviews the rewritten pages.

---

## 10. Error handling & safety nets

- **Wrong merge** → `git revert` the run's commit (the rollback net); the not-dup ledger entry prevents re-merging.
- **Dangling links** the rewrite missed → flagged by `dome.markdown.validate-wikilinks` (diagnostic), fixable next run.
- **Per-cluster failure** → caught, recorded as a diagnostic; other clusters still land (shared accumulator).
- **Budget/step exhaustion** → truncation diagnostic + ledger cursor; resumes next run.
- **Idempotency** → on a clean vault (or one whose dupes are all ledger-resolved) the run is a near-no-op (no edits). Re-running is safe.
- **Lossless guardrail** → facts/links/sources are unioned on merge; ambiguity asks instead of guessing.

---

## 11. Testing strategy (TDD)

Deterministic via the injected `step` (fake scripted model) + injected reader — no network.
- **`deletePage`** accumulates a `delete` edit.
- **Merge mechanic:** scripted run where the agent writes the canonical, deletes the absorbed page, and rewrites a linking page → assert ONE PatchEffect with the canonical write + the delete + the linker rewrite.
- **Ambiguity → question:** scripted `askOwner` → a `QuestionEffect`, no delete.
- **Ledger:** the agent reads the ledger and skips a pair recorded as not-a-duplicate (assert no merge for it).
- **No-op on a clean vault:** no candidate clusters → empty effects.
- **Shared accumulator:** two clusters in one run where the second's link-rewrite must see the first merge's edit (reuses the multi-source overlay tests).
- The charter's *judgment quality* is not unit-tested (non-deterministic) — validated by manual runs + the integrity warden.

---

## 12. Resolved decisions

1. **Ambiguity guardrail — kept.** Auto-merge when confident; `askOwner` (a `QuestionEffect`) when genuinely ambiguous. The one safety that stops a tidy-looking but wrong merge from silently fusing two distinct concepts.
2. **Cadence + caps.** Weekly `0 4 * * 1` (plus a `command` trigger). `model.invoke.maxDailyCostUsd: 10`, harness `maxSteps: 50`. Bounded action + the ledger keep a single run finite and convergent.
3. **`grep` — deferred.** v1 ships with the existing substring `searchVault`. The regex + line-context `grep` upgrade is a later optimization (§13).
4. **Ledger location — top-level `consolidation-ledger.md`.** Sibling of `log.md`/`index.md`: greppable + human-visible, agent-maintained, and *outside* the `wiki/` knowledge namespace so it doesn't pollute the graph or draw integrity-warden review.

## 13. Out of scope (YAGNI / later)

Reorganization — re-homing/splitting misfiled content (operation 3, a future "librarian" agent); embedding-based similarity; sub-agent fan-out per cluster (the v2 unbounded-scale lever — dispatch a clean-context sub-agent per cluster); the bulk `rewriteLinks` tool and the regex-`grep` upgrade (optional optimizations).
