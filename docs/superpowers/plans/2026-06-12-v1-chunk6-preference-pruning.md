# Dome v1 Chunk 6 — Preference Pruning (WS1 closing tail) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close WS1's deferred fix 4: promoted preferences demote by the same Wilson/freshness math that promoted them — owner-mediated, handled by the existing gated core.md writer (no third writer).

**Architecture:** The deterministic `dome.agent.preference-promotion` processor (already reads signals.md + core.md and computes per-topic confidence) additionally emits **demotion questions** for `promoted`-state topics whose recomputed confidence has decayed below a floor. The existing `dome.agent.preference-promotion-answer` processor (the gated core.md writer) gains a second answer trigger for the demotion key prefix: `demote` removes the entry from the promoted block and appends a minus signal (NOT the rejection tombstone — re-candidacy stays possible if signals re-accrue); `keep` appends a fresh plus signal reaffirming the rule (confidence resets, naturally suppressing re-asks). The two-gated-writers contract is untouched.

**Mechanics (read `preferences-shared.ts` first — reuse its exact math and splice helpers):**
- Demotion candidate: topic state `promoted` AND recomputed `confidence < 0.15` (constant `DEMOTE_BELOW_CONFIDENCE`). Freshness alone gets there: no signals for 90 days → freshness 0 → confidence 0.
- Question: idempotency `dome.agent.preference-demotion:<topic>:<rule-hash>` (hash of the promoted block's rule text — the FNV-1a helper exists); options `["demote", "keep"]`; metadata `automationPolicy: "owner-needed"` (same rationale as promotion: changes every future run), `recommendedAnswer: "demote"`, confidence = the recomputed value; sourceRefs → the promoted block's core.md lines + the newest in-window signal lines if any.
- Answer `demote`: splice the entry OUT of the promoted block (the splice helpers + anomaly diagnostics already exist) + append `- <date> - <topic>:: demoted by owner (confidence decayed)` to signals.md. Retry-idempotent: entry already gone + tombstone present → zero effects.
- Answer `keep`: append `- <date> + <topic>:: <rule text>` (reaffirmation; source suffix omitted). Retry-idempotent on exact duplicate same-day line.
- Stale-question guard: re-derive state at answer time (promotion-answer's existing pattern) — if the topic is no longer promoted or the rule hash changed, info diagnostic + no write.

## Tasks

### Task 1: demotion candidates + questions (preference-promotion processor)
- TDD in the existing preference test file(s): promoted topic with decayed confidence → one demotion question with the pinned key/options/metadata; healthy promoted topic (fresh signals, confidence ≥ floor) → no question; non-promoted topics → never. Manifest: verify question.ask is already granted (it is); no grant changes.
- Commit `feat(dome.agent): demotion questions for decayed promoted preferences`.

### Task 2: demote/keep answer handling (preference-promotion-answer processor)
- Manifest gains a second answer trigger (`questionProcessorId: dome.agent.preference-promotion`, `idempotencyKeyPrefix: "dome.agent.preference-demotion:"`) — check the trigger schema supports multiple answer triggers per processor (sweep-answer or health answer processors may have precedent; if one-trigger-per-entry, add a second trigger entry). NO grant changes (same writer, same two paths).
- TDD: demote answer → entry removed, minus signal appended, block markers intact, OTHER promoted entries untouched; keep answer → plus signal appended, block untouched; retry idempotency both; stale guard both (topic un-promoted since asking / rule hash drift).
- The no-accreting-registries fence pins the writer grants EXACTLY — confirm unchanged grants keep it green; the manifest.test.ts two-writer pin likewise.
- Commit `feat(dome.agent): owner-mediated demotion closes the preference lifecycle`.

### Task 3: spec lockstep + plan/status sync
- `docs/wiki/specs/preferences.md`: demotion section (candidate math, question shape, both answers' effects, the deliberate NOT-rejection-tombstone choice and why, re-candidacy story); lifecycle diagram/text updated end-to-end (signal → candidate → promote → decay → demote question → demote/keep).
- `docs/wiki/specs/autonomous-agents.md`: the promotion processors' description rows mention demotion.
- v1 plan addendum: flip the "WS1 pruning" honestly-open bullet to shipped (one line).
- Commit `docs(specs): preference demotion lifecycle`.

### Task 4: verify + merge
- Full `bun test` + `bun run typecheck`; e2e-ish test: a fixture vault with a promoted block + stale signals walks question → resolve(demote) → handler → core.md updated (the harness scenario suite has a preference-promotion scenario — extend it for the round trip if cheap).
- Final review (small branch: one reviewer pass), `--no-ff` merge.

**Verify-against-reality flags:** (a) multiple answer-trigger support in the manifest schema; (b) the exact promoted-block entry grammar (confidence suffix) for hash + splice-out; (c) whether the existing preference-promotion scenario test exists in tests/harness (extend vs add).
