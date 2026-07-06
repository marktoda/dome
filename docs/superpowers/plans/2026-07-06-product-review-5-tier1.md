# Product Review 5 Tier 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship round-5's this-cycle items: claims lazy-continuation fix, lint-timeout evidence fix, `dome explain`, the trust ladder, assistant contract tools, and the naming/docs sweep.

**Architecture:** No new engine primitives. The trust ladder rides the existing proposal loop (the gardener proposes config edits about its own autonomy); `dome explain` is a new `src/surface/` collector painted by CLI + MCP; assistant tools reuse the same collectors MCP maps.

**Tech Stack:** Bun + TypeScript strict; bun:test; yaml Document API for comment-preserving config edits; isomorphic-git via `src/git.ts`.

## Global Constraints

- Pure-decide + thin shells ([[philosophy]]); processors return `Effect[]` only.
- TDD; scoped `bun test <paths>` (never the full suite mid-task — see full-suite contention note); `bun run typecheck` before every commit.
- Conventional commits, one concern per commit, no push.
- Docs substrate updated in the same branch when normative behavior changes (specs/matrices/glossary).
- Generated-block markers only via `src/core/generated-block.ts` (splice-guard linter).
- NEEDS_ARE_LOUD: a declared capability/accessor that is absent at run time surfaces a warning, never a silent skip.

---

### Task 1: Claims grammar absorbs lazy-continuation lines

**Files:**
- Modify: `assets/extensions/dome.claims/processors/claims-shared.ts`
- Test: `tests/processors/claims-grammar.test.ts`, `tests/processors/claims-stamp.test.ts`, `tests/processors/dome.claims-render-facts.test.ts`

**Interfaces:**
- Produces: `ClaimLine` gains `readonly endLine: number` (== `line` for single-line claims). `claimsFromMarkdown` joins continuation lines into `value`. `stampClaimAnchors` appends the `^c…` anchor to the claim's **last** line.

**Bug being fixed** (verified in the work vault): a hand-authored claim hard-wraps —

```markdown
- **Testing:** team needs to be better at testing — there was an obvious multi-hop test
  case that should have caught this (matches RCA root cause #3).
```

The line-based grammar truncates the value at the wrap; the current-facts digest renders the fragment ending "multi-hop test (".

**Continuation rule** (conservative): after a claim line at index i, line i+1 continues the claim iff it is not excluded (fence/frontmatter/generated block), matches `/^\s+\S/` (indented), is not a blockquote (`>`), not a new bullet (`/^\s*[-*+]\s/`), not a heading (`/^\s*#/`), not itself a claim line (after anchor strip), and not an anchor-only line. Joined with a single space, trimmed. `asOf` is matched on the joined value. Anchor parsing: trailing anchor on the **last** continuation line is the claim's anchor; a legacy anchor on the first line (old stamping wrote it there) is still recognized and wins if both exist.

- [ ] **Step 1: Failing tests** — wrapped claim yields full joined value + `endLine`; anchor stamps to last line; legacy first-line anchor is stable (re-stamp is a no-op); continuation does NOT absorb: blank line, next bullet, next claim, heading; render-facts digest shows the full value for a wrapped claim.
- [ ] **Step 2: Run tests, confirm the new ones fail** — `bun test tests/processors/claims-grammar.test.ts`
- [ ] **Step 3: Implement** in `claimsFromMarkdown` / `stampClaimAnchors` (extend the shared parse; keep `claimsWithStableAnchors` mirroring stamping exactly).
- [ ] **Step 4: All three claims test files green + typecheck**
- [ ] **Step 5: Commit** — `fix(claims): claim grammar absorbs lazy-continuation lines (truncated digest facts)`

### Task 2: Lint timeouts — measure, then fix

**Files:**
- Modify: `assets/extensions/dome.markdown/manifest.yaml` (and processor files only if measurement shows an addressable hot path)
- Test: `tests/extensions/lint-supersession.test.ts`, `tests/extensions/validate-wikilinks.test.ts`

Work-vault evidence: 62 `lint-supersession` + 43 `validate-wikilinks` timeouts/7d. Both are `inspection: all-readable-markdown` whole-vault scans; lint-supersession has `timeoutMs: 30000`, validate-wikilinks rides the 10s adoption default.

- [ ] **Step 1: Measure** — synthetic ~1,000-file vault in a bench-style test; time both processors' `run`.
- [ ] **Step 2: Fix by evidence** — if scan cost is parse-bound and near-linear, raise validate-wikilinks to an explicit `timeoutMs: 30000` and lint-supersession to `60000` (adoption ceiling) with comments citing the measured cost; if a super-linear hot path exists (e.g. per-file re-resolution of every link target), fix it and keep timeouts.
- [ ] **Step 3: Commit** — `fix(markdown): whole-vault scan timeouts sized from measurement`

### Task 3: `dome explain` — the provenance debugger

**Files:**
- Create: `src/surface/explain.ts`
- Create: `src/cli/commands/explain.ts`; register (visible) in `src/cli/index.ts`
- Modify: `src/mcp/server.ts` (new `explain` tool)
- Test: `tests/cli/commands.test.ts` (explain section), `tests/surface/` if a pure-view test home exists
- Docs: `docs/wiki/specs/cli.md` (+ index/glossary line)

**Interfaces:**
- Produces: `collectExplain(runtime, target): ExplainView` where `target` is `"<path>#^<anchor>"` or `"<path>"`. Wire doc `dome.explain/v1`: `{ target, claim, facts, runs, commits }` — claim `{key,value,asOf,anchor,line}` or null; facts rows for the path/anchor with `{namespace,key,processorId,runId,sourceRef}`; runs joined from the ledger `{runId,processorId,startedAt,status,costUsd}`; recent engine commits touching the path with their `Dome-*` trailers (via `src/git.ts` history helpers, bounded, e.g. last 10).

The answer to "why do I believe X": claim value + as-of → producing facts → producing runs → engine commits. Read-only; degrade gracefully (a path with no claims still explains facts/commits).

- [ ] **Step 1: Failing test** — fixture vault with an anchored claim adopted; `dome explain 'wiki/x.md#^cAAAA' --json` returns the claim, ≥1 fact row with run provenance, and ≥1 commit with trailers; unknown anchor → command error exit 64.
- [ ] **Step 2: Collector** (pure over runtime accessors) + CLI painter (text renders the chain; `--json` emits the view doc).
- [ ] **Step 3: MCP tool** mapping the same collector (follow the header-comment convention in `src/mcp/server.ts`).
- [ ] **Step 4: Tests + typecheck green; docs updated.**
- [ ] **Step 5: Commit** — `feat(surface): dome explain — claim→fact→run→commit provenance view (CLI+MCP)`

### Task 4: The trust ladder

**Files:**
- Create: `assets/extensions/dome.health/processors/trust-review.ts`
- Modify: `assets/extensions/dome.health/manifest.yaml` (new processor, weekly cron `24 5 * * 1`, capabilities: `proposals.read`, `run.read`, `read` on `.dome/config.yaml`, `patch.propose` scoped to `[".dome/config.yaml"]`; matching `doctor.grantEntries`)
- Modify: `assets/extensions/dome.health/processors/report-card.ts` + `report-card-render.ts` (trust column: per producing processor, autonomy level + trailing accept-rate)
- Modify: `src/extensions/maintenance-loops.ts` (add trust-review to the `dome.system.report-card` loop)
- Test: `tests/processors/` new `dome.health-trust-review.test.ts`; extend report-card tests
- Docs: `docs/wiki/specs/proposals.md` §"Trust ladder"; `docs/glossary.md` entry; matrices row if the extension-bundle-shape matrix enumerates processors

**Interfaces:**
- Produces: pure `decideTrustReview(input): TrustDecision[]` where input carries per-processor proposal stats (decided count, applied count, window) + effective autonomy (from config text) + per-processor run productivity/cost; decisions are `{kind: "promote", processorId, evidence}` or `{kind: "flag-dormant", processorId, evidence}`.

**Behavior (the round-5 design — the gardener proposes changes to its own autonomy through the review loop):**
- **Promotion**: a behavior currently propose-only with ≥ 8 decided proposals in the trailing 28 days and accept-rate ≥ 0.75 → emit ONE `patchEffect({mode:"propose"})` whose single change is the comment-preserving YAML edit of `.dome/config.yaml` (yaml Document API — precedent: `dome init` ensure-paths) granting that behavior auto; `reason` carries the evidence ("19/20 applied over 28d"). Owner reviews with `dome apply`.
- **Dormancy**: an LLM processor with model spend > $0 and zero productive effects for 21 days → if per-processor disable is expressible in config, propose it the same way; otherwise emit an owner-needed question (existing machinery). Verify which is expressible before choosing.
- Idempotent: an open pending proposal for the same processorId+direction suppresses re-emission (check pending proposals via `proposals.read`); a rejected promotion is not re-proposed for 28 days (derive from the rejected row's decidedAt — no new state).
- NEEDS_ARE_LOUD: missing `ctx.operational` views → warning, not silence (compose-blocks pattern).

- [ ] **Step 1: Failing unit tests for `decideTrustReview`** (promotion threshold edges: 7 decided → no, 8 → yes; 0.74 → no; already-auto → no; open pending → suppressed; rejected 10d ago → suppressed; dormant LLM → flagged).
- [ ] **Step 2: Implement pure decide + YAML edit helper** (snapshot test: config before/after preserves comments).
- [ ] **Step 3: Processor shell + manifest + grants + doctor entries; processor test with seeded stores.**
- [ ] **Step 4: Report-card trust column + render tests.**
- [ ] **Step 5: Maintenance-loop row + loop-validation test green; docs; typecheck.**
- [ ] **Step 6: Commit(s)** — `feat(health): trust-review — the gardener proposes its own autonomy changes`, `feat(health): report card renders the trust ladder`

### Task 5: Assistant speaks the contract

**Files:**
- Modify: `src/assistant/tools.ts`, `src/assistant/types.ts` (if capability plumbing needs it), `src/assistant/agent.ts` (charter mentions action tools)
- Test: existing assistant/HTTP test homes (find `tests/**/assistant*` / `tests/**/http*`; follow their fixture pattern)
- Docs: `docs/wiki/specs/http-surface.md` (assistant tool table), `docs/wiki/concepts/client-model.md` (the co-located agent now speaks the contract)

**Interfaces:**
- Produces: `buildAgentTools` provisions, gated by the same `HttpCapability` set the routes use: `capture_note` (capability `capture` → `src/surface/capture.ts`), `settle_task` + `resolve_question` (capability `resolve` → `src/surface/settle.ts` / resolve collector), `list_proposals` + `apply_proposal` + `reject_proposal` (same capability gating as HTTP `/apply` `/reject` — mirror `ROUTE_CAPABILITY`). Read tools unchanged; `create/edit_document` stay behind `author`.

Tool results reuse the collectors' JSON docs; mutating tools push into the existing `changes` array so the agent-log and PWA change display keep working.

- [ ] **Step 1: Failing tests** — with default capabilities, the new capture/settle/resolve/proposal tools are present and `create_document` absent; with `resolve` withheld, settle/resolve/proposal tools absent; `settle_task` invocation settles a seeded task through the collector.
- [ ] **Step 2: Implement; charter prose updated (act when asked, cite decisions).**
- [ ] **Step 3: Tests + typecheck; docs.**
- [ ] **Step 4: Commit** — `feat(assistant): contract tools — capture/settle/resolve/proposals via the shared collectors`

### Task 6: Naming/docs sweep

**Files:**
- Modify: `docs/wiki/specs/http-surface.md`, `docs/glossary.md` (name "the Dome assistant" as the co-located consumer surface)
- Modify: `src/cli/index.ts` `answer` command description → "(deprecated alias of resolve for inspect-questions ids)"; `docs/wiki/specs/cli.md` note
- Modify: the AGENTS.md template source (`src/agents-md.ts`) — one read-first line: log retrieval misses via `dome query <text> --miss` so the embeddings gate has evidence
- Investigate: unmerged `client-model/build` branch — if its AGENTS.md authoring-contract teaching is still coherent with main, fold the still-relevant hunks into the template (do NOT blind-merge the branch); else record what remains in `docs/cohesive/second-user-blockers.md`
- Test: whatever pins the AGENTS.md template (`tests/**/*agents*`), CLI help test if it asserts command descriptions

- [ ] **Step 1: Template + docs edits; template lockstep tests green.**
- [ ] **Step 2: Commit** — `docs: name the assistant, deprecate answer verb, teach miss-logging in AGENTS.md`

---

## Execution notes

- Batch A (parallel, disjoint files): Tasks 1, 2, 6. Batch B (parallel): Tasks 3, 4, 5. Integrator verifies cross-task consistency, runs typecheck + full scoped test set, merges `--no-ff` to main after verifying the main tip (concurrent-branch hazard), then deploys per the runbook (refresh-config BEFORE restart).
- Deferred to their own cycles (with design brainstorms): corpus-adoption campaign, push delivery, per-device tokens.
