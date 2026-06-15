# Claims Fact Layer — Phase C (Health) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make claims a coherence instrument — surface claims whose `*(as of)*` date has gone stale (older than a configurable horizon) so the owner can reaffirm or supersede them, the VISION "coherence over time" payoff.

**Architecture:** A deterministic **view-phase** processor `dome.claims.stale-claims` reads `dome.claims.claim` facts (whose `asOf` is already durable and clock-free), compares each `asOf` to the injected `ctx.now()` against a config horizon, and emits a `ViewEffect` listing the stale claims (most-stale first). Staleness depends on the wall clock, so it MUST live in view phase (computed at command time) — never as a rebuildable adoption fact (`PROJECTIONS_ARE_REBUILDABLE`). This mirrors how `dome.search` recency decay takes `ctx.now()` in view phase. Invoked via `dome run dome.claims.stale-claims` (the `dome.markdown.orphan-pages` precedent — a read-only view-phase processor).

**Tech Stack:** TypeScript on Bun; extensions under `assets/extensions/`; `bun test`; BOTH `bunx tsc --noEmit` (root, includes tests) and `bunx tsc --noEmit -p tsconfig.bundles.json` must be clean.

**Design source:** `docs/cohesive/brainstorms/2026-06-14-claims-fact-layer.md` (Link 3 — Health). Phases A (retrieval) and B (authoring + render) are merged.

**Scope:** The stale-claims view. **Deferred (documented follow-ons, NOT in this plan):**
- Brief-count weaving (surfacing the stale count in the daily `dome.agent.brief` — model-agent context work; the view delivers the on-demand audit value first).
- `dome explain <page>#^anchor` (the claim-value timeline from block git history — always labeled a *stretch* in the 2026-06-09 design; a heavier git-history-over-block-range build).
- Stale-claim QuestionEffects (idempotency-keyed owner questions) and cross-page contradiction (model territory — same-page collision already ships via the warden).

**Key constraints:**
- View phase + `ctx.now()` for the clock (injected, deterministic in tests — `src/core/processor.ts` `now: () => Date`). NEVER `new Date()`.
- The `asOf` field is already on every `dome.claims.claim` fact (emitted clock-free by the adoption-phase `dome.claims.index`). Read facts via `ctx.projection.facts({ predicate: "dome.claims.claim" })`.
- `dome.claims` owns its claim-fact shape; this plan adds a small decoder in `dome.claims` (the Phase A decoder lives in `dome.search`; a future consolidation can unify them — noted, not done here, to respect bundle independence and avoid a cross-bundle refactor mid-phase).

---

### Task 1: claim-fact reader + `dome.claims.stale-claims` view processor

**Files:**
- Create: `assets/extensions/dome.claims/processors/stale-claims.ts`
- Test: `tests/extensions/dome.claims-stale-claims.test.ts`

**Step 1 — Read (REQUIRED):**
- `assets/extensions/dome.markdown/processors/orphan-pages.ts` — the view-phase precedent: how it reads `ctx.projection.facts(...)`, builds a result payload, and emits a `viewEffect({ name, content: { kind: "structured", data, schema }, scope/sourceRefs })`. Mirror its shape (VIEW_NAME, VIEW_SCHEMA, the `ctx.projection === undefined` guard, `ctx.sourceRef`).
- `assets/extensions/dome.search/processors/claims-fact.ts` — the existing claim-fact decoder (`parseClaimFact` → `{key,value,asOf}`); mirror its JSON-decode + null-guards in the new local dome.claims reader.
- `assets/extensions/dome.claims/processors/render-facts.ts` — the `minClaimsFromConfig` config-resolver idiom (default + degrade-not-crash) to copy for the horizon.
- `src/core/processor.ts` — confirm `ctx.now(): Date` and the `ProcessorContext` `projection` shape (`facts(filter)`), and the `ViewEffect` type in `src/core/effect.ts`.

**Step 2 — Write the failing test** `tests/extensions/dome.claims-stale-claims.test.ts`. Build a mock `ProcessorContext` (mirror an existing view-processor unit test's ctx with `projection.facts`, `now`, `extensionConfig`, `sourceRef`). Cover:
1. Given claim facts with `asOf` dates — some older than the horizon, some within it — and a fixed `ctx.now()`, the emitted ViewEffect's data lists exactly the stale ones, each with `{ path, key, value, asOf, daysStale }`, sorted most-stale-first.
2. Claims with `asOf: null` are NOT stale (no assertion of staleness without a date) — excluded.
3. A custom `stale_claims_horizon_days` config changes the cutoff (e.g. horizon 30 makes a 60-day-old claim stale).
4. Determinism: same facts + same injected `ctx.now()` → identical ViewEffect (the clock is injected, not read from the system).
5. Empty/no-stale → a ViewEffect with an empty list (not an error).

**Step 3 — Run, verify FAIL** (module missing).

**Step 4 — Implement** `stale-claims.ts`:
- A local `parseClaimFact(fact): { key, value, asOf: string|null } | null` (mirror `dome.search`'s — predicate guard, object.kind guard, JSON try/catch, key/value string guards, asOf normalize). Add a header note that this mirrors `dome.search/processors/claims-fact.ts` and the two should consolidate later.
- `horizonFromConfig(config)`: `stale_claims_horizon_days`, default `120`, degrade-not-crash (non-positive-int → default).
- The view processor `run`: guard `ctx.projection === undefined` (throw, like orphan-pages); read `ctx.projection.facts({ predicate: "dome.claims.claim" })`; decode each; keep those with non-null `asOf`; compute `daysStale = floor((ctx.now().getTime() - Date.parse(asOf)) / 86_400_000)`; keep `daysStale > horizon`; sort by `daysStale` desc then path then key; emit `viewEffect({ name: "dome.claims.stale-claims", content: { kind: "structured", data: { schema, asOf: ctx.snapshot.commit, horizonDays, staleClaims: [...] }, schema: "dome.claims.stale-claims/v1" }, sourceRefs: <each stale claim's fact sourceRefs, or a vault-root ref> })`. (Match orphan-pages' effect-construction exactly.)
- Default-export the processor.

**Step 5 — Run, verify PASS** (all 5 cases).

**Step 6 — Typecheck + commit.** `bunx tsc --noEmit -p tsconfig.bundles.json` clean.
```bash
git add assets/extensions/dome.claims/processors/stale-claims.ts tests/extensions/dome.claims-stale-claims.test.ts
git commit -m "feat(dome.claims): stale-claims view processor (clock-safe staleness over asOf facts)"
```

---

### Task 2: Register `dome.claims.stale-claims` (manifest + lockstep) + invocation test

**Files:**
- Modify: `assets/extensions/dome.claims/manifest.yaml`
- Modify (lockstep, as needed): `docs/wiki/matrices/built-in-extensions-x-phase.md`, `docs/wiki/matrices/extension-bundle-shape.md`, and `src/extensions/maintenance-loops.ts` (exemption — see below)
- Test: a scenario/CLI test invoking the view (mirror how an existing view processor like `orphan-pages` is invoked/tested — `dome run <view>` or the view harness)

**Step 1 — Read:** the `dome.claims.index` manifest entry (a `view` processor needs `phase: view` + `read`/`graph.read`? — check what grant a view-phase fact-reader declares; orphan-pages' manifest entry shows the grant a view processor needs to read facts). Read how `dome.markdown.orphan-pages` is registered (manifest) and invoked in a test (grep `orphan-pages` in tests/ for the invocation idiom — `dome run` via the CLI harness or a view-run helper). Read `src/extensions/maintenance-loops.ts`: `dome.lint.report` is EXEMPT from loop-coverage because it's a read-only view; the stale-claims view is likewise read-only → add it to the SAME exemption set, not a loop.

**Step 2 — Write the failing test.** Mirror the orphan-pages invocation test: a vault with claim facts (some stale relative to a controlled clock), invoke the `dome.claims.stale-claims` view, assert the result lists the stale claims. If view-run tests inject a clock, use it for determinism; if the harness uses the real clock, make the fixture's stale claim old enough (e.g. `asOf: 2020-01-01`) that it's stale under any real "now", and the fresh one dated "today-ish" via the harness's date. Follow the real invocation API — do NOT invent one.

**Step 3 — Run, verify FAIL** (view not registered).

**Step 4 — Implement.** Add the `dome.claims.stale-claims` entry to `manifest.yaml`: `phase: view`, `module: processors/stale-claims.ts`, the read/fact grant a view processor needs (mirror orphan-pages). Bump the bundle `version`. Add the lockstep rows (matrix docs — view cell for dome.claims) and add `dome.claims.stale-claims` to the maintenance-loops EXEMPT set (read-only view, like `dome.lint.report`) with a one-line rationale.

**Step 5 — Run, verify PASS.** Then: `bun test $(find tests -path "*claims*" -name "*.test.ts") tests/integration/bundle-matrix-lockstep.test.ts tests/extensions/maintenance-loops.test.ts tests/integration/processor-purity.test.ts tests/integration/bundle-deps.test.ts` → 0 fail. Address any lockstep failure per its own message.

**Step 6 — Typecheck + commit.** Both tsc projects clean.
```bash
git add assets/extensions/dome.claims/manifest.yaml docs/ src/extensions/maintenance-loops.ts tests/
git commit -m "feat(dome.claims): register stale-claims view (manifest + lockstep + invocation test)"
```

---

### Task 3: Spec sweep + full-suite gate

**Files:**
- Modify: `docs/wiki/specs/claims.md` (add the stale-claims view to the Processors table + a short Health note; reconcile "three processors" → "four")
- (gate only)

**Step 1 — Spec sweep.** Update `docs/wiki/specs/claims.md`: bump the processor count (three → four), add a Processors-table row for `dome.claims.stale-claims` (phase view, deterministic, read-only; "Lists claims whose `*(as of)*` is older than `stale_claims_horizon_days` (default 120), computed at command time from the injected clock — never a persisted fact; surfaced via `dome run`."), and a one-paragraph "Health" note explaining staleness is a view-time signal (rebuild-safe), with cross-page contradiction + `dome explain` + brief-count weaving named as the still-deferred health items. Keep the doc's terse normative register. Run `bun test $(find tests -iname "*substrate*" -name "*.test.ts") tests/integration/bundle-matrix-lockstep.test.ts` to confirm no count/lockstep drift.
```bash
git add docs/wiki/specs/claims.md
git commit -m "docs(claims): spec sweep — stale-claims is the fourth dome.claims processor; Health note"
```

**Step 2 — Full-suite gate.** `bun test` → 0 fail. BOTH `bunx tsc --noEmit` (root) and `bunx tsc --noEmit -p tsconfig.bundles.json` → 0 errors each (`bunx tsc --noEmit 2>&1 | grep -c "error TS"` → 0). Report the green suite + both counts. No commit (each task already committed).

---

## Self-review notes (author)

- **Spec coverage (Link 3):** the staleness instrument = Tasks 1-2; the spec/Health doc = Task 3. Cross-page contradiction (warden ships same-page), `dome explain` (stretch), and brief-count weaving are explicitly deferred with rationale — the health link's core (an owner-facing staleness audit over durable `asOf`, rebuild-safe) is delivered.
- **Rebuild-safety is the load-bearing property:** staleness lives in view phase via `ctx.now()`, never a persisted fact — encoded in Task 1's determinism test (injected clock) and the design constraint.
- **No placeholders:** Tasks include "read X first" grounding steps (orphan-pages for the view shape, claims-fact.ts for the decoder, render-facts for config); exact effect/payload shape, config key + default, and test cases are given.
- **Type consistency:** view name `dome.claims.stale-claims`, schema `dome.claims.stale-claims/v1`, config `stale_claims_horizon_days` (default 120), payload row `{path,key,value,asOf,daysStale}` — consistent across Tasks 1-3.
- **The tsc + lockstep lessons from A/B are encoded:** Task 3 checks BOTH tsc projects; Task 2 anticipates the matrix + maintenance-loops-exemption lockstep (a read-only view is exempt like `dome.lint.report`).
- **Decoder duplication is a conscious, documented trade-off** (dome.claims owns its fact shape; consolidation with dome.search's copy noted as a follow-on rather than a mid-phase cross-bundle refactor).
