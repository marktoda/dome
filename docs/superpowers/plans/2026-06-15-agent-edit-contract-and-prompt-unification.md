# Agent Edit-Contract + Prompt Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "retire-on-update for owned prose" edit discipline to Dome's agent orientation surface, then apply it as a unification sweep that removes every stale/conflicting agent-facing prompt across the SDK repo and the work vault.

**Architecture:** Behavioral contract only — no new runtime machinery. The rule is anchored normatively in `harnesses.md`, compressed into the generated `AGENTS.md` scaffold (so it propagates to every vault via `dome init --refresh-instructions`), and demonstrated by de-rotting the work vault's fossilized `CLAUDE.md` and deleting dead prompt artifacts. Spans two git repos.

**Tech Stack:** TypeScript on Bun; `bun test`; Dome CLI (`dome status`/`sync`/`init`); markdown vault + git.

**Spec:** `docs/superpowers/specs/2026-06-15-agent-edit-contract-and-prompt-unification-design.md`

**Two repos:**
- **SDK repo** — worktree at `~/dev/dome/.claude/worktrees/agent-edit-contract/build`, branch `agent-edit-contract/build`. Tasks 1–4.
- **Work vault** — `~/vaults/work` (separate live repo, no worktree). Tasks 5–9.

---

## Part A — SDK repo (`agent-edit-contract/build` worktree)

All Part A paths are relative to `~/dev/dome/.claude/worktrees/agent-edit-contract/build`.

### Task 1: Normative rule in `harnesses.md`

**Files:**
- Modify: `docs/wiki/specs/harnesses.md` (insert a new section before `## How a harness reads from the vault`, currently line 55)

- [ ] **Step 1: Insert the normative section**

Use Edit. `old_string` is the existing reads-section header; prepend the new section above it:

```
old_string:
## How a harness reads from the vault

new_string:
## Keeping owned prose current

Agentic harnesses must keep the prose they own *current*, not accrete it. Two
categories of vault content carry opposite editing contracts:

- **Sources & history** — `raw/`, `notes/`, historical dailies, the
  preference-signal log, and git history itself. Append or preserve; never
  overwrite. These are the record.
- **Owned prose** — `wiki/` pages the agent maintains, syntheses, page
  `description:` frontmatter, and the instruction surfaces themselves
  (`AGENTS.md` user-prose, command prompts, bundle charters). When an edit makes
  an existing claim false or obsolete, the harness deletes or replaces it **in
  the same edit** — it does not leave the stale claim sitting beside the new one.

Whole-page supersession uses the existing vocabulary — `status: superseded` plus
a `superseded_by:` forward-link — rather than rewriting a historical record in
place. Sentence- or section-level staleness inside a page already being edited
is simply fixed.

This is safe because **git history is the preservation layer**: removing a stale
claim from the live surface does not lose it. The same principle already froze
`log.md` ([[wiki/invariants/LOG_IS_APPEND_ONLY]]) and forbids append-forever
registries ([[wiki/invariants/NO_ACCRETING_REGISTRIES]]); this section
generalizes it from derived artifacts to free prose. "I'd rather append to be
safe" is not preservation when git already holds the prior version — it is rot.

## How a harness reads from the vault
```

- [ ] **Step 2: Bump the spec's `updated:` frontmatter**

Edit the frontmatter `updated:` field to `2026-06-15` (current value is `2026-06-12`).

- [ ] **Step 3: Verify the doc reads coherently**

Run: `grep -n "Keeping owned prose current" docs/wiki/specs/harnesses.md`
Expected: one hit (the new `## ` header).

- [ ] **Step 4: Commit**

```bash
git add docs/wiki/specs/harnesses.md
git commit -m "docs(harnesses): normative edit-contract — keep owned prose current

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Edit-contract in the generated scaffold + `notes/` clarification

**Files:**
- Modify: `src/cli/commands/init-templates.ts` (scaffold `AGENTS.md` body: `notes/` line ~212–213; new section after Load-bearing rules, before `${userProseSection}` at line ~238)

- [ ] **Step 1: Clarify `notes/` is optional scratch, not a parallel knowledge base**

Edit `src/cli/commands/init-templates.ts`:

```
old_string:
- \`notes/\` is available for loose markdown notes that do not yet belong in a
  wiki page.

new_string:
- \`notes/\` is optional unstructured scratch for loose notes that don't yet
  belong in a wiki page — not a parallel knowledge base. Prefer \`wiki/\` for
  anything you want recalled.
```

- [ ] **Step 2: Add the compressed edit-contract section to the scaffold**

Edit the same file — insert a new section between the Load-bearing rules list and the user-prose section:

```
old_string:
- Engine commits carry \`Dome-*\` trailers for auditability.

${userProseSection}

new_string:
- Engine commits carry \`Dome-*\` trailers for auditability.

## Keeping owned prose current

Two kinds of content, opposite contracts:

- **Sources & history** — \`raw/\`, \`notes/\`, historical dailies, the
  preference-signal log, git history. Append or preserve; never overwrite.
- **Owned prose** — \`wiki/\` pages you maintain, syntheses, page
  \`description:\` frontmatter, and these instruction files. When an edit makes
  an existing claim false, delete or replace it in the same edit — don't leave
  the stale claim beside the new one. Git history keeps the prior version, so
  you lose nothing by removing it from the live surface.

Supersede a whole page with \`status: superseded\` + a \`superseded_by:\`
forward-link, not a rewrite. Fix sentence-level staleness inline. "Append to be
safe" is not safety when git already has your back — it is rot.

${userProseSection}
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS (no type errors — this is a template-string edit only).

- [ ] **Step 4: Run the orientation-surface invariant + init scenario tests**

Run: `bun test tests/invariants/agents-md-is-orientation-surface.test.ts tests/harness/scenarios/cli-surface/init-claude-boot.scenario.test.ts`
Expected: PASS. These assert scaffold *structure* (presence, user-prose delimiter pair, `CLAUDE.md` shim), not verbatim body, so the added section is compatible. If a test asserts on body text and fails, read it and update the expectation to include the new section.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/init-templates.ts
git commit -m "feat(init): scaffold the keep-owned-prose-current edit-contract; clarify notes/ as scratch

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Unify the outlier `log.md` charter wording

**Files:**
- Modify: `assets/extensions/dome.agent/lib/ingest-charter.ts:44`

- [ ] **Step 1: Replace the outlier "there is no log.md" phrasing**

The five sibling files (brief/consolidate charters, ingest/consolidate tools) all say "log.md is frozen history." Align this one. Edit:

```
old_string:
it becomes the engine commit message; there is no log.md).

new_string:
it becomes the engine commit message; do not append to log.md — the engine owns it).
```

- [ ] **Step 2: Confirm no other "there is no log.md" outliers remain**

Run: `grep -rn "there is no log.md" assets/ src/`
Expected: no hits.

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add assets/extensions/dome.agent/lib/ingest-charter.ts
git commit -m "fix(dome.agent): unify ingest-charter log.md wording with sibling charters

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: End-to-end scaffold propagation check

**Files:** none (verification only)

- [ ] **Step 1: Scaffold a throwaway vault and confirm the new section ships**

Run:
```bash
TMP=$(mktemp -d) && bun run bin/dome.ts init "$TMP" >/dev/null 2>&1 && \
grep -c "Keeping owned prose current" "$TMP/AGENTS.md" && \
grep -c "^@AGENTS.md" "$TMP/CLAUDE.md" && \
grep -c "BEGIN user-prose" "$TMP/AGENTS.md" && rm -rf "$TMP"
```
Expected: three lines, each `1` — the edit-contract section is present in the generated `AGENTS.md`, the `CLAUDE.md` shim still starts with `@AGENTS.md`, and the user-prose delimiter survives.

> If `bin/dome.ts` is not the correct entrypoint, find it: `grep -n '"dome"' package.json` or `ls bin/`. Adjust the invocation; the assertions stay the same.

- [ ] **Step 2: No commit** (verification only). If Step 1 fails, return to Task 2.

---

## Part B — Work vault (`~/vaults/work`, separate live repo)

All Part B paths are relative to `~/vaults/work`. This is the live vault; follow its daily loop (edit markdown → commit → `dome sync`).

### Task 5: Pre-flight — confirm vault is clean and Dome is responsive

**Files:** none

- [ ] **Step 1: Check vault git + Dome status**

Run:
```bash
cd ~/vaults/work && git status --short && dome status --json | head -40
```
Expected: working tree clean (or only known-unrelated changes); `dome status` returns without error. Note `serve_status` — if `off`, you'll run `dome sync --json` after commits; if running, the host adopts automatically.

---

### Task 6: Fold still-true vault-specific prose into `AGENTS.md` user-prose

**Files:**
- Modify: `~/vaults/work/AGENTS.md` (inside the `<!-- BEGIN user-prose --> ... <!-- END user-prose -->` block, appending after the existing `### Work-vault operating contract` subsection)

These two subsections capture the genuinely-useful, vault-specific knowledge from the fat `CLAUDE.md` that is **not** already in `AGENTS.md`. Everything else in the old `CLAUDE.md` is either duplicated in `AGENTS.md`, stale, or dead-mechanism prose and will be deleted in Task 7.

- [ ] **Step 1: Insert the folded subsections before `<!-- END user-prose -->`**

Edit `~/vaults/work/AGENTS.md`:

```
old_string:
<!-- END user-prose -->

new_string:
### Tasks & meeting prep

- Tasks are convention-only markdown checkboxes marked `#task` — not a wiki page
  type. Dome stamps a stable `^tXXXXXXXX` anchor on each adopted task line for
  path-independent identity; leave anchors in place, don't hand-author or remove
  them. Closing a carried-forward copy (`[x]`/`[-]`) propagates back to the
  origin line in place.
- **Tactical** tasks (this week) live in today's daily note
  `wiki/dailies/YYYY-MM-DD.md`. **Durable** open threads (long-running follow-up
  on a person/project) live under `## Open threads` on the relevant
  `wiki/entities/<slug>.md` or `wiki/syntheses/<name>.md`.
- **No per-meeting prep doc.** Prep a routine 1:1 by pulling durable threads from
  the entity page and dropping today's asks on the daily note — never a
  standalone `notes/<person>-prep-<date>.md` (they don't accumulate state and
  rot fast). Only exception: a heavyweight, referenceable artifact (promo
  committee, hard performance conversation, skip-level review).

### Convention scars

- Older daily notes (2025-09-28 .. 2025-10-08) carry wikilinks like
  `[[dailies/2025-10-07|Yesterday]]` from a prior Templater path setting; they
  resolve via Obsidian fuzzy matching. New dailies live at `wiki/dailies/`. Don't
  rewrite the old references.
- `notes/tasks.md` (Obsidian Tasks query blocks) and `notes/raw tasks.md`
  (manual completed-task archive) are user-maintained. Dome auto-skips files
  containing a ` ```tasks ` block; don't append to or rewrite either.

<!-- END user-prose -->
```

- [ ] **Step 2: Verify the delimiter pair is still intact and balanced**

Run: `grep -c "BEGIN user-prose\|END user-prose" ~/vaults/work/AGENTS.md`
Expected: `2` (exactly one BEGIN and one END).

---

### Task 7: Collapse the fossilized `CLAUDE.md` to a thin shim

**Files:**
- Modify (overwrite): `~/vaults/work/CLAUDE.md`

The current file is `@AGENTS.md` plus ~300 lines that duplicate and contradict `AGENTS.md` (log.md append instructions, `notes/` daily paths, "index.md is agent-maintained", and the dead `.dome/prompts/` augmentation-slot section). All of it is preserved in git history; replace the file wholesale.

- [ ] **Step 1: Overwrite `CLAUDE.md` with the shim**

Write `~/vaults/work/CLAUDE.md` with exactly:

```markdown
@AGENTS.md

# Work Knowledge Base

The Claude Code shim for this Dome-managed work vault. The full operating
contract lives in [[AGENTS.md]] — the daily loop, vault conventions, the
tasks/meeting-prep rules, the Dome command surface, and the edit discipline
(keep owned prose current; sources and history are preserved). Read it first.
```

- [ ] **Step 2: Confirm the rot is gone**

Run:
```bash
cd ~/vaults/work && grep -nE "log\.md|notes/YYYY|notes/<today>|\.dome/prompts|index\.md.*[Aa]gent-maintained|Append an entry" CLAUDE.md
```
Expected: no hits.

---

### Task 8: Fix the stale daily-note path in `morning.md`; delete dead artifacts

**Files:**
- Modify: `~/vaults/work/.claude/commands/morning.md:14`
- Delete: `~/vaults/work/.dome.v05-backup/` (dead v0.5 prompt backup, not referenced by live `.dome/config.yaml`)
- Delete: `~/vaults/work/log.md` (frozen; git preserves it — A4 option (a), keeps `AGENTS.md`'s "There is no log.md" literally true)

- [ ] **Step 1: Fix the daily-note path in `morning.md`**

Edit `~/vaults/work/.claude/commands/morning.md` (line 14 only — leave line 44's `notes/tasks.md`, which is a correct user-owned file reference):

```
old_string:
1. **Find today's daily note** (`notes/YYYY-MM-DD.md` for today's date). Obsidian/Dome usually auto-creates it; if it's missing, say so — don't fabricate one silently.

new_string:
1. **Find today's daily note** (`wiki/dailies/YYYY-MM-DD.md` for today's date). Obsidian/Dome usually auto-creates it; if it's missing, say so — don't fabricate one silently.
```

- [ ] **Step 2: Confirm `.dome.v05-backup/` is truly unreferenced before deleting**

Run:
```bash
cd ~/vaults/work && grep -rn "v05-backup" .dome/config.yaml .claude/ AGENTS.md CLAUDE.md 2>/dev/null
```
Expected: no hits. (If any hit appears, stop and report — do not delete.)

- [ ] **Step 3: Delete the dead backup and the frozen log**

Run:
```bash
cd ~/vaults/work && git rm -r --quiet .dome.v05-backup log.md && echo "removed"
```
Expected: `removed`. (If `.dome.v05-backup` is untracked rather than committed, use `rm -rf .dome.v05-backup` and `git rm --quiet log.md` separately.)

- [ ] **Step 4: Confirm no agent-facing surface still references the deleted log**

Run:
```bash
cd ~/vaults/work && grep -rnE "log\.md|notes/YYYY-MM-DD" AGENTS.md CLAUDE.md .claude/commands/ 2>/dev/null
```
Expected: no hits.

---

### Task 9: Commit the work-vault sweep and let Dome adopt

**Files:** none (commit + sync)

- [ ] **Step 1: Review the full diff**

Run: `cd ~/vaults/work && git status --short && git diff --stat HEAD`
Expected: modified `AGENTS.md`, `CLAUDE.md`, `.claude/commands/morning.md`; deleted `log.md` and `.dome.v05-backup/**`. Confirm nothing unexpected.

- [ ] **Step 2: Commit as one coherent unit**

```bash
cd ~/vaults/work && git add -A && git commit -m "chore(vault): unify agent instructions — shim CLAUDE.md, retire log.md & dead prompts

Apply the keep-owned-prose-current edit-contract: collapse the fossilized
CLAUDE.md to the AGENTS.md shim (folding still-true task/meeting-prep prose into
AGENTS.md user-prose), fix the stale notes/ daily path in morning.md, and delete
the frozen log.md and the dead .dome.v05-backup/ prompt set. Git history
preserves all removed content.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 3: Let Dome adopt and confirm health**

Run: `cd ~/vaults/work && dome sync --json | tail -30 && dome status --json | head -40`
Expected: sync completes; `dome status` shows no new `attention_required` caused by the deletions (page-status processor clears facts for the deleted `log.md` on adoption). If status flags attention, run the suggested `dome check --json` and resolve grounded items.

---

## Self-Review

**Spec coverage:**
- Part 1 rule → Task 1 (harnesses.md) + Task 2 (scaffold). ✓
- A1 collapse CLAUDE.md → Tasks 6 (fold) + 7 (shim). ✓
- A2 morning.md path → Task 8 Step 1. ✓
- A3 delete `.dome.v05-backup/` → Task 8 Steps 2–3. ✓
- A4 delete frozen log.md (option a) → Task 8 Step 3. ✓
- B1 init-templates notes/ clarification → Task 2 Step 1. ✓
- B2 ingest-charter wording → Task 3. ✓
- B3 verify-only (consistent siblings) → covered by Task 3 Step 2 grep + left untouched. ✓
- Verification (invariant tests, refresh parity, residual-grep) → Tasks 2 Step 4, 4, 7 Step 2, 8 Step 4, 9 Step 3. ✓

**Placeholder scan:** No TBD/TODO; every edit step carries exact `old_string`/`new_string` or full file content and exact commands with expected output.

**Type/name consistency:** Section title "Keeping owned prose current" is identical in harnesses.md and the scaffold. Branch/path names match the worktree created earlier. `notes/tasks.md` (keep) vs `notes/YYYY-MM-DD.md` daily path (fix) are distinguished in Task 8.

**Cross-repo note:** Part A commits land on `agent-edit-contract/build` in the worktree; Part B commits land in `~/vaults/work`. They are independent and can be executed/committed in either order, but Part A before Part B is the natural reading order.
