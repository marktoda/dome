# Stock Gardening Phase 1 Implementation Plan (split proposals + attic janitor + proposal-loop hardening)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the just-shipped proposal-review loop its first two producers — consolidate's page-split proposals (danny.md is the acceptance shape) and a weekly attic-sweep janitor proposing archive-moves of dead stub files — plus the four hardening follow-ups the round-4 final review flagged (stale-pending refresh, retired-processor proposal GC, apply delete support, EACCES).

**Architecture:** Delete-changes become first-class in the apply path (`commitFilesOnHead` gains tree-removal; `performApply` drops its v1 "unsupported" cut) because the janitor's archive-move (write to `attic/` + delete original) is the real consumer that justifies it. The split producer extends the existing consolidate agent harness: a `proposeSplit` tool validated deterministically at tool time (lossless line-accounting), accumulated on `AgentRunState`, emitted as a second PatchEffect with `mode: "propose"` — the engine already routes it to `proposals.db`. The janitor is a deterministic `dome.markdown` garden processor on a weekly cron. Hardening lands first so producers arrive on a loop that can't wedge.

**Tech Stack:** Bun + TypeScript, isomorphic-git tree splicing, bun:test. No new dependencies.

## Global Constraints

- No new engine primitives, no new Effect kinds, no new capability kinds. Producers use `patch.propose` (existing).
- Processors stay pure (no fs/sqlite imports under `assets/extensions/*/processors/` or `lib/`).
- Engine import direction (core < garden < operational < host); every new engine module needs its `docs/wiki/matrices/engine-module-map.md` row (AC lockstep — round 4 tripped on this).
- Generated-block markers only via `src/core/generated-block.ts`.
- Spec edit accompanies each behavior change; Task 8 is the sweep.
- Verification per task: `bun run typecheck` + scoped `bun test <paths>`. Full suites run serially in Task 8 only (parallel full-suite is known-flaky).
- Commits on branch `stock-gardening/build` (worktree `.claude/worktrees/stock-gardening-build`), messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- The retired-processor GC MUST honor the disabled-bundle prefix escape exactly as question expiry does (`QuestionExpiryDeps.disabledExtensionIds`, mirroring `isKnownProcessorFor`, main commit 28b912d3 posture).
- LLM charter edits keep the existing register (imperative, one operation per section) and keep every existing safety rule intact.

---

### Task 1: Dedupe-hit refresh — re-emission against a pending row refreshes its base

**Files:**
- Modify: `src/proposals/pending-proposals.ts` (`enqueuePendingProposal`)
- Modify: `src/projections/sinks.ts` (only if the sink's return handling needs the new `refreshed` field — read it first)
- Test: `tests/proposals/pending-proposals.test.ts`, `tests/projections/sinks.test.ts`

**Interfaces:**
- Consumes: existing store API (round 4 Task 1).
- Produces: `enqueuePendingProposal` return widens to `{ inserted: boolean; refreshed: boolean; id: number | null }`. Semantics: INSERT succeeds → `{inserted:true, refreshed:false, id}`. Dedupe-hit against a **pending** row → `UPDATE pending_proposals SET base_contents_json=?, base_commit=?, created_at=created_at WHERE id=? AND status='pending'` with the NEW input's baseContents/baseCommit → `{inserted:false, refreshed:true, id}`. Dedupe-hit against applied/rejected → `{inserted:false, refreshed:false, id}` (rejected stays rejected, applied stays applied). The sink fires `proposals.changed` only on `inserted` (a refresh changes no owner-visible list content — the row was already pending).

Why: the round-4 final review's "stale-pending wedge" — a deterministic processor re-emitting identical changes after the owner edited the file re-reads the CURRENT snapshot, so its re-emission means "these changes against today's base"; without the refresh the row is permanently stale and unappliable.

- [ ] **Step 1: Write failing tests**: (a) enqueue → mutate the recorded baseContents by re-enqueuing the same (processorId, changes) with different baseContents → `refreshed: true`, `getProposal` shows the NEW baseContents, same id, same createdAt; (b) re-enqueue against a rejected row → `{inserted:false, refreshed:false}` and baseContents unchanged; (c) sinks test: refresh does NOT fire the proposals-changed callback, fresh insert does (extend the existing dedupe-hit sink test).
- [ ] **Step 2: Run** `bun test tests/proposals/pending-proposals.test.ts tests/projections/sinks.test.ts` — FAIL.
- [ ] **Step 3: Implement** (transactional: SELECT id,status by dedupe_key → branch).
- [ ] **Step 4: Run + typecheck** — PASS.
- [ ] **Step 5: Commit** `fix(proposals): identical re-emission refreshes a pending row's base (stale-pending wedge)`

---

### Task 2: Retired-processor proposal GC

**Files:**
- Create: `src/engine/operational/proposal-expiry.ts`
- Modify: `src/engine/operational/operational-work.ts` (run after question expiry), `src/engine/host/compiler-host.ts` (thread deps — mirror how question expiry got its `disabledExtensionIds` + registry), `docs/wiki/matrices/engine-module-map.md` (row!), `docs/wiki/specs/effects.md` (expiry section gains the proposals paragraph)
- Test: `tests/engine/proposal-expiry.test.ts`, extend `tests/engine/operational-work.test.ts`

**Interfaces:**

```ts
export type ProposalExpiryDeps = {
  readonly registry: ProcessorRegistry;
  readonly disabledExtensionIds: ReadonlyArray<string>;   // same threading as QuestionExpiryDeps
  readonly proposals: ProposalsDb;
  readonly recordDiagnostic: ApplyEffectSinks["recordDiagnostic"];
  readonly now: () => Date;
};
export type ProposalExpiryResult = {
  readonly expired: number;
  readonly diagnostics: ReadonlyArray<DiagnosticEffect>;   // dual pattern (returned AND sink-recorded)
};
export async function expireOrphanProposals(deps: ProposalExpiryDeps): Promise<ProposalExpiryResult>;
```

Rule: a **pending** proposal whose `processor_id` is retired — not in the registry AND not under a configured-but-disabled extension prefix (copy `isRetired` from `question-expiry.ts`, byte-for-byte posture) — is decided `{status:"rejected", decidedBy:"expired", note:"processor retired"}` via the existing CAS `decideProposal`. One info diagnostic `proposal.expired-subject-retired` per row naming id + processor. `operational-work` fires `onProposalsChanged` once when `expired > 0` (the pending list shrank — the daily block must refresh; mirror how `onQuestionsChanged` is threaded, and note the host already exports `markProposalsChanged`).

- [ ] **Step 1: Write failing tests**: (a) pending row from retired processor → rejected/expired + diagnostic; (b) disabled-but-configured extension's row survives, then expires when removed from config; (c) applied/rejected rows untouched; (d) idempotent second run; (e) operational-work fires onProposalsChanged exactly once, 0 on second run.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** + matrix row + spec paragraph.
- [ ] **Step 4: Run + typecheck + `bun test tests/integration/engine-import-direction.test.ts`** — PASS.
- [ ] **Step 5: Commit** `feat(proposals): retired-processor pending proposals auto-reject (subject-liveness GC)`

---

### Task 3: Delete-changes in the git commit helper

**Files:**
- Modify: `src/git.ts` (`commitFilesOnHead` files entry type; new tree-removal splice beside `spliceBlobIntoTree` ~line 360)
- Test: the git test file covering `commitFilesOnHead` (find: `grep -rln "commitFilesOnHead" tests/`)

**Interfaces:**
- `commitFilesOnHead` `files` entries widen to `{ filepath: string; content: string | null }` — `null` removes the path from the tree. Existing callers (capture, settle, apply) pass strings and are untouched.
- New internal `spliceRemoveFromTree({root, treeOid, segments})`: mirror `spliceBlobIntoTree`'s recursive descent; removing the last entry of a subtree removes the subtree entry from its parent (no empty tree objects left behind); removing a path absent from the tree is a no-op returning the input treeOid (idempotent).

- [ ] **Step 1: Write failing tests**: delete an existing file → commit lands, file gone from HEAD tree and working tree unaffected by helper (the helper is tree-only — confirm what existing callers do about the working tree and mirror the test style); delete + write in one commit; delete of a nonexistent path → no-op entry, commit still lands with the other changes; deleting the only file in a subdirectory leaves no empty tree entry.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run + typecheck** — PASS. Also run `bun test tests/surface/capture.test.ts tests/surface/settle.test.ts` if they exist (callers).
- [ ] **Step 5: Commit** `feat(git): commitFilesOnHead supports delete entries (tree removal)`

---

### Task 4: `dome apply` supports delete-changes (+ EACCES fix)

**Files:**
- Modify: `src/surface/proposals.ts` (drop the `unsupported` cut; delete staleness + apply path; `readWorkingFile` rethrows non-ENOENT), `docs/wiki/specs/cli.md` (apply section: delete supported, semantics), `docs/wiki/specs/effects.md` if it states the v1 delete cut
- Test: `tests/surface/proposals.test.ts`

**Interfaces (behavior):**
- Delete-change staleness: working file content must equal `baseContents[path]` → eligible. Working file ALREADY absent → the delete is already satisfied: skip it (idempotent), not stale. Content differs → `stale`.
- Apply: eligible deletes are removed from the working tree (`node:fs unlink`) and passed as `content: null` entries to `commitFilesOnHead`; a proposal that is ALL already-satisfied deletes with no writes commits nothing and returns applied with `commit: undefined` (mirror settle's `keep`).
- `diffStat` for a delete: `{path, added: 0, removed: <base line count>}`.
- `readWorkingFile`: catch only `ENOENT` → null; rethrow others (mirror the ENOENT-only helper in `src/projections/sinks.ts`).

- [ ] **Step 1: Write failing tests**: delete-change proposal applies (file gone, commit message prefix `apply(P`, row applied); mixed write+delete in one proposal, one commit; delete stale when file edited; already-absent delete skips as satisfied; all-satisfied proposal → applied without commit; the round-4 `unsupported` test is REPLACED (delete it deliberately, note in the commit body); diffStat shape for deletes.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run + typecheck** — PASS.
- [ ] **Step 5: Commit** `feat(surface): dome apply supports delete-changes — archive-moves become appliable`

---

### Task 5: `proposeSplit` tool + harness emission

**Files:**
- Create: `assets/extensions/dome.agent/lib/split-proposal.ts` (pure validation + types)
- Modify: `assets/extensions/dome.agent/lib/vault-tools.ts` OR `consolidate-tools.ts` (the tool; put it in consolidate-tools — it is consolidate-specific), `assets/extensions/dome.agent/lib/agent-loop.ts` (`AgentRunState` gains `splitProposal`), `assets/extensions/dome.agent/lib/agent-run-effects.ts` (`finishAgentRun` emits the propose patch)
- Test: `tests/extensions/dome.agent/split-proposal.test.ts` (create; mirror sibling test layout under tests/extensions/)

**Interfaces:**

```ts
// split-proposal.ts
export type SplitProposalInput = {
  readonly hubPath: string;                       // existing page being split
  readonly hubContent: string;                    // the page rewritten as a hub
  readonly subPages: ReadonlyArray<{ readonly path: string; readonly content: string }>;
  readonly reason: string;
};
export const MAX_SPLIT_SUB_PAGES = 6;
export type SplitValidationError = { readonly code: string; readonly message: string };
/** null = valid. Checks (all deterministic):
 *  - hubPath ends .md and subPage paths end .md, live under the hub's directory, and none exist yet (existence via the injected reader)
 *  - 2..MAX_SPLIT_SUB_PAGES sub-pages
 *  - LOSSLESS LINE ACCOUNTING: every non-empty trimmed line of the ORIGINAL page body
 *    (frontmatter excluded, generated blocks excluded via findGeneratedBlock ranges over
 *    KNOWN owners — strip any `<!-- <owner>:<block>:start/end -->` delimited region with
 *    the generic marker grammar) appears verbatim (trimmed) in the hub or ≥1 sub-page.
 *    The hub/sub-pages may ADD lines (summaries, links, frontmatter); they may not LOSE any.
 *  - every sub-page path appears as a [[wikilink]] in hubContent (the hub links its children)
 *  - every sub-page carries frontmatter with a `description:` line
 */
export function validateSplitProposal(input: SplitProposalInput, original: string): SplitValidationError | null;
// AgentRunState gains:
splitProposal?: SplitProposalInput | null;
```

Tool (`proposeSplitTool(reader)` in consolidate-tools.ts): reads the original via the reader (must exist), runs `validateSplitProposal`; on error returns the error message to the model (self-correct); on success stores into `state.splitProposal` (SECOND call in one run → tool error "one split proposal per run"). `finishAgentRun`: when `state.splitProposal` is set, append `patchEffect({ mode: "propose", changes: [hub write + sub-page writes], reason: input.reason, sourceRefs })` — NOT counted against the auto-patch `maxChangedFiles` cap (it isn't applied), and NOT rolled back by the auto-cap overreach branch. A run whose ONLY output is the split proposal is not a no-op.

- [ ] **Step 1: Write failing tests** for `validateSplitProposal` (lossless pass/fail with a generated block in the original; missing hub wikilink; sub-page exists; >6 sub-pages; non-.md) and for the harness (state.splitProposal → finishAgentRun output contains exactly one propose-mode PatchEffect alongside the auto patch; second proposeSplit call rejected; split-only run not flagged no-op).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run + typecheck + `bun test tests/integration/processor-purity.test.ts`** — PASS.
- [ ] **Step 5: Commit** `feat(agent): proposeSplit tool — validated lossless split proposals from the consolidate harness`

---

### Task 6: Consolidate becomes the split producer

**Files:**
- Modify: `assets/extensions/dome.agent/lib/consolidate-charter.ts` (patrol-queue bullet: "Propose a split" now uses `proposeSplit`, not `askOwner`; new "## Splitting oversized pages (operation 4)" section; Tools list gains proposeSplit), `assets/extensions/dome.agent/lib/consolidate-tools.ts` (wire the tool), `assets/extensions/dome.agent/manifest.yaml` (consolidate gains `patch.propose` on `wiki/**/*.md` + a `doctor.grantEntries` row for it), `src/first-party-defaults.ts` (dome.agent defaults gain `patch.propose: ["wiki/**/*.md"]`), `docs/wiki/specs/autonomous-agents.md` (consolidate section)
- Test: extend the consolidate processor test (find: `grep -rln "consolidate" tests/extensions/ tests/processors/`), plus the grant-aware-tools manifest-sync test the consolidate-tools header mentions

Charter content for the new section (exact text to add, matching register):

```
## Splitting oversized pages (operation 4 — propose, never apply)
When a page is an accreted multi-document — several distinct topics grown together, or >600 lines (patrol flags these as `page.oversized`) — PREPARE the split and propose it with `proposeSplit`; the owner reviews the diff and applies it with `dome apply`. Never split by writePage.
- The HUB: rewrite the original page as the umbrella — keep its identity, frontmatter, and the content that is truly about the page's own subject; add a short section linking each carved-out sub-page with one line on what lives there.
- The SUB-PAGES: each carries ONE coherent topic, full frontmatter (`type`, `description:`, `sources:` including a link back to the hub), and the moved content VERBATIM — move, don't rewrite. Every original line must land in the hub or a sub-page; the validator rejects lossy splits.
- Scope: 2–6 sub-pages, same directory as the hub, slugs prefixed with the hub's slug (e.g. `danny.md` → `danny-promo-2026.md`).
- ONE split proposal per night at most; prefer the patrol-queued or most-oversized page.
```

And the patrol-queue bullet changes from "You do NOT split or reorganize yourself; `askOwner` to propose it" to "**Propose a split** — when the page is an accreted multi-document, prepare it with `proposeSplit` per operation 4 (the owner applies it; you never split via writePage)."

- [ ] **Step 1: Write failing tests**: a mocked agent run whose step() calls proposeSplit with a danny-shaped fixture (a >600-line page fusing three topics: frontmatter + `## Current facts` generated block + three `## <topic>` bodies) → processor output contains one propose-mode PatchEffect whose changes are hub + sub-pages, PLUS the normal auto patch for ledger updates; broker-level scenario: the propose patch routes to `queued-for-review` (proposals.db row lands) under the new manifest grant. Manifest-sync test updated for the new grant.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** charter + manifest + defaults + wiring.
- [ ] **Step 4: Run + typecheck + `bun test tests/extensions/maintenance-loops.test.ts`** — PASS.
- [ ] **Step 5: Commit** `feat(agent): consolidate proposes page splits — the review loop's first producer`

---

### Task 7: The attic janitor (`dome.markdown.attic-sweep`)

**Files:**
- Create: `assets/extensions/dome.markdown/processors/attic-sweep.ts`
- Modify: `assets/extensions/dome.markdown/manifest.yaml` (processor entry: garden, cron `45 4 * * 0` Sunday 04:45; capabilities `read` all-markdown + `patch.propose` on `["notes/**", "wiki/**", "attic/**"]`; doctor.grantEntries rows), `src/first-party-defaults.ts` (dome.markdown gains the propose paths), `docs/wiki/specs/vault-layout.md` (new `attic/` convention section: engine-proposed archive destination, mirrors original path, never read by recall ranking — check whether search indexing needs an attic downrank note and record the decision), `docs/wiki/specs/processors.md` first-party list
- Test: `tests/processors/attic-sweep.test.ts`

**Behavior (deterministic, pure):**

```ts
export const ATTIC_PREFIX = "attic/";
export const DEFAULT_ATTIC_MIN_AGE_DAYS = 30;
export const DEFAULT_ATTIC_MAX_FILES = 20;
const UNTITLED_RE = /^Untitled( \d+)?\.md$/;
```

Candidates = every tracked `.md` file (via `ctx.snapshot.listMarkdownFiles()`) where: NOT under `attic/`, `inbox/`, `meta/`, `templates/`, or the daily-notes dir; AND (trimmed content is empty OR basename matches `UNTITLED_RE`); AND `getFileInfo(path).lastChangedAt` (prefer `lastHumanChangedAt`) is older than `attic_min_age_days` (config, default 30, degrade-not-crash resolver like `minClaimsFromConfig`). Oldest-first, capped at `attic_max_files` (default 20). Emits ONE propose-mode PatchEffect: per candidate, `{kind:"write", path: "attic/" + originalPath, content: original}` + `{kind:"delete", path: originalPath}`; reason `dome.markdown: archive N dead stub file(s) to attic/`. Zero candidates → zero effects (idempotent; a previously-applied sweep leaves nothing matching). SourceRefs: one per candidate.

- [ ] **Step 1: Write failing tests**: empty file + `Untitled 3.md` old enough → one propose patch with write+delete pairs; fresh empty file (age < min) skipped; file under attic/ or inbox/ skipped; non-empty non-Untitled skipped; cap respected oldest-first; zero candidates → no effects; config override respected + degrade-not-crash.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** processor + manifest + defaults + specs.
- [ ] **Step 4: Run + typecheck + `bun test tests/integration/processor-purity.test.ts tests/extensions/maintenance-loops.test.ts`** — PASS.
- [ ] **Step 5: Commit** `feat(markdown): attic-sweep janitor proposes archive-moves for dead stub files`

---

### Task 8: Substrate sweep + serial verification

- [ ] **Step 1:** Sweep: `docs/index.md` (any changed spec descriptions), glossary ("attic", "split proposal" entries), `docs/wiki/matrices/built-in-extensions-x-phase.md` (attic-sweep row; consolidate row if it names operations), stale-grep `grep -rn "askOwner.*split\|do not split\|unsupported.*delete" docs/ src/ assets/`, protocol-adapter matrix unchanged (no new routes) — verify.
- [ ] **Step 2:** Serial gates: `bun run typecheck`; then `bun test tests/proposals tests/engine tests/surface`; `bun test tests/cli`; `bun test tests/processors tests/extensions`; `bun test tests/integration tests/invariants`; `bun test tests/http tests/mcp`; `bun test tests/harness` (re-run individual timeouts in isolation before judging); `git diff --check`.
- [ ] **Step 3: Commit** `docs: substrate sweep for stock-gardening phase 1`

---

### Task 9: Merge + rollout

- [ ] **Step 1:** Verify main tip unmoved since branch point; `git merge --no-ff stock-gardening/build`; delete branch + worktree.
- [ ] **Step 2:** Bootout→drain→bootstrap the three services (work serve, personal serve, http).
- [ ] **Step 3:** `dome init ~/vaults/work --refresh-config` (merges the new `patch.propose` grantEntries for dome.agent + dome.markdown); commit the config diff; `dome doctor` clean of grant-entry findings.
- [ ] **Step 4:** Live smoke: `dome proposals` empty-state; confirm via `dome inspect processors --json` that consolidate + attic-sweep carry effective `patch.propose`. The producers are nightly/weekly cron — the REAL acceptance (a split proposal for danny.md, an attic sweep of the notes/ stubs) lands on the next scheduled runs; note in the daily to check `dome proposals` tomorrow morning.
- [ ] **Step 5:** Update memory (extend the product-review-4 memory or new stock-gardening memory) with shipped state + what to verify tomorrow.

## Self-Review notes

- Coverage: follow-ups (T1 refresh, T2 GC, T4 EACCES) ↔ final-review backlog; T3+T4 unblock T7's archive-moves; T5+T6 = producer 1 (splits); T7 = producer 2 (janitor); T8/T9 discipline + deploy.
- Type consistency: `enqueuePendingProposal` return widened in T1 — T2's GC uses `decideProposal` (unchanged); `commitFilesOnHead` content:null (T3) consumed by T4; `SplitProposalInput`/`validateSplitProposal`/`MAX_SPLIT_SUB_PAGES` (T5) consumed by T6; `ATTIC_PREFIX`/defaults (T7) self-contained.
- Known risks called out in-task: tree-removal edge (empty subtrees, T3), lossless accounting vs generated blocks (T5), the manifest-sync grant test (T6), search treatment of attic/ (T7 records the decision).
