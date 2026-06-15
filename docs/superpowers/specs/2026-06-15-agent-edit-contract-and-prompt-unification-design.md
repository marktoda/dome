---
type: spec
created: 2026-06-15
status: draft
description: "Agent edit-contract (retire-on-update for owned prose) plus a unification sweep of every stale/conflicting agent-facing prompt surface across the SDK repo and the work vault"
---

# Agent edit-contract + prompt unification

## Problem

The foreground agent prefers to **append** information rather than **delete or
update** it. The user named this; the work vault proves it. The vault's own
`CLAUDE.md` has rotted into a fossil that contradicts the current `AGENTS.md` on
three separate points, because every change to the vault's conventions added new
prose without removing what it superseded.

This is not a bug — it is a **miscalibrated safety disposition.** The instruction
surfaces repeatedly and correctly tell the agent to *preserve*: "Never silently
overwrite," "Preserve uncertainty," "Historical notes are sources… avoid
rewriting them," "source-preserving improvements." Those rules are written for
**sources and history** but the agent applies them to **all** content, so its
default on every edit is preserve-everything-and-append.

The missing half of the contract is the lever. There are two content categories,
and only the first is currently articulated:

1. **Sources & history** — `raw/`, `notes/`, historical dailies, the
   preference-signal log, git history itself. Append / never overwrite. *Correct,
   unchanged.*
2. **Owned prose** — `wiki/` pages the agent maintains, syntheses, page
   `description:` frontmatter, and instruction files (`AGENTS.md` user-prose,
   `CLAUDE.md`, command prompts, bundle charters). When an edit makes an existing
   claim false or obsolete, the stale claim must be **deleted or replaced in the
   same edit** — not left sitting beside the new one.

The decisive reassurance: **in a git-backed vault, git history *is* the
preservation layer.** Appending-to-preserve is redundant with git and actively
rots the live surface. Dome already acted on exactly this realization once —
`LOG_IS_APPEND_ONLY` froze `log.md` because "narrative activity rides the engine
commit body" (git is the log). The edit-contract is that same principle
generalized from one file to all owned prose.

## Scope decision

Approved approach: **behavioral contract only** (no new runtime warden/lint this
pass). Add the discipline to the orientation surface, anchor it normatively, and
apply it immediately as a **unification sweep** of every stale agent-facing
prompt across both repos. A deterministic staleness lint is a deferred
fast-follow, not part of this change.

This change spans **two git repositories**:
- The Dome SDK repo (`~/dev/dome`) — normative spec + the generated scaffold +
  one charter wording fix.
- The work vault (`~/vaults/work`) — a separate repo; the proof-case de-rot.

---

## Part 1 — The edit-contract (the rule)

A short, named discipline added to the orientation surface. Canonical wording:

> **Owned prose is kept current, not accreted.** Two categories of vault content:
>
> - **Sources & history** (`raw/`, `notes/`, historical dailies, the
>   preference-signal log, git history): append / preserve, never overwrite.
> - **Owned prose** (`wiki/` pages you maintain, syntheses, descriptions,
>   instruction files): when an edit makes an existing claim false or obsolete,
>   **delete or replace it in the same edit.** Git history preserves the prior
>   version — you are not losing it by removing it from the live surface.
>
> Whole-page supersession uses the existing vocabulary: `status: superseded` +
> a `superseded_by:` forward-link, not a rewrite of a historical record.
> Sentence/section-level staleness inside a page you are already editing: just
> fix it. When genuinely unsure whether a claim is stale, preserve the
> uncertainty in a note — but "I'd rather append to be safe" is *not* uncertainty
> when git already has your back.

### Where the rule lands (normative, Dome repo)

1. **`docs/wiki/specs/harnesses.md`** — add a short normative subsection ("Keeping
   owned prose current") under the compiler-boundary contract. This is the
   source-of-truth the scaffold compresses. Cross-link
   `[[wiki/invariants/NO_ACCRETING_REGISTRIES]]` and
   `[[wiki/invariants/LOG_IS_APPEND_ONLY]]` — same principle, applied to free
   prose rather than derived registries.
2. **`src/cli/commands/init-templates.ts`** — add a concise "Keeping owned prose
   current" block to the managed `AGENTS.md` scaffold, so every vault's agent is
   oriented to it. Propagates to existing vaults via
   `dome init --refresh-instructions`.

> Note: the scaffold lives in the managed (non-user-prose) section, so refreshing
> a vault replaces the managed block while preserving each vault's user-prose.
> No invariant test asserts scaffold *contents* verbatim (the
> `AGENTS_MD_IS_ORIENTATION_SURFACE` tests assert structure: presence + delimiter
> pair + shim), so adding a subsection is safe — but re-run those tests to
> confirm.

---

## Part 2 — The unification sweep (concrete inventory)

Every item below is a real conflict found in the audit. The implementation plan
executes this as a checklist.

### A. Work vault (`~/vaults/work`) — the proof case

**A1. Collapse the fat legacy `CLAUDE.md` to the shim.**
Current `CLAUDE.md` is `@AGENTS.md` followed by ~300 lines that duplicate and now
contradict `AGENTS.md`. Per `AGENTS_MD_IS_ORIENTATION_SURFACE`, `CLAUDE.md` should
be the thin shim. Action: reduce `CLAUDE.md` to `@AGENTS.md` (+ at most a one-line
human note), after folding any **still-true, not-already-in-AGENTS.md** prose into
the `AGENTS.md` user-prose block. Delete the rest — git preserves it.

Stale blocks to **delete** (do not migrate):
- The `log.md` structure-diagram line + "log.md — Agent-maintained append-only
  activity trail" + the entire `## Log Format` section + Ingest step 7 "Append an
  entry to `log.md`". (`log.md` is frozen, engine-owned, never appended.)
- "index.md — Agent-maintained / keep it useful" + Ingest step 6 "Update
  `index.md` — add new entries". (`index.md` is a generated render from
  `description:` frontmatter; never hand-edited.)
- All daily-note references to `notes/YYYY-MM-DD.md` (tactical-task line, meeting-
  prep line). Current path is `wiki/dailies/YYYY-MM-DD.md`.
- The entire **"Time-aware retrieval and tasks (prototype, 2026-05-26)"** section
  (CLAUDE.md ~lines 184–194 and its subsections) describing the `.dome/prompts/`
  augmentation-slot mechanism and `[[wiki/specs/prompts-and-workflows]]`. That
  mechanism is **dead** — `.dome/prompts/` does not exist live (only in
  `.dome.v05-backup/`). Anything genuinely still-true in its task/daily-note
  vocabulary is already covered by `AGENTS.md`; do not migrate the dead-mechanism
  framing.
- `dome.agent.ingest` "updates `index.md` and `log.md`" → it updates page
  frontmatter; drop the index/log claim.

Candidate prose to **fold into AGENTS.md user-prose** only if not already present
there (audit each against current AGENTS.md before copying):
- The tactical-vs-durable task split and the "no per-meeting prep doc" rule
  (valuable, vault-specific, and *not* fully in AGENTS.md today).
- The "convention scars" notes (old wikilink artifacts; `notes/tasks.md` /
  `notes/raw tasks.md` are user-maintained, don't touch) — these are live, useful
  warnings.

**A2. Fix `.claude/commands/morning.md`** — one stale path: `notes/YYYY-MM-DD.md`
→ `wiki/dailies/YYYY-MM-DD.md`.

**A3. Delete `.dome.v05-backup/`** — confirmed dead: not referenced by live
`.dome/config.yaml`, contains v0.5-era prompt partials dense with stale `notes/`
and `log.md` references. Git preserves it. (Confirm nothing under `.claude/` or
config points at it before removing.)

**A4. Reconcile the lingering frozen `log.md` file + the AGENTS.md "There is no
log.md" line.** The file physically exists (frozen). Two coherent options — pick
one for the plan:
- **(a) Delete the frozen `log.md`** and keep AGENTS.md's "There is no log.md:
  the activity record is git history" literally true. Cleanest; git preserves the
  old content. *Recommended.*
- **(b) Keep the file** and soften AGENTS.md to "`log.md` is frozen history —
  never append; git is the activity record," matching the repo charters' framing.

  This is itself a textbook edit-contract decision and a good first demonstration.

### B. Dome SDK repo (`~/dev/dome`)

**B1. `src/cli/commands/init-templates.ts`** — `notes/` is presented in the vault-
conventions block as if co-equal to `wiki/`. Clarify it as optional unstructured
scratch, not a primary working surface (agents prioritize `wiki/`). *(Same file
also receives the Part 1 edit-contract subsection — do both in one pass.)*

**B2. `assets/extensions/dome.agent/lib/ingest-charter.ts:44`** — outlier wording
"there is no log.md" contradicts its five sibling files (brief/consolidate
charters + ingest/consolidate tools all say "log.md is frozen history"). Unify to
the frozen-history framing: "…it becomes the engine commit message; do not append
to `log.md` — the engine owns it."

**B3. Verify-only (audit found these already consistent — confirm, don't churn):**
`brief-charter.ts:11`, `consolidate-charter.ts:10,30`, `consolidate-tools.ts`,
`ingest-tools.ts`, the repo's own `AGENTS.md`/`CLAUDE.md`, and the
`wiki/dailies/{date}.md` default daily path. No edits unless a contradiction
surfaces.

---

## Non-goals / safety

- **No new runtime machinery** (no warden, no lint) this pass. Deferred
  fast-follow.
- **Preserve-category is untouched.** Sources, history, the preference-signal
  log, and uncertainty stay protected. We are adding the missing half of the
  contract, not inverting the existing half.
- **No rewriting of historical/frozen records' *content*** — `docs/cohesive/`,
  `docs/superpowers/`, frozen syntheses, and adopted historical dailies keep
  their references (the existing doc-sweep rule still holds). The sweep targets
  *agent-facing instruction/prompt surfaces*, not the archive.
- Git is the backstop for every deletion in this change.

## Verification

- Re-run `AGENTS_MD_IS_ORIENTATION_SURFACE` tests + the broader invariant suite
  after the scaffold edit (`tests/invariants/`, `tests/integration/`).
- Re-read `CLAUDE.md`/`AGENTS.md` in the work vault for residual contradiction
  after the de-rot (no `log.md`-append, no `notes/` daily path, no `.dome/prompts/`
  mechanism, no "edit index.md").
- `dome init --refresh-instructions` on a scratch vault → assert the new
  edit-contract subsection appears in the managed block and user-prose survives.
- Both repos commit as coherent units (separate repos → separate commits).
