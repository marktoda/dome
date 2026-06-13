# Dome v1 Chunk 10 — Close-Out — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the final-audit's three "theater/gap" findings and two honesty-gaps into "done," so v1 ships clean. Six small items; no new primitives, no new bundles.

**Findings being closed (from the 2026-06-12 final audit):**
- `simplify-indexes` produces nothing in any real vault (render-index + meta/ shards own the index surface) → retire/disable.
- `warden.integrity` is 53/53 dismissed → over-flags; gate on confidence + suppress noisiest class, AND wire it to read `dome.claims.claim` facts (which are currently produced-but-unconsumed — one change fixes both).
- Per-device token promise: unbuilt and unrecorded → record the single-token-for-v1 decision in the security spec.
- WS2 target: measurement stalled → record a baseline-vs-caching cost note + apply-or-decline haiku routing, conclude honestly.
- claims anchors: ~350 older lines unstamped (fire-on-edit only) → ship a backfill path.

## Tasks

### Task 1: retire `simplify-indexes`
Evidence: 32 runs, zero output, no `wiki/**/index.md` in either real vault; render-index owns the index surface (NO_ACCRETING_REGISTRIES direction). Cleanest: remove the manifest entry + grant + processor file + test, OR if a future per-directory-index vault layout is wanted, flip default-enabled to false with a recorded rationale. PREFER removal (the explicitness culture doesn't keep inert processors). Check: maintenance-loops registry, bundle matrices, doctor scenario pins, any spec mention (sdk-surface, vault-layout) — strike each in lockstep. Verify no other processor or view references `wiki/**/index.md` generation. Commit.

### Task 2: warden reads claims facts (precision) + confidence gate
TWO coupled changes, one commit:
(a) **Wire the consumer**: `warden.integrity` (read it first) should read `dome.claims.claim` facts via its projection access (verify garden-phase fact-read availability — wardens are garden LLM processors; check how it gets context today) to run a deterministic same-key/different-value contradiction PRE-FILTER before the model call — only ask the model to adjudicate claims that already mechanically disagree, instead of re-deriving claims from prose. This gives claims.index facts their intended consumer (claims.md §"Anticipated consumers") AND sharpens the warden. If garden fact-read isn't available, document the constraint and do the achievable subset.
(b) **Confidence gate**: question emission gates on a confidence floor + suppress the noisiest finding class (the audit says self-corroboration/inference-as-fact fire on legitimate prose) until they're backed by the claims pre-filter. Make the floor a config knob (degrade-not-crash, mirror the existing patterns) defaulting conservative.
Tests: pre-filter surfaces a real key-collision contradiction; legitimate non-contradictory prose no longer triggers the suppressed class; confidence-below-floor → no question. Update warden tests + the claims.index `tier` if it was deferred (it now has a consumer — keep it shipped). Spec: claims.md (consumer wired), autonomous-agents.md / a warden spec (the gate). Commit.

### Task 3: record the per-device-token decision
The scope decision promised "per-device token issuance/rotation from day one"; reality is a single static bearer token, recorded only in the plan addendum. Decision for v1: **accept single-token**, and write it into the normative security surface so it's honest. Edit `docs/wiki/specs/http-surface.md` §"Trust domain" (and mcp-surface.md if it claims auth): document the single shared bearer token, the explicit non-goal of per-device issuance/rotation for v1, why (remote MCP — the multi-device driver — is deferred), and that issuance/rotation lands with or before remote MCP. Add a second-user-blockers ledger line (open, accepted-for-v1) pointing here. Commit. (Docs-only.)

### Task 4: conclude the WS2 economics verdict
The instrument (`dome inspect cost`) works; the verdict is unrecorded. Produce a short recorded conclusion (a dated note in the v1-plan addendum's WS2 bullet, or a `docs/cohesive/` review note — pick the house-consistent home): state the observed daily spend (read `dome inspect cost --days 7` against the work vault READ-ONLY for the number), note caching went live 2026-06-12 (so a clean before/after needs a few more days), and make the haiku-routing call: EITHER add the recommended `model_overrides` (ingest/sweep → haiku-class) to the runbook §Chunk 5 as the owner's opt-in with the tradeoff stated, OR explicitly decline for v1 with rationale. Conclude the target honestly: met / on-track-pending-measurement / revised-to-$X. Docs-only; do NOT edit the work vault config (owner's call). Commit.

### Task 5: claims backfill path
`claims.stamp` only fires on edit, leaving ~350 older in-scope lines unstamped. Provide a backfill: verify whether `dome run dome.claims.stamp` already re-stamps all matching pages in one pass (read the processor's trigger/scope — if a command/`dome run` invocation covers the whole vault, the "backfill" is just documenting that command). If `dome run` only processes changed paths, add a minimal scheduled OR command-triggered backfill variant that stamps all in-scope unstamped lines. PREFER documenting an existing path over new code if one exists. Document in claims.md + the getting-started/runbook as the one-time coverage step. Commit.

### Task 6: verify + merge
Full `bun test` + `bun run typecheck`. Confirm the warden change doesn't regress the no-accreting-registries / two-writer fences. Final review (one pass — especially the warden pre-filter correctness and the simplify-indexes removal completeness). `--no-ff` merge; clear the stray `today.ts:112` TODO if trivial while here.
