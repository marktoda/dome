# Dome v1 Chunk 8 — Second-User Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Burn down the fixable code items in the second-user blockers ledger (`docs/cohesive/second-user-blockers.md`): comment-preserving config edits, a general grant-starvation diagnostic, GPG-signing immunity for shelling commit paths, `index_categories` merge semantics, recipe URL validation. Each fix strikes its ledger line.

**Context:** Coordinate-with-care — a parallel session is working on a `meta/` directory chunk touching `index-render.ts`/`render-index.ts` and the ledgers. This chunk must NOT touch those files except `render-index.ts`'s config resolver (Task 4) — keep that diff minimal and mergeable.

## Tasks

### Task 1: comment-preserving config edits
The `yaml` package (already a dep) supports `parseDocument` round-trips that preserve comments/format. Convert the init config-ensure paths (`ensureModelProviderConfig`, `ensureSourceSubscriptionConfig`, and the `--refresh-config` fill-missing path if it shares the rewrite) from parse/stringify-of-plain-objects to Document-API edits. VERIFY empirically first (test: a config with comments above/inline a stanza survives an unrelated stanza insert byte-for-byte except the insertion). If the package version can't deliver clean preservation, fall back per the plan's alternative: detect comments in the file → refuse the rewrite with exit 64 + print the exact stanza to hand-paste (and say which in the report). Tests both ways; runbook's LOUD WARNING updated to match shipped behavior; ledger line struck with pointer.

### Task 2: general grant-starvation diagnostic
Today `doctor.grantEntries` rows are hand-curated per path. Generalize: a doctor probe that, for every ENABLED bundle's processor, derives a representative concrete path from each manifest-declared `read`/`patch.auto` pattern (replace glob segments with literals — reuse/extend the existing grantEntries target machinery in `src/engine/host/health.ts`) and flags declared-but-ungranted paths (manifest ∩ vault grant = miss). Severity: info (narrowed grants can be deliberate); dedupe with existing hand rows (hand rows keep their curated messaging; the general probe skips paths a hand row already covers). Watch noise: run against the REAL work vault config read-only and report the finding count — if it's noisy, add the obvious suppressions (e.g. skip patterns the grant intentionally narrows via per-processor replacement grants) before shipping. Tests + spec (doctor section) + ledger strike.

### Task 3: GPG-signing immunity
Verify which commit paths shell out to `git commit` (engine + performCapture use isomorphic-git — unaffected, confirm): the fetch templates (`claude-calendar.sh`, `claude-slack.sh` `land()`) and any other script. Fix: `git -c commit.gpgsign=false commit …` in the templates (vault-data commits are engine-class, unsigned like isomorphic-git's). Add a doctor info probe: vault git config resolves `commit.gpgsign=true` → finding explaining which paths are immune vs affected + recovery (`git config --local commit.gpgsign false` if the owner wants unsigned human commits too — their call). Template tests + spec + ledger strike. Also fix the runbook's chunk-3a/-4 sections if they instruct signed-commit-prone commands.

### Task 4: `index_categories` merge semantics
New contract: explicit `{}` still disables (pinned — keep that test); a NON-empty map MERGES over the defaults; mapping a category prefix to `false` removes that default. Touch ONLY the config resolver in `render-index.ts` + its tests (parallel-session courtesy). Work vault lists all four prefixes explicitly — behavior unchanged there; docs vault `{}` unchanged. Spec (vault-layout §index, autonomous-agents if it documents the knob) + runbook step + ledger strike.

### Task 5: recipe URL validation + cross-reference
`--url` values must parse as http(s) URLs (reject with EX_USAGE + message; trailing-slash trim stays). cli.md: the three recipes cross-reference each other (ios ↔ capture-queue ↔ core-seed listing). Ledger strike for the URL line.

### Task 6: verify + merge
Full suite + typecheck; re-run the work-vault doctor (read-only) to show the new probes' real output; final review; `--no-ff` merge (coordinate: if the parallel meta/ chunk merged meanwhile, rebase/merge main first and re-run).
