# HTTP Convergence (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (or superpowers:executing-plans) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Collapse the two HTTP servers (`dome http` + `dome ask-server`) into **one** capability-gated server (`dome http`), delete `src/agent/server.ts`, rename `/ask`→`/agent`, with **no behavior change** to existing routes (Phase 2 adds the write capability).

**Architecture:** Extract the duplicated HTTP glue (auth, body-read, response/error shaping, problem→status) into one `src/http/lib.ts`; extract one handler per capability into `src/http/routes/`; rebuild `src/http/server.ts` as the single server wiring every route behind a `Capability` guard, importing the agent loop for `/agent`. `dome http` absorbs the ask-server's flags (`--static-dir`, `--transcribe-*`, `--model`, plus `--allow-write` — inert in Phase 1). `dome ask-server` is removed. The server stays a CLI dynamic-import companion (exempt from `bundle-deps`).

**Tech Stack:** TypeScript/Bun. `bun test`. Reuses `src/surface/adapter.ts` (`makeVaultMutex`, `withVault`, `runCatalogView`), `src/surface/capture.ts`, `src/surface/answer.ts`, `src/surface/recents.ts`, `src/surface/status.ts`, the agent loop in `src/agent/`.

## Global Constraints

- **No behavior change** to existing routes' request/response shapes in Phase 1 — the migrated test suites are the proof. The only intentional change is the route rename `/ask`→`/agent`, `/ask/stream`→`/agent/stream`, and consolidation onto one server/port.
- `src/http/server.ts` (and the agent loop it imports) stays reachable **only via dynamic import** from `src/cli/index.ts`. `bundle-deps` + `public-surface-shape` fences must stay green; `src/index.ts`'s static graph must not gain the AI SDK.
- `dome ask-server` verb is **deleted, not aliased**. `dome http` is the one server verb.
- One `makeVaultMutex` per server instance (never two live VaultRuntimes).
- The capability vocabulary is `read · capture · resolve · converse · author`; in Phase 1 all are granted **except `author`** (gated by `--allow-write`, which exists but provisions nothing yet).
- Default port stays `dome http`'s **3663** (the PWA launch + run docs move from 4664 → 3663).

**Read before starting:** the recon reference in this session's context (exact line numbers for `src/agent/server.ts`, `src/http/server.ts`, `src/cli/index.ts`, `src/cli/commands/{http,ask-server}.ts`, `src/agent/{ask,tools,types}.ts`), and the spec `docs/superpowers/specs/2026-06-19-write-capable-agent-design.md`.

## Target file structure

```
src/capabilities.ts            NEW — Capability type + grantedCapabilities + has  (dep-free)
src/http/lib.ts                NEW — shared glue: sha256, jsonBody, jsonResponse, errorResponse,
                                     dataErrorResponse, commandErrorResponse, viewProblemHttpStatus,
                                     positiveInt, authorized, queryTokenAuthorized, serveStatic,
                                     fontResponse, EXT_BY_TYPE, schema constants
src/http/routes/capture.ts     NEW — handleCapture(rt, request, max)  (was duplicated in both servers)
src/http/routes/resolve.ts     NEW — handleResolve(rt, request, max)
src/http/routes/views.ts       NEW — handleTasks / handleQuery / handleToday(HTML) / handleStatus
                                     / handleDoc / handleQuestions / handleRecents
src/http/routes/transcribe.ts  NEW — handleTranscribe(request, opts)  (moved from agent/server.ts)
src/http/routes/agent.ts       NEW — handleAgent / handleAgentStream  (call the agent loop)
src/http/server.ts             REWRITE — the one server: options, fetch (static→auth→transcribe→mutex),
                                     route table with per-route capability guards
src/agent/server.ts            DELETE
src/agent/agent.ts             RENAMED from ask.ts (runAgent/runAgentStream, AGENT_CHARTER)
src/agent/tools.ts             buildAgentTools (renamed from buildAskTools)
src/agent/types.ts             AgentResult/Citation (renamed from AskResult/AskCitation)
src/cli/commands/http.ts       MODIFY — RunHttpOptions gains the absorbed flags; constructs the one server
src/cli/commands/ask-server.ts DELETE
src/cli/index.ts               MODIFY — `dome http` gains flags; remove `dome ask-server`
```

---

## Task 1: Capability model (`src/capabilities.ts`)

**Files:** Create `src/capabilities.ts`, `tests/capabilities.test.ts`.

**Interfaces — Produces:**
- `type Capability = "read" | "capture" | "resolve" | "converse" | "author"`
- `grantedCapabilities(opts: { allowWrite?: boolean }): ReadonlySet<Capability>` — always `read,capture,resolve,converse`; adds `author` iff `allowWrite`.
- `has(granted: ReadonlySet<Capability>, cap: Capability): boolean`

- [ ] **Step 1: Failing test** `tests/capabilities.test.ts`
```typescript
import { describe, expect, test } from "bun:test";
import { grantedCapabilities, has, type Capability } from "../src/capabilities";

describe("capabilities", () => {
  test("default grant is read/capture/resolve/converse, no author", () => {
    const g = grantedCapabilities({});
    for (const c of ["read", "capture", "resolve", "converse"] as Capability[]) expect(has(g, c)).toBe(true);
    expect(has(g, "author")).toBe(false);
  });
  test("allowWrite adds author", () => {
    expect(has(grantedCapabilities({ allowWrite: true }), "author")).toBe(true);
  });
});
```
- [ ] **Step 2: Run, expect FAIL** — `bun test tests/capabilities.test.ts`.
- [ ] **Step 3: Implement** `src/capabilities.ts`
```typescript
export type Capability = "read" | "capture" | "resolve" | "converse" | "author";
const BASE: readonly Capability[] = ["read", "capture", "resolve", "converse"];
export function grantedCapabilities(opts: { allowWrite?: boolean }): ReadonlySet<Capability> {
  return new Set<Capability>(opts.allowWrite ? [...BASE, "author"] : BASE);
}
export function has(granted: ReadonlySet<Capability>, cap: Capability): boolean {
  return granted.has(cap);
}
```
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `git add src/capabilities.ts tests/capabilities.test.ts && git commit -m "feat(http): capability vocabulary (read/capture/resolve/converse/author)"`

---

## Task 2: Shared HTTP lib (`src/http/lib.ts`)

**Files:** Create `src/http/lib.ts`; modify `src/http/server.ts` + `src/agent/server.ts` to import from it (temporary — both still exist until Task 6).

**Interfaces — Produces** (exact signatures, lifted verbatim from the existing duplicates):
- `sha256(value: string): Buffer`
- `jsonBody(request: Request, maxBytes: number): Promise<JsonBodyRead>` (the bounded two-layer reader)
- `jsonResponse(status: number, data: unknown): Response`
- `errorResponse(status: number, error: string, message: string): Response` — **with** `schema` (the ask-route `dome.ask/v1`-style; parameterize the schema or keep two thin wrappers)
- `dataErrorResponse(status: number, error: string, message: string): Response` — **no** schema (the data-route shape both servers' `/capture`·`/tasks`·`/resolve` use)
- `commandErrorResponse(command: string, errorKind: string): Response`
- `viewProblemHttpStatus(problem: CatalogViewProblem): number`
- `positiveInt(raw: string | null): number | null`
- `authorized(request: Request, tokenDigest: Buffer): boolean`
- `queryTokenAuthorized(request: Request, url: URL, tokenDigest: Buffer): boolean`
- `serveStatic(staticDir: string, pathname: string): Promise<Response | null>`
- `fontResponse(request: Request): Response | null`
- `EXT_BY_TYPE: Record<string,string>`, and the schema constants (`SERVER_SCHEMA`, `DOCUMENT_SCHEMA`, `QUESTIONS_SCHEMA`, `COMMAND_ERROR_SCHEMA`, `ANSWER_SCHEMA` re-export, `ASK_SCHEMA`→keep as the agent answer schema `dome.ask/v1`).

- [ ] **Step 1: Create `src/http/lib.ts`** by moving these functions out of `src/http/server.ts` (lines per recon: `sha256` 417, `jsonBody` 440, `jsonResponse` 488, `errorResponse` 495, `commandErrorResponse` 504, `viewProblemHttpStatus` 515, `positiveInt` 529, `authorized` 393, `queryTokenAuthorized` 406, `fontResponse` 373) and the ask-server-only ones from `src/agent/server.ts` (`dataErrorResponse` 192, `serveStatic` 243, `EXT_BY_TYPE` 40, the bounded `jsonBody` is identical — keep one). Resolve the `errorResponse` divergence: ask-server's includes `schema`, http's doesn't — export both `errorResponse(schema, status, error, message)` (schema-carrying) and `dataErrorResponse(status, error, message)` (no schema), and have callers pick.
- [ ] **Step 2: Point both servers at the lib** — replace the in-file definitions in `src/http/server.ts` and `src/agent/server.ts` with imports from `src/http/lib.ts`. Delete the now-dead local copies.
- [ ] **Step 3: Verify no behavior change** — `bun test tests/http tests/agent/server.test.ts` (both servers' suites still green). `bunx tsc --noEmit 2>&1 | grep -E "src/http|src/agent" || echo clean`.
- [ ] **Step 4: Commit** — `git add src/http/lib.ts src/http/server.ts src/agent/server.ts && git commit -m "refactor(http): extract shared HTTP glue into src/http/lib.ts"`

---

## Task 3: Shared route handlers (`src/http/routes/`)

**Files:** Create `src/http/routes/{capture,resolve,views,transcribe,agent}.ts`. Modify both servers to call them.

**Interfaces — Produces** (each takes an open runtime or the vault-open wrapper + the request, returns `Response`; signatures mirror the existing inline bodies):
- `handleCapture(rt, request, maxBytes): Promise<Response>` — `performCapture` + `captureJsonDocument` (the identical body at agent/server.ts:652 and http/server.ts:173).
- `handleResolve(rt, request, maxBytes): Promise<Response>` — `vault.resolve` + the `dome.answer/v1` envelope (agent:702 / http:290).
- `handleTasks(rt, url): Promise<Response>` — `runCatalogView(today)` → `dome.daily.today/v1` (agent:677 / http:221).
- `handleQuery`, `handleToday` (HTML via `renderTodayHtml`), `handleStatus`, `handleDoc`, `handleQuestions`, `handleRecents` — moved from http/server.ts (query 201, today 234, status 194, doc 261, questions 280) and agent/server.ts (recents 747).
- `handleTranscribe(request, opts): Promise<Response>` — moved verbatim from `src/agent/server.ts:388` (local cmd / cloud OpenAI + temp-file lifecycle).
- `handleAgent(request, deps): Promise<Response>` / `handleAgentStream(request, deps): Promise<Response>` — the `/ask`(+stream) bodies from agent/server.ts:486/539, calling `runAgent`/`runAgentStream` (Task 7 rename).

- [ ] **Step 1: Move each route body** into its handler function, importing from `src/http/lib.ts` + the `src/surface/*` collectors. Keep the request/response logic byte-identical (this is a move, not a rewrite). For `/capture`·`/resolve`·`/tasks`, there is now **one** handler (delete the second copy).
- [ ] **Step 2: Wire both existing servers to the handlers** (temporary, pre-merge) so the suites exercise them.
- [ ] **Step 3: Verify green** — `bun test tests/http tests/agent/server.test.ts`; typecheck clean.
- [ ] **Step 4: Commit** — `git add src/http/routes && git add -u && git commit -m "refactor(http): extract one handler per capability (capture/resolve/views/transcribe/agent)"`

---

## Task 4: Rename the agent loop internals (`src/agent/`)

**Files:** Rename `src/agent/ask.ts`→`src/agent/agent.ts`; modify `tools.ts`, `types.ts`, and all importers; rename tests.

**Interfaces — Produces:** `runAgent`, `runAgentStream`, `AGENT_CHARTER`, `AgentResult`, `Citation` (from `AskCitation`), `buildAgentTools`. Old `Ask*` symbols deleted.

- [ ] **Step 1:** `git mv src/agent/ask.ts src/agent/agent.ts`; rename `runAsk`→`runAgent`, `runAskStream`→`runAgentStream`, `ASK_CHARTER`→`AGENT_CHARTER`, `AskStream`→`AgentStream`, `setupAsk`→`setupAgent`.
- [ ] **Step 2:** In `src/agent/types.ts`: `AskResult`→`AgentResult`, `AskCitation`→`Citation`. In `tools.ts`: `buildAskTools`→`buildAgentTools`. Update all imports (the route handlers from Task 3, tests).
- [ ] **Step 3:** `git mv tests/agent/ask.test.ts tests/agent/agent.test.ts` (+ `ask-stream`→`agent-stream`); update symbol references.
- [ ] **Step 4: Verify** — `bun test tests/agent`; typecheck clean.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "refactor(agent): rename ask→agent (runAgent, AgentResult, AGENT_CHARTER, buildAgentTools)"`

---

## Task 5: The unified server (`src/http/server.ts` rewrite)

**Files:** Rewrite `src/http/server.ts`.

**Interfaces — Produces:**
```typescript
export type DomeHttpServerOptions = {
  readonly vaultPath: string;
  readonly bundlesRoot?: string | undefined;
  readonly token: string;
  readonly maxBodyBytes?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly model?: string | undefined;
  readonly staticDir?: string | undefined;
  readonly allowWrite?: boolean | undefined;            // Phase 1: accepted, provisions nothing
  readonly transcribeCommand?: ReadonlyArray<string> | undefined;
  readonly transcribeApiKey?: string | undefined;
  readonly transcribeBaseUrl?: string | undefined;
  readonly transcribeModel?: string | undefined;
  readonly transcribeTimeoutMs?: number | undefined;
  // test seams (from the ask-server): askImpl/askStreamImpl → renamed agentImpl/agentStreamImpl
  readonly agentImpl?: AgentImpl | undefined;
  readonly agentStreamImpl?: AgentStreamImpl | undefined;
};
export function createDomeHttpServer(opts: DomeHttpServerOptions): { readonly fetch: (request: Request) => Promise<Response> };
```

- [ ] **Step 1:** Compute `const granted = grantedCapabilities({ allowWrite: opts.allowWrite })`; `const tokenDigest = sha256(opts.token)`; one `const enqueue = makeVaultMutex()`.
- [ ] **Step 2:** `fetch` handler in this order (merging both servers' flows):
  1. `fontResponse(request)` (the `/today/fonts/*`) — unauth.
  2. static: if `staticDir` set and GET `/` or `/assets/*` → `serveStatic` (unauth).
  3. auth: `authorized(...)` OR (`GET /today` only) `queryTokenAuthorized(...)`; else 401.
  4. transcribe pre-mutex: `POST /transcribe` → `handleTranscribe(request, opts)` (no vault lock).
  5. else `enqueue(() => routes(request))`.
- [ ] **Step 3:** `routes()` — a switch dispatching to the Task-3 handlers, each preceded by a capability guard:
```typescript
// read
"GET /healthz" | "GET /" (no staticDir) → ping {schema:"dome.http/v1", server:"dome", vault}
"GET /query"     → require(read)    → handleQuery(...)
"GET /tasks"     → require(read)    → handleTasks(...)
"GET /today"     → require(read)    → handleToday(...)
"GET /status"    → require(read)    → handleStatus(...)
"GET /doc"       → require(read)    → handleDoc(...)
"GET /questions" → require(read)    → handleQuestions(...)
"GET /recents"   → require(read)    → handleRecents(...)
"POST /capture"  → require(capture) → handleCapture(...)
"POST /resolve"  → require(resolve) → handleResolve(...)
"POST /agent"        → require(converse) → handleAgent(...)
"POST /agent/stream" → require(converse) → handleAgentStream(...)
// 404 otherwise (dataErrorResponse 404 not-found)
```
where `require(cap)` returns a 403 `dataErrorResponse("capability-denied", …)` if `!has(granted, cap)` (in Phase 1 read/capture/resolve/converse are always granted, so no behavior change; the guard is the seam). `POST /transcribe` requires `capture` (checked in `handleTranscribe`).
- [ ] **Step 4: Verify** — `bun test tests/http`; typecheck clean. (The ask-server tests still pass against the old `src/agent/server.ts` until Task 6.)
- [ ] **Step 5: Commit** — `git add src/http/server.ts && git commit -m "feat(http): one capability-gated server (read/capture/resolve/agent/transcribe/static)"`

---

## Task 6: CLI — fold ask-server into `dome http`; delete the verb

**Files:** Modify `src/cli/commands/http.ts`, `src/cli/index.ts`; **delete** `src/cli/commands/ask-server.ts`, `src/agent/server.ts`; migrate `tests/agent/server.test.ts`.

- [ ] **Step 1:** `RunHttpOptions` gains `model, staticDir, allowWrite, transcribeCmd, transcribeKey, transcribeUrl, transcribeModel` (copy the resolution logic — incl. `DOME_PWA_DIR`, `DOME_TRANSCRIBE_*`, `OPENAI_API_KEY` fallback, `DOME_ALLOW_WRITE` → `allowWrite` — verbatim from the deleted `ask-server.ts`). Thread all into `createDomeHttpServer` (spread-guarded).
- [ ] **Step 2:** In `src/cli/index.ts`, add to the `dome http` command: `--model`, `--static-dir`, `--allow-write`, `--transcribe-cmd/-key/-url/-model` options; thread to `runHttp`. **Remove** the entire `dome ask-server` command block and its `AskServerCliOptions` type; merge their option fields into `HttpCliOptions`.
- [ ] **Step 3:** `git rm src/cli/commands/ask-server.ts src/agent/server.ts`.
- [ ] **Step 4: Migrate the ask-server tests** — `git mv tests/agent/server.test.ts tests/http/server.test.ts` (or merge into the existing http server test); change `createAskServer`→`createDomeHttpServer`, the options (`askImpl`→`agentImpl`), and the routes (`/ask`→`/agent`). These tests (static serving, /healthz, /transcribe local+cloud+timeout, /capture/tasks/resolve, the agent routes) now prove the unified server preserves behavior.
- [ ] **Step 5: Update `tests/cli/bin.test.ts`** — remove `"ask-server"` from the top-level command list (line ~46); the `dome http` flag set changes (update any flag assertion).
- [ ] **Step 6: Verify** — `bin/dome http --help` shows the absorbed flags + no `ask-server` verb; `bin/dome --help` lists no `ask-server`. `bun test tests/http tests/cli/bin.test.ts`.
- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat(cli): dome http absorbs the agent backend; remove dome ask-server"`

---

## Task 7: Update fences

**Files:** `tests/integration/no-direct-mutation-outside-boundaries.test.ts`; verify `bundle-deps` + `public-surface-shape`.

- [ ] **Step 1:** In the no-direct-mutation allow-list, replace `"src/agent/server.ts"` with the new home of the temp-file write — `src/http/routes/transcribe.ts` (the `mkdtemp`+`Bun.write`+`rm` for transcription). Confirm by grepping `Bun.write|mkdtemp` under `src/http/` and `src/agent/`.
- [ ] **Step 2: Verify fences** — `bun test tests/integration/bundle-deps.test.ts tests/integration/public-surface-shape.test.ts tests/integration/no-direct-mutation-outside-boundaries.test.ts`. (`src/http/server.ts` + `src/agent/agent.ts` stay dynamic-import companions; `src/index.ts`'s graph must not gain the AI SDK.)
- [ ] **Step 3: Commit** — `git add -u && git commit -m "test: move no-direct-mutation allow-list to the transcribe handler"`

---

## Task 8: PWA client + run docs

**Files:** `pwa/src/api/client.ts`, `pwa/src/api/types.ts`, `pwa/vite.config.ts`, `pwa/tests/*`, the run-doc note.

- [ ] **Step 1:** `DomeClient.ask`→`agent`, `askStream`→`agentStream`; the routes they POST to `/ask`→`/agent`, `/ask/stream`→`/agent/stream`. Rename the type `AskResult`→`AgentResult` in `pwa/src/api/types.ts`.
- [ ] **Step 2:** `pwa/vite.config.ts` dev-proxy: replace `/ask`,`/ask/stream` targets with `/agent`,`/agent/stream`. (Default API port is now 3663 — update the proxy `API` const from `:4664` to `:3663`.)
- [ ] **Step 3:** Update the pwa tests (`api-client.test.ts`, `api-stream.test.ts`, `app.test.tsx`) for the renamed methods/routes.
- [ ] **Step 4:** Update the run doc / `docs/cohesive/brainstorms/2026-06-16-hosted-agent-and-mobile-client.md` note: the PWA is served by `dome http --static-dir pwa/dist --allow-write` on **:3663**; `dome ask-server` is gone.
- [ ] **Step 5: Verify** — `cd pwa && bun test && bun run typecheck && bun run build`.
- [ ] **Step 6: Commit** — `git add pwa docs && git commit -m "feat(pwa): call /agent (was /ask); served by dome http on :3663"`

---

## Task 9: Full-suite verification

- [ ] **Step 1:** `bun test ./tests 2>&1 | tail -5` — SDK suite green (no `/ask`, no `createAskServer`, no `ask-server` references remain: `grep -rn "createAskServer\|ask-server\|/ask\b\|runAsk\b" src tests | grep -v node_modules` → only intentional historical doc mentions).
- [ ] **Step 2:** `cd pwa && bun test` — pwa green.
- [ ] **Step 3:** `bunx tsc --noEmit` (root) — no NEW errors beyond the known pre-existing ones (`today.ts`, some `tests/extensions/*`).
- [ ] **Step 4:** Manual smoke (optional): `DOME_ASK_TOKEN=dev bin/dome http --vault docs --static-dir pwa/dist --port 3663` → `curl -s localhost:3663/healthz -H 'authorization: Bearer dev'` and `curl -s localhost:3663/recents -H ...`.
- [ ] **Step 5: Commit** any doc cleanup — `git commit -am "docs: Phase 1 convergence complete"`.

---

## Self-Review

**Spec coverage (Phase 1 scope):** one server ✅ (Task 5), delete `src/agent/server.ts` ✅ (Task 6), rename `/ask`→`/agent` + internals ✅ (Tasks 4–5), retire `dome ask-server` ✅ (Task 6), capability model gating every route ✅ (Tasks 1, 5), shared handlers killing the triplication ✅ (Tasks 2–3), fences/lockstep/client/docs ✅ (Tasks 7–8). Phase 2 (write tools, `author` provisioning, `done.changes`) is the **next plan** — `--allow-write` is accepted but inert here.

**Placeholder scan:** the route bodies in Tasks 2–3 are *moves* of code at cited line numbers (not "implement X" — the implementer relocates existing, tested code), and the migrated test suites are the behavior-preservation gate. New code (capabilities, options type, route table, guards, CLI flags) is shown in full. No "TBD"/"handle errors".

**Type consistency:** `Capability`/`grantedCapabilities`/`has` (Task 1) used in Task 5's `require()`. `createDomeHttpServer` options (Task 5) consumed by `runHttp` (Task 6). `runAgent`/`runAgentStream`/`AgentResult`/`buildAgentTools` (Task 4) consumed by `handleAgent`/`handleAgentStream` (Task 3) — **ordering note:** Task 3 references the renamed agent symbols, so either do Task 4 before wiring Task 3's agent handler, or wire it against `runAsk` and let Task 4's rename sweep it (the plan orders Task 4 before Task 5's server build; Task 3 may land the agent handler stubbed against the old name and the Task-4 rename updates it — implementer: rename-sweep includes `src/http/routes/agent.ts`).

**Risk:** this is a large refactor; the gate at every task is **the existing + migrated suites stay green**. If the agent-handler symbol ordering (Task 3 ↔ Task 4) causes churn, do Task 4 first.
