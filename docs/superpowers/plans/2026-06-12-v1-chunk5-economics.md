# Dome v1 Chunk 5 — WS2 Economics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound the nightly garden's cost: prompt caching on the stable agent-loop prefix (charter + tool schemas), per-processor model routing, a `dome inspect cost` observability surface, and an honest recorded deferral of the Batch API (the v1 plan's premise doesn't fit sequential tool-use loops).

**Architecture:** All changes ride existing seams. Caching lands entirely in the shipped provider template (`assets/model-providers/anthropic.ts`): `cache_control` on the system block + last tool schema for `step` envelopes, cache-aware cost math from `usage.cache_creation_input_tokens`/`cache_read_input_tokens`. Routing: a `model_overrides` map in `extensions.dome.agent.config` resolved per processor and passed via the existing `step({ model })` field — the model-allowlist machinery (`src/engine/core/model-invoke.ts:328-352`) already gates it; provider neutrality preserved (the envelope's `model` field is already part of the protocol). Cost observability: `dome inspect cost` reads the run ledger's existing `cost_usd` column (the run-ledger spec lists it as planned). Batch API: deferred with rationale in the spec — agent loops are sequential (step N+1 depends on N's tool results); the only batchable calls are warden one-shots, not worth an async job bridge yet.

**Tech Stack:** Bun + TypeScript, `bun:test`, the JSON-over-stdio provider protocol (unchanged shape — additive fields only).

**Verified context (executors re-verify):**
- Provider: `assets/model-providers/anthropic.ts` (437 lines) — `/v1/messages`, no cache_control today, cost from a per-MTok table with env overrides, unknown model → omit costUsd. Step envelope `dome.model-provider.step/v1` carries messages/tools/model.
- Engine seam: `ctx.modelInvoke.step({ messages, tools, model?, signal })`; model allowlist = declared ∩ granted, unlisted model throws; `onCost` accumulates into the run ledger's `cost_usd`; two-scope budget enforcement (per-processor declared vs extension pool granted) — do not disturb.
- Agent loop (`assets/extensions/dome.agent/lib/agent-loop.ts`): full history resent each step; system message (charter) is messages[0] forever; tools constant across the loop. Cache hit rate will be high by construction.
- Anthropic caching mechanics: 5-min ephemeral TTL; writes cost 1.25×, reads 0.1× of input price; beta header may no longer be required on current API versions — the executor checks the template's API version and uses whatever the documented current mechanism is (the template is vault-side code calling the public API; use `cache_control: {type: "ephemeral"}` on the system block and the LAST tool definition — a cache breakpoint covers everything before it).
- Provider tests: find how the anthropic template is tested today (grep tests/ for model-provider; there are envelope-shape tests and the doctor probe path) — mirror.
- The work vault runs a COPY at `.dome/model-provider.ts` — template improvements do NOT propagate (same as fetch scripts). Runbook must carry the re-copy step.

---

### Task 1: prompt caching in the provider template

**Files:** Modify `assets/model-providers/anthropic.ts`; tests wherever the template's envelope/cost behavior is covered (find first; add a focused test file if none exists — the template is plain Bun-runnable, testable by importing or by spawning with a stubbed `fetch` via `ANTHROPIC_BASE_URL` pointed at a local Bun.serve).

- [ ] **Step 1 (failing tests):** for the `step` envelope: (a) the outgoing request body carries `cache_control: {type:"ephemeral"}` on the system block and on the last tools[] entry (assert via a stub server capturing the body); (b) cost math: a response with `usage: {input_tokens: 1000, cache_creation_input_tokens: 1500, cache_read_input_tokens: 0, output_tokens: 100}` prices creation at 1.25× input rate; a response with `cache_read_input_tokens: 1500` prices reads at 0.1×; (c) `request` (single-shot) envelope unchanged (no cache_control — one-shot calls gain nothing); (d) `DOME_DISABLE_PROMPT_CACHE=1` env kills the injection (escape hatch).
- [ ] **Step 2-4:** FAIL → implement (additive body fields; cost function gains the two usage fields with the documented multipliers; keep the unknown-model omit-cost behavior) → PASS + `bun run typecheck`.
- [ ] **Step 5: Commit** `feat(model-provider): prompt caching on the step envelope's stable prefix`.

### Task 2: per-processor model routing

**Files:** Modify the four agent processors' config reading (a shared helper in `assets/extensions/dome.agent/lib/` — follow the degrade-not-crash config idiom) + `assets/extensions/dome.warden/processors/integrity.ts`; manifest/spec only if the allowlist needs declaring; tests per processor config suite.

- [ ] **Step 1:** Read how `sweep_targets`/`consolidate_targets` resolve config; read the model-allowlist machinery (`model-invoke.ts:328-352`) — determine whether passing an arbitrary model string requires a manifest `models:` allowlist declaration or flows freely when none is declared (TEST this empirically first; the answer shapes the design).
- [ ] **Step 2 (failing tests):** `extensions.dome.agent.config.model_overrides: { ingest: "claude-haiku-4-5", consolidate: "...", brief: "...", sweep: "..." }` (and `extensions.dome.warden.config.model_override` for integrity) — when set, the processor passes that model on every `step()`/structured call; unset → no model field (provider default); malformed → default + warning diagnostic (`dome.agent.model-config-invalid`, the established pattern). If the allowlist machinery blocks undeclared models, add the necessary manifest/grant plumbing in the same task — minimal and documented.
- [ ] **Step 3-5:** FAIL → implement → PASS (`bun test tests/extensions`) → **Commit** `feat(dome.agent,dome.warden): per-processor model routing via config`.

### Task 3: `dome inspect cost`

**Files:** Extend `src/cli/commands/inspect.ts` (read its subcommand structure first) + the ledger query surface if needed (`src/ledger/runs.ts` — a since-midnight + last-N-days spend aggregation by processor); tests in `tests/cli/commands/inspect.test.ts` (the freshly split file).

- [ ] **Step 1 (failing tests):** `dome inspect cost [--days N]` (default 7): per-processor rows (processor id, runs, total cost, today's cost) + extension subtotals + grand total, from the ledger's `cost_usd`; `--json` envelope `dome.inspect.cost/v1`; empty ledger → clean zero table. Run-ledger spec lists this as planned — the lockstep is Task 4's.
- [ ] **Step 2-5:** FAIL → implement (read-only ledger open, mirror `dome log`'s posture) → PASS → **Commit** `feat(cli): dome inspect cost — spend observability from the run ledger`.

### Task 4: spec lockstep + batch deferral + runbook

**Files:** `docs/wiki/specs/autonomous-agents.md` (model_overrides config + caching note in the step-seam section), the model-provider spec page (find it — caching contract: additive envelope behavior, cost math incl. cache tiers, DOME_DISABLE_PROMPT_CACHE), `docs/wiki/specs/run-ledger.md` (inspect cost shipped), `docs/wiki/specs/cli.md` (inspect cost row), and a **recorded Batch-API deferral**: a short paragraph wherever the v1 plan's WS2 contract is normatively reflected (likely the model-provider spec) — sequential loops are unbatchable; warden one-shots are the only candidates; revisit if warden volume grows. Runbook: "## Chunk 5 — economics (work vault)" — the provider script is a vault-side COPY: `cp assets/model-providers/anthropic.ts ~/vaults/work/.dome/model-provider.ts` (diff first if the owner customized it), optional `model_overrides` recommendation (haiku-class for ingest/sweep; keep consolidate/brief on the default), verify with `dome inspect cost` after a nightly run.

- [ ] Run `bun test tests/integration` + full suite + typecheck; fix what lockstep demands. **Commit** `docs(specs): caching contract, model routing, inspect cost, batch deferral`.

### Task 5: verification + merge

- [ ] Full suite + typecheck. E2E smoke: stub-server test proving a 3-step loop's request bodies carry cache_control and the 2nd/3rd steps' cost reflects cache-read pricing; `dome inspect cost` against a vault with ledger rows.
- [ ] Final whole-branch review: protocol additivity (an OLD vault provider copy without caching still works against the NEW engine — nothing engine-side changed; a NEW provider copy works with old envelopes), budget-scope math undisturbed (cache-discounted costs flow through the same onCost path), routing can't bypass the allowlist.
- [ ] `--no-ff` merge; suite green on main.

---

## Self-review notes
- **WS2 plan-vs-reality:** the v1 plan promised "Batch API + cached prefix + routing." Caching + routing ship; batch is deferred WITH a recorded rationale (the honest finding: agent loops are sequential; the plan's premise fit single-shot workloads we mostly don't have). The plan's "single-digit $/month" target gets its measurement instrument (`inspect cost`).
- **Deliberate cuts:** no async batch bridge; no engine-side caching knobs (provider-side only, protocol untouched); no default model downgrade (routing ships unset — quality changes are the owner's call, recommended in the runbook).
- **Verify-against-reality flags:** (a) current cache_control mechanics vs the template's API version (beta header or not); (b) the model-allowlist behavior for undeclared models (shapes Task 2); (c) how/where the provider template is tested; (d) inspect.ts subcommand structure.
