# Agent Request Log + Capability Exposure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make hosted-agent failures diagnosable from a server log: expose granted capabilities on the `dome http` ping, and append one structured JSON line per `/agent`(+`/agent/stream`) request to a configurable log file — so a failed "check off this to-do" can be pasted back for diagnosis.

**Architecture:** Two additive changes to `dome http`. (1) `GET /` + `/healthz` include `capabilities` in the ping. (2) A new `src/http/agent-log.ts` (append-one-JSON-line sink) wired into both `/agent` routes, enabled by `--agent-log <path>` / `DOME_AGENT_LOG`. No agent-loop changes — the log records what the route already has (granted caps, whether `author`/write was active, `changes`, `stopReason`, answer preview, duration, error). Tool-call trajectory is a noted follow-on.

**Tech Stack:** TypeScript, Bun, `bun test ./tests`, `bun run typecheck` (must stay 0 — the gate was just restored).

## Global Constraints

- **Two gates green at the end:** `bun run typecheck` = 0 (do not regress the just-restored gate) AND `bun test ./tests`. NOT bare `bun test`.
- **`src/http/agent-log.ts` writes to a file** (`appendFile`) → it MUST be added to `tests/integration/no-direct-mutation-outside-boundaries.test.ts` ALLOWED_FILES (same boundary class as `src/http/server.ts`'s transcribe temp-write — a process-scoped operational write, not a vault write).
- **Single-user trust domain** (loopback/Tailscale, owner-only): logging the question text is acceptable. Truncate the question + answer previews to a bound (e.g. 500 chars) to keep lines manageable. NEVER log the bearer token.
- **No behavior change when the log is unconfigured:** absent `--agent-log`/`DOME_AGENT_LOG`, the sink is a no-op (nothing written, no perf cost beyond a cheap nullcheck).
- **`src/http/server.ts` stays a CLI dynamic-import companion** (not in `src/index.ts`'s static graph) — `agent-log.ts` imports only `node:fs`/the logger, no new deps.
- House style: pure-decide + thin shells; structural enforcement. Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File structure

- `src/http/agent-log.ts` (NEW) — `AgentLogSink` type + `makeAgentLogSink(path | undefined)` (no-op when undefined) + the `AgentLogEntry` shape.
- `src/http/server.ts` (MODIFY) — `GET /`+`/healthz` add `capabilities`; `DomeHttpServerOptions` gains `agentLogPath?`; both `/agent` route handlers call the sink at completion.
- `src/cli/commands/http.ts` + `src/cli/index.ts` (MODIFY) — `--agent-log` flag + `DOME_AGENT_LOG` env, threaded into `createDomeHttpServer`.
- Tests: `tests/http/server-agent-routes.test.ts` (extend), `tests/http/agent-log.test.ts` (new) or fold into the routes test.

Two tasks; both touch `server.ts`. Task 1 (ping) is trivial; Task 2 (log) is the substance. Final whole-branch review at the end; per-task gating on tests-green + diff-check (neither task is high-risk — both additive).

---

### Task 1: Expose granted capabilities on the ping

**Files:**
- Modify: `src/http/server.ts` (the `GET /` / `GET /healthz` handler — returns `{ schema: SERVER_SCHEMA, server: "dome", vault: opts.vaultPath }`).
- Test: `tests/http/server-agent-routes.test.ts` (extend).

**Interfaces:**
- Consumes: the `granted` set (`grantedCapabilities({ allowWrite: opts.allowWrite })`, already computed at `createDomeHttpServer` top).
- Produces: the ping JSON gains `capabilities: Capability[]` (sorted, deterministic).

- [ ] **Step 1: Write the failing test** — in `tests/http/server-agent-routes.test.ts`, assert that `GET /` on a server built WITHOUT `allowWrite` returns `capabilities` NOT containing `"author"`, and WITH `allowWrite: true` returns `capabilities` containing `"author"` (plus the base read/capture/resolve/converse). Example:

```typescript
test("GET / exposes granted capabilities (author only with allowWrite)", async () => {
  const ro = createDomeHttpServer({ vaultPath: "/tmp/unused", token: TOKEN, agentImpl: async () => ({ answer: "", citations: [], steps: 0, stopReason: "final", changes: [] }) });
  const roBody = (await (await ro.fetch(new Request("http://localhost/"))).json()) as { capabilities: string[] };
  expect(roBody.capabilities).toContain("read");
  expect(roBody.capabilities).not.toContain("author");
  const rw = createDomeHttpServer({ vaultPath: "/tmp/unused", token: TOKEN, allowWrite: true, agentImpl: async () => ({ answer: "", citations: [], steps: 0, stopReason: "final", changes: [] }) });
  const rwBody = (await (await rw.fetch(new Request("http://localhost/"))).json()) as { capabilities: string[] };
  expect(rwBody.capabilities).toContain("author");
});
```

- [ ] **Step 2: Run it, expect FAIL** — `bun test ./tests/http/server-agent-routes.test.ts` ("capabilities" undefined).

- [ ] **Step 3: Implement** — in the `GET /` / `/healthz` handler, add `capabilities: [...granted].sort()` to the returned object:

```typescript
if (route === "GET /" || route === "GET /healthz") {
  return jsonResponse(200, { schema: SERVER_SCHEMA, server: "dome", vault: opts.vaultPath, capabilities: [...granted].sort() });
}
```

- [ ] **Step 4: Run, expect PASS** — `bun test ./tests/http/server-agent-routes.test.ts`. Update `docs/wiki/specs/http-surface.md`'s `GET /` description to note the `capabilities` field (one line).

- [ ] **Step 5: Commit** `git add src/http/server.ts tests/http/server-agent-routes.test.ts docs/wiki/specs/http-surface.md && git commit -m "feat(http): expose granted capabilities on the ping (curl-checkable write-mode)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 2: Agent request log

**Files:**
- Create: `src/http/agent-log.ts`
- Modify: `src/http/server.ts` (opts + both `/agent` route completion sites), `src/cli/commands/http.ts`, `src/cli/index.ts`, `tests/integration/no-direct-mutation-outside-boundaries.test.ts` (allow-list)
- Test: `tests/http/agent-log.test.ts` (new) + extend `tests/http/server-agent-routes.test.ts`

**Interfaces:**
- Produces:
  - `type AgentLogEntry = { ts: string; route: "/agent" | "/agent/stream"; question: string; capabilities: string[]; authorEnabled: boolean; changes: { path: string; kind: string }[]; stopReason: string | null; answerPreview: string | null; durationMs: number; error: string | null }`
  - `type AgentLogSink = (entry: AgentLogEntry) => void` (fire-and-forget; never throws into the request path)
  - `function makeAgentLogSink(path: string | undefined): AgentLogSink` — when `path` is undefined, returns a no-op. When set, appends `JSON.stringify(entry) + "\n"` to the file (best-effort; a write failure logs a warning via `createLogger` but never propagates).
- `DomeHttpServerOptions` gains `readonly agentLogPath?: string | undefined`. `createDomeHttpServer` builds `const agentLog = makeAgentLogSink(opts.agentLogPath)` once.

- [ ] **Step 1: Write the failing test** (`tests/http/agent-log.test.ts`): build a server with `agentLogPath` = a temp file + an `agentImpl` returning `{ answer: "done", citations: [], steps: 1, stopReason: "final", changes: [{ path: "wiki/x.md", kind: "edit" }] }` and `allowWrite: true`; POST `/agent`; read the temp file; assert it contains one JSON line with `route: "/agent"`, `authorEnabled: true`, `capabilities` including `"author"`, `changes` with the edit, `stopReason: "final"`, a non-null `answerPreview`, and a numeric `durationMs`. Also a no-op case: no `agentLogPath` → no file written / no throw. Run, expect FAIL.

- [ ] **Step 2: Implement `src/http/agent-log.ts`** — the types above; `makeAgentLogSink(undefined)` returns `() => {}`; with a path, returns a sink that `appendFile`s the line, wrapped so any error is caught + logged via `createLogger("http.agent-log")` (`event "http.agent.log_write_failed"`) and never thrown. Truncate `question`/`answerPreview` to 500 chars in the entry builder (a small `truncate` helper, or the caller truncates).

- [ ] **Step 3: Add `src/http/agent-log.ts` to the mutation-fence allow-list** — `tests/integration/no-direct-mutation-outside-boundaries.test.ts` ALLOWED_FILES, with a comment ("process-scoped operational append-only log; not a vault write — same class as the server's transcribe temp-write").

- [ ] **Step 4: Wire into `server.ts`** — add `agentLogPath?` to `DomeHttpServerOptions`; `const agentLog = makeAgentLogSink(opts.agentLogPath)` + `const authorEnabled = has(granted, "author")` + `const capabilityList = [...granted].sort()` near the top. 
  - **Buffered `POST /agent`:** capture `const startedAt = Date.now()` before the `ask` race; on success call `agentLog({ ts: new Date().toISOString(), route: "/agent", question, capabilities: capabilityList, authorEnabled, changes: result.changes, stopReason: result.stopReason, answerPreview: result.answer.slice(0,500), durationMs: Date.now()-startedAt, error: null })`; in the catch, call it with `stopReason: null, answerPreview: null, changes: [], error: <message>`.
  - **Streaming `POST /agent/stream`:** capture `startedAt` before draining; in the SSE `start`'s `finally` (where `stream.changes`/`stream.citations` are complete and `stopReason` is known on the done path), call `agentLog(...)` with `route: "/agent/stream"`, the drained `stream.changes`, the resolved `stopReason` (or null on error/timeout), `answerPreview: null` (stream text isn't buffered server-side — acceptable; note it), `error` set on the abort/timeout/error path. Ensure the log call cannot throw into the stream (the sink already swallows).

- [ ] **Step 5: Wire the CLI flag + env** — `src/cli/index.ts`: add `.option("--agent-log <path>", "Append one JSON line per /agent request to <path> (or set DOME_AGENT_LOG).")` to the `dome http` command; thread `options.agentLog` to `runHttp`. `src/cli/commands/http.ts`: `const agentLogPath = options.agentLog ?? process.env["DOME_AGENT_LOG"];` and spread `...(agentLogPath !== undefined ? { agentLogPath } : {})` into `createDomeHttpServer` (mirror the `staticDir`/transcribe pattern). Add `agentLog?: string` to `RunHttpOptions` + the CLI option type.

- [ ] **Step 6: Extend the routes test** — assert the streaming path also logs (a `/agent/stream` request writes a line with `route: "/agent/stream"` + the changes from the done event). 

- [ ] **Step 7: Verify** — `bun test ./tests/http ./tests/integration/no-direct-mutation-outside-boundaries.test.ts ./tests/cli` green; `bun run typecheck` = 0; `bun test ./tests` once. Update `docs/wiki/specs/http-surface.md` (one line on `--agent-log`) + add `DOME_AGENT_LOG` to `ENV_SPEC` if env vars are registered there (`grep DOME_TRANSCRIBE_CMD packages*/config* src/config* docs` — Dome may register env via a spec; if so, register `DOME_AGENT_LOG` too — gate `check:env`).

- [ ] **Step 8: Commit** `git add src/http/agent-log.ts src/http/server.ts src/cli tests docs && git commit -m "feat(http): structured /agent request log (--agent-log / DOME_AGENT_LOG)\n\nOne JSON line per /agent(+stream) request: granted caps, authorEnabled, changes,\nstopReason, answer preview, duration, error — so hosted-agent failures are\ndiagnosable from a log. No-op when unconfigured.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

## Self-Review

**Spec coverage (the approved design):** capability exposure on the ping → Task 1 ✓ (curl-checkable write-mode). Structured per-`/agent` log to a configurable file with granted-caps/author/changes/stopReason/answer/duration/error → Task 2 ✓. No-op when unconfigured → Task 2 (makeAgentLogSink(undefined)) ✓. Tool-call trajectory → explicitly a NOTED FOLLOW-ON (out of scope; would reuse the eval-harness trajectory-recorder pattern) — flagged, not silently dropped.

**Placeholder scan:** Task 2 Step 4/7 reference reading the exact stream-completion site + the ENV_SPEC convention before wiring (engine-integration detail read from live code), with concrete field-builders given. Task 1 carries complete code. No vague steps.

**Type consistency:** `AgentLogEntry`/`AgentLogSink`/`makeAgentLogSink` defined in Task 2, consumed in server.ts. `agentLogPath` opt consistent across server.ts + http.ts. `changes`/`stopReason` come from the existing `AgentResult` / `AgentStream` shapes (Phase 2). `capabilities` field consistent between Task 1's ping and Task 2's log entry (`[...granted].sort()`).

**Risk:** both tasks additive, no behavior change when unconfigured; the one correctness concern (file write → mutation fence) is handled by the allow-list (Task 2 Step 3) + the no-op default. Final whole-branch review covers the request-path wiring.
