# PWA Backend Additions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add the two server-side pieces the PWA needs to `dome ask-server`: serving the built static app, and a `POST /transcribe` route backed by a host-configured local whisper command. (The React client is a separate plan.)

**Architecture:** Both land on the existing `createAskServer` (`src/agent/server.ts`) — a companion entrypoint reached only via dynamic import. (1) **Static serving:** when a `staticDir` is configured, GET `/` serves the app shell and `/assets/*` the bundles, **unauthenticated** (a browser's initial navigation can't carry a bearer header; the shell is non-secret and the endpoint is a private trust domain), while every data/API route stays bearer-gated; the current `GET /` JSON ping moves to `GET /healthz`. (2) **`POST /transcribe`:** runtime-free (subprocess only, like `/capture` — no vault open, no mutex), bearer-gated, bounded body; writes the audio to a temp file and runs a host-configured command (the model-provider "shipped script" pattern), returning `{ text }`.

**Tech Stack:** TypeScript/Bun. `Bun.file` for static serving (sets content-type automatically), `Bun.spawn` for the whisper subprocess. Reuses the ask-server's existing `authorized`, `jsonResponse`, `dataErrorResponse`, `positiveInt`, and the `fetch` → auth → `enqueue(routes)` structure.

## Global Constraints

- `src/agent/` stays reachable ONLY via dynamic import (`dome ask-server` → `await import`); never statically imported from `src/index.ts`'s graph. The `bundle-deps` + `public-surface-shape` fences must stay green.
- Don't change `/ask`, `/ask/stream`, `/capture`, `/tasks`, `/resolve`, `/recents`, or `dome http`.
- Static GETs (shell/assets) bypass BOTH auth and the vault mutex; all other routes keep auth-before-routing exactly as today.
- `POST /transcribe` is runtime-free: no `withVault`, no `enqueue`/mutex (subprocess only), like `/capture`.

**Read before starting:** `src/agent/server.ts` (the whole `createAskServer` — the `fetch` wrapper at the bottom that does `authorized()` then `enqueue(() => routes(request))`; the `routes()` switch incl. `GET /` ping and `POST /capture` as the runtime-free template; the helpers `jsonResponse`, `dataErrorResponse`, `jsonBody`, `authorized`, `positiveInt`, `CreateAskServerOptions`), `src/cli/commands/ask-server.ts` + the `ask-server` block in `src/cli/index.ts` (to add CLI flags), `tests/agent/server.test.ts` and `tests/agent/ask-server-data-routes.test.ts` (the two test styles: injected-seam unit tests + the `runInit` fixture).

---

## Task 1: Static app-shell + asset serving (auth-carved-out) + `/healthz`

**Files:**
- Modify: `src/agent/server.ts` (add `staticDir` option; a static-GET branch before auth; move the ping to `/healthz`)
- Test: `tests/agent/server.test.ts`

**Interfaces:**
- Consumes: existing `CreateAskServerOptions`, `authorized`, `jsonResponse`, the `fetch`/`routes` structure.
- Produces: `CreateAskServerOptions` gains `readonly staticDir?: string | undefined`. New behavior: `GET /healthz` → the JSON ping `{schema:"dome.ask-server/v1", server:"dome-ask"}` (bearer-gated, via the normal path); when `staticDir` set, unauthenticated `GET /` → `index.html` and `GET /assets/*` → the file; when `staticDir` unset, `GET /` keeps returning the ping (back-compat).

- [ ] **Step 1: Write the failing tests**

```typescript
// add to tests/agent/server.test.ts
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function makeStaticDir(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "dome-pwa-static-"));
  await writeFile(join(dir, "index.html"), "<!doctype html><title>Dome</title>", "utf8");
  await mkdir(join(dir, "assets"), { recursive: true });
  await writeFile(join(dir, "assets", "app.js"), "console.log('dome')", "utf8");
  return dir;
}

describe("createAskServer static serving", () => {
  test("GET / serves the app shell unauthenticated when staticDir is set", async () => {
    const staticDir = await makeStaticDir();
    const server = createAskServer({ vaultPath: "/tmp/unused", token: TOKEN, staticDir, askImpl: async () => ({ answer: "", citations: [], steps: 0, stopReason: "final" }) });
    const res = await server.fetch(new Request("http://localhost/")); // NO auth header
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    expect(await res.text()).toContain("<title>Dome</title>");
  });

  test("GET /assets/* serves the asset unauthenticated", async () => {
    const staticDir = await makeStaticDir();
    const server = createAskServer({ vaultPath: "/tmp/unused", token: TOKEN, staticDir, askImpl: async () => ({ answer: "", citations: [], steps: 0, stopReason: "final" }) });
    const res = await server.fetch(new Request("http://localhost/assets/app.js"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("dome");
  });

  test("a traversal path under /assets is rejected", async () => {
    const staticDir = await makeStaticDir();
    const server = createAskServer({ vaultPath: "/tmp/unused", token: TOKEN, staticDir, askImpl: async () => ({ answer: "", citations: [], steps: 0, stopReason: "final" }) });
    const res = await server.fetch(new Request("http://localhost/assets/../index.html"));
    expect([403, 404]).toContain(res.status);
  });

  test("GET /healthz returns the ping (bearer-gated)", async () => {
    const server = createAskServer({ vaultPath: "/tmp/unused", token: TOKEN, askImpl: async () => ({ answer: "", citations: [], steps: 0, stopReason: "final" }) });
    expect((await server.fetch(new Request("http://localhost/healthz"))).status).toBe(401); // no token
    const ok = await server.fetch(new Request("http://localhost/healthz", { headers: { authorization: `Bearer ${TOKEN}` } }));
    expect(ok.status).toBe(200);
    expect((await ok.json() as { server: string }).server).toBe("dome-ask");
  });

  test("with no staticDir, GET / still returns the ping (back-compat)", async () => {
    const server = createAskServer({ vaultPath: "/tmp/unused", token: TOKEN, askImpl: async () => ({ answer: "", citations: [], steps: 0, stopReason: "final" }) });
    const res = await server.fetch(new Request("http://localhost/", { headers: { authorization: `Bearer ${TOKEN}` } }));
    expect(res.status).toBe(200);
    expect((await res.json() as { server: string }).server).toBe("dome-ask");
  });
});
```
(Use the file's existing `TOKEN` constant + `createAskServer` import; match the real `AskResult` shape for the `askImpl` stub — read the file.)

- [ ] **Step 2: Run, expect FAIL** — `cd <worktree> && bun test tests/agent/server.test.ts` (static-serving + /healthz not implemented).

- [ ] **Step 3: Implement in `src/agent/server.ts`.**
  1. Add to `CreateAskServerOptions`: `readonly staticDir?: string | undefined;`.
  2. Add a static-serve helper (uses `Bun.file`, which sets content-type from the extension):
  ```typescript
  import { resolve, sep, join } from "node:path";

  async function serveStatic(staticDir: string, pathname: string): Promise<Response | null> {
    // Only "/" (shell) and "/assets/..." are served. Everything else → null (fall through to API routing).
    const rel = pathname === "/" ? "index.html" : pathname.startsWith("/assets/") ? pathname.slice(1) : null;
    if (rel === null) return null;
    const root = resolve(staticDir);
    const full = resolve(join(root, rel));
    if (full !== root && !full.startsWith(root + sep)) {
      return new Response("forbidden", { status: 403 }); // traversal guard
    }
    const file = Bun.file(full);
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    return new Response(file); // Bun sets content-type from extension
  }
  ```
  3. In `routes()`, replace the `GET /` ping with `GET /healthz` (same JSON body); leave `GET /` to be handled by the static branch / fall-through. Keep the catch-all 404.
  4. In the `fetch` wrapper (the function that currently does `if (!authorized(...)) return 401; return enqueue(() => routes(request))`), add a static branch BEFORE auth:
  ```typescript
  fetch: async (request) => {
    const url = new URL(request.url);
    if (request.method === "GET" && opts.staticDir !== undefined) {
      const served = await serveStatic(opts.staticDir, url.pathname);
      if (served !== null) return served; // unauthenticated, no mutex
    }
    if (!authorized(request, digest)) return jsonResponse(401, { schema: SCHEMA, status: "error", error: "unauthorized" });
    return enqueue(() => routes(request));
  },
  ```
  Note: when `staticDir` is unset, the static branch is skipped entirely, so `GET /` falls through to `routes()` — add a `GET /` → ping case there too (back-compat), in addition to `GET /healthz`. (i.e. both `GET /` and `GET /healthz` return the ping in `routes()`; the static branch only intercepts `GET /` when `staticDir` is set.)

- [ ] **Step 4: Run, expect PASS** — `bun test tests/agent/server.test.ts`.
- [ ] **Step 5: Typecheck** — `bunx tsc --noEmit 2>&1 | grep -i "src/agent/server\|tests/agent/server" || echo "clean"`.
- [ ] **Step 6: Commit** — `git add src/agent/server.ts tests/agent/server.test.ts && git commit -m "feat(agent): serve the PWA static shell + assets (auth-carved-out); move ping to /healthz"`.

---

## Task 2: `POST /transcribe` (host whisper command)

**Files:**
- Modify: `src/agent/server.ts`
- Test: `tests/agent/server.test.ts`

**Interfaces:**
- Consumes: `CreateAskServerOptions`, `authorized`, `jsonResponse`, `dataErrorResponse`, `jsonBody`/the body-bound limit.
- Produces: `CreateAskServerOptions` gains `readonly transcribeCommand?: ReadonlyArray<string> | undefined;`. New route `POST /transcribe` (bearer-gated): audio body → `{ schema: "dome.transcribe/v1", text }`. Errors: 501 `transcribe-unconfigured` (no `transcribeCommand`), 400 `transcribe-usage` (empty body), 413 (over `maxBodyBytes`), 500 `transcribe-failed` (non-zero exit / spawn error).

- [ ] **Step 1: Write the failing tests**

```typescript
// add to tests/agent/server.test.ts
describe("POST /transcribe", () => {
  // A trivial "whisper" that ignores the audio file arg and prints a fixed transcript.
  const FAKE_WHISPER = ["sh", "-c", "cat >/dev/null; echo 'hello from whisper'"]; // reads/discards stdin? — see note
  function post(body: BodyInit | null, token = TOKEN): Request {
    return new Request("http://localhost/transcribe", { method: "POST", headers: token ? { authorization: `Bearer ${token}`, "content-type": "audio/m4a" } : { "content-type": "audio/m4a" }, body });
  }
  test("transcribes audio via the configured command", async () => {
    const server = createAskServer({ vaultPath: "/tmp/unused", token: TOKEN, transcribeCommand: FAKE_WHISPER, askImpl: async () => ({ answer: "", citations: [], steps: 0, stopReason: "final" }) });
    const res = await server.fetch(post(new Uint8Array([1, 2, 3, 4])));
    expect(res.status).toBe(200);
    const json = await res.json() as { schema: string; text: string };
    expect(json.schema).toBe("dome.transcribe/v1");
    expect(json.text).toBe("hello from whisper");
  });
  test("501 when transcribe is not configured", async () => {
    const server = createAskServer({ vaultPath: "/tmp/unused", token: TOKEN, askImpl: async () => ({ answer: "", citations: [], steps: 0, stopReason: "final" }) });
    expect((await server.fetch(post(new Uint8Array([1, 2, 3])))).status).toBe(501);
  });
  test("400 on empty body", async () => {
    const server = createAskServer({ vaultPath: "/tmp/unused", token: TOKEN, transcribeCommand: FAKE_WHISPER, askImpl: async () => ({ answer: "", citations: [], steps: 0, stopReason: "final" }) });
    expect((await server.fetch(post(new Uint8Array([])))).status).toBe(400);
  });
  test("401 without a token", async () => {
    const server = createAskServer({ vaultPath: "/tmp/unused", token: TOKEN, transcribeCommand: FAKE_WHISPER, askImpl: async () => ({ answer: "", citations: [], steps: 0, stopReason: "final" }) });
    expect((await server.fetch(post(new Uint8Array([1, 2, 3]), ""))).status).toBe(401);
  });
});
```
NOTE: the fake command receives the temp file path as its last arg (the implementation appends it). The `sh -c '... ; echo ...'` form ignores the path and prints a fixed transcript — fine for the unit. Confirm the spawn reads stdout correctly; adjust the fake if your implementation passes audio via stdin instead of a temp-file arg (the implementation below uses a temp-file arg).

- [ ] **Step 2: Run, expect FAIL** — `bun test tests/agent/server.test.ts`.

- [ ] **Step 3: Implement in `src/agent/server.ts`.**
  1. Add to `CreateAskServerOptions`: `readonly transcribeCommand?: ReadonlyArray<string> | undefined;`.
  2. Add the route to `routes()` (runtime-free — no `withVault`/`enqueue` beyond the outer wrapper's mutex; note `/transcribe` does NOT open the vault, like `/capture`):
  ```typescript
  import { mkdtempSync } from "node:fs";
  import { rm } from "node:fs/promises";
  import { tmpdir } from "node:os";
  import { join } from "node:path";

  const EXT_BY_TYPE: Record<string, string> = {
    "audio/m4a": ".m4a", "audio/mp4": ".m4a", "audio/webm": ".webm",
    "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/mpeg": ".mp3", "audio/ogg": ".ogg",
  };

  // inside routes():
  if (route === "POST /transcribe") {
    if (opts.transcribeCommand === undefined || opts.transcribeCommand.length === 0) {
      return dataErrorResponse(501, "transcribe-unconfigured", "transcription is not configured on this server.");
    }
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBodyBytes) return dataErrorResponse(413, "payload-too-large", "audio too large.");
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength === 0) return dataErrorResponse(400, "transcribe-usage", "POST /transcribe requires an audio body.");
    if (bytes.byteLength > maxBodyBytes) return dataErrorResponse(413, "payload-too-large", "audio too large.");
    const ext = EXT_BY_TYPE[(request.headers.get("content-type") ?? "").split(";")[0]!.trim()] ?? ".audio";
    const dir = mkdtempSync(join(tmpdir(), "dome-transcribe-"));
    const audioPath = join(dir, `audio${ext}`);
    try {
      await Bun.write(audioPath, bytes);
      const proc = Bun.spawn([...opts.transcribeCommand, audioPath], { stdout: "pipe", stderr: "pipe" });
      const out = await new Response(proc.stdout).text();
      const code = await proc.exited;
      if (code !== 0) {
        const err = await new Response(proc.stderr).text();
        return dataErrorResponse(500, "transcribe-failed", `transcription command exited ${code}: ${err.slice(0, 500)}`);
      }
      return jsonResponse(200, { schema: "dome.transcribe/v1", text: out.trim() });
    } catch (e) {
      return dataErrorResponse(500, "transcribe-failed", e instanceof Error ? e.message : String(e));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  ```
  Confirm `maxBodyBytes` is in scope in `routes()` (it is — used by `/capture`/`jsonBody`); confirm `dataErrorResponse(status, error, message)` exists with that signature (added for the data routes).

- [ ] **Step 4: Run, expect PASS** — `bun test tests/agent/server.test.ts`.
- [ ] **Step 5: Typecheck** — `bunx tsc --noEmit 2>&1 | grep -i "src/agent/server\|tests/agent/server" || echo "clean"`.
- [ ] **Step 6: Commit** — `git add src/agent/server.ts tests/agent/server.test.ts && git commit -m "feat(agent): POST /transcribe via a host-configured whisper command (runtime-free)"`.

---

## Task 3: CLI flags + doc + full-suite verify

**Files:**
- Modify: `src/cli/commands/ask-server.ts`, `src/cli/index.ts`, `docs/cohesive/brainstorms/2026-06-16-hosted-agent-and-mobile-client.md`

**Interfaces:**
- Consumes: `createAskServer` (now with `staticDir` + `transcribeCommand`), the existing `ask-server` CLI wiring.
- Produces: `dome ask-server` accepts `--static-dir <path>` (or env `DOME_PWA_DIR`) and `--transcribe-cmd <cmd>` (or env `DOME_TRANSCRIBE_CMD`, space-split into argv), threaded into `createAskServer`.

- [ ] **Step 1: Wire the flags.** In `src/cli/index.ts`'s `ask-server` command block, add `.option("--static-dir <path>", ...)` and `.option("--transcribe-cmd <cmd>", ...)`, pass them through to `runAskServer`. In `src/cli/commands/ask-server.ts`, extend `RunAskServerOptions` + resolve: `staticDir = options.staticDir ?? process.env["DOME_PWA_DIR"]`; `transcribeCommand = (options.transcribeCmd ?? process.env["DOME_TRANSCRIBE_CMD"])?.split(/\s+/).filter(Boolean)`; pass both into `createAskServer` (spread-guarded so `undefined` isn't passed). Mirror the existing option-threading style exactly.

- [ ] **Step 2: Verify the CLI** — `cd <worktree> && bin/dome ask-server --help 2>&1 | grep -E "static-dir|transcribe-cmd"` (both shown).

- [ ] **Step 3: Doc note.** In `docs/cohesive/brainstorms/2026-06-16-hosted-agent-and-mobile-client.md`, under the PWA backend topology note, add: the ask-server now also serves the static PWA (`--static-dir`/`DOME_PWA_DIR`, app shell + assets, auth-carved-out, ping at `/healthz`) and `POST /transcribe` (`--transcribe-cmd`/`DOME_TRANSCRIBE_CMD` → local whisper) — so it's the PWA's complete backend including voice-capture transcription; the React client is the remaining piece.

- [ ] **Step 4: Fences + full suite** — `bun test tests/agent tests/integration/bundle-deps.test.ts tests/integration/public-surface-shape.test.ts tests/cli/bin.test.ts` (all pass; `ai`/static-serving must NOT enter the core static graph — `src/agent` stays dynamic-import-only), then `bun test 2>&1 | tail -5` (full suite green).

- [ ] **Step 5: Commit** — `git add src/cli/commands/ask-server.ts src/cli/index.ts docs/cohesive/brainstorms/2026-06-16-hosted-agent-and-mobile-client.md && git commit -m "feat(cli): ask-server --static-dir + --transcribe-cmd; docs: PWA backend complete"`.

---

## Self-Review

**Spec coverage:** the spec's two server changes — static-serving (`GET /` shell + `/assets/*`, auth-carved-out, ping → `/healthz`) and `POST /transcribe` (host whisper command, runtime-free) — are Tasks 1 and 2; CLI wiring + doc in Task 3. The client (apiClient/Composer/ChatTranscript/Brief/Recents/captureQueue/tokenGate, manifest+SW) is explicitly the separate client plan, not here.

**Placeholder scan:** the two `NOTE`s are verification instructions (confirm `AskResult`/`dataErrorResponse`/`maxBodyBytes` shapes against the real file; adjust the fake-whisper if using stdin) — recon-derived code is filled in. No "TBD"/"handle errors"/bare "write tests".

**Type consistency:** `staticDir?: string` (Task 1) and `transcribeCommand?: ReadonlyArray<string>` (Task 2) are added to `CreateAskServerOptions` and consumed in Task 3's CLI threading with the same names. `dome.transcribe/v1` schema string consistent (Task 2 ↔ any client consumer). `serveStatic` only intercepts `/` + `/assets/*` (never shadows the API routes).

**Risk:** the one real risk is the whisper invocation contract (temp-file arg vs stdin, and audio-format conversion). The plan pushes format-handling into the host command (a user script, like the model-provider script) and passes a temp-file path — generic + testable with a fake. The exact host whisper script is the owner's to configure (out of scope; documented).
