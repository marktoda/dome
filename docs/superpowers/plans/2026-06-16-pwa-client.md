# PWA Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build the Dome PWA client — a React+Vite app served by `dome ask-server`: voice-capture (record→transcribe→review→file) + text-chat ask (streamed, source-backed) + a brief panel + a recents panel.

**Architecture:** A self-contained React app in `pwa/` (its own `package.json`/`tsconfig.json`/`bunfig.toml`/Vite — isolated from the node-only SDK build). One typed `apiClient` is the single place that knows the ask-server wire shapes; small focused components consume it. Built to `pwa/dist` (Vite default: `index.html` + hashed `assets/*`), served by `dome ask-server --static-dir pwa/dist`. Same origin ⇒ no CORS; a single bearer token in `localStorage` is sent on every API call.

**Tech Stack:** React 19, Vite 6, `@vitejs/plugin-react`, TypeScript (`jsx: react-jsx`, DOM lib); tests via `bun test` with `@testing-library/react` + `@happy-dom/global-registrator`; `fake-indexeddb` for the offline-queue test.

## Global Constraints

- The app lives entirely under `pwa/`; **no changes to `src/`** (the backend — static-serving + all routes — already shipped on `main`). The only repo-root edits are `.gitignore` (ignore `pwa/node_modules`, `pwa/dist`) and the root `package.json` `test`/`typecheck` scripts (scope + add pwa).
- **The SDK test suite must stay node-only.** Root `bun test` must NOT pick up `pwa/tests/*.test.tsx` (they need DOM+jsx). Root `test` script is scoped to `tests/`; PWA tests run via `cd pwa && bun test`.
- Single bearer token, `localStorage` key `dome.token`; sent as `Authorization: Bearer <token>` on every API call. The app shell + assets load unauthenticated (the server serves them so); only API calls carry the token.
- Wire shapes are FIXED by the shipped server — use the exact field names in the per-task interface blocks; do not invent fields.
- Visual language: signal-first / calm (lead lines with status, color is signal not decoration, a real all-clear state) — reuse the CLI/cockpit vocabulary; no heavy UI deps.

**MILESTONE 1 (Tasks 1–6): a working read-only glance app** — token gate + brief + recents, served on the phone. Independently shippable.
**MILESTONE 2 (Tasks 7–11): the agent** — text-chat ask (streamed), voice capture, offline queue, PWA install + styling.

**Read before starting:** the spec `docs/superpowers/specs/2026-06-16-pwa-design.md`; the per-route wire shapes are reproduced in each task's Interfaces block (authoritative — taken from the shipped `src/agent/server.ts`). Do not read `src/` to re-derive shapes; trust the blocks.

---

## File Structure (`pwa/`)

```
pwa/
  package.json            # deps + scripts (dev/build/test/typecheck)
  tsconfig.json           # jsx: react-jsx, lib DOM
  bunfig.toml             # [test] preload = ["./tests/preload.ts"]
  vite.config.ts          # react plugin, base "/", dev proxy to ask-server
  index.html              # Vite entry → /src/main.tsx
  public/manifest.webmanifest
  src/
    main.tsx              # React root render
    App.tsx               # shell assembly (token gate → screen)
    styles.css            # signal-first aesthetic
    api/types.ts          # wire types (one per dome.*/v1 doc)
    api/client.ts         # DomeClient: typed fetch + SSE, token injection
    auth/useToken.ts      # token storage hook (localStorage)
    auth/TokenGate.tsx    # first-run token prompt
    components/Brief.tsx
    components/Recents.tsx
    components/ChatTranscript.tsx
    chat/streamReducer.ts # pure reducer over SSE events → messages
    components/Composer.tsx
    capture/captureMachine.ts # pure capture state machine
    capture/captureQueue.ts   # IndexedDB offline queue
    sw.ts                 # minimal service worker (Milestone 2)
  tests/
    preload.ts            # registers happy-dom
    *.test.ts(x)
  dist/                   # build output (gitignored)
```

---

## Task 1: Scaffold the `pwa/` app + test boundary

**Files:**
- Create: `pwa/package.json`, `pwa/tsconfig.json`, `pwa/bunfig.toml`, `pwa/vite.config.ts`, `pwa/index.html`, `pwa/src/main.tsx`, `pwa/src/App.tsx`, `pwa/tests/preload.ts`, `pwa/tests/smoke.test.tsx`
- Modify: repo-root `.gitignore`, repo-root `package.json` (scripts)

**Interfaces:**
- Produces: a runnable React app + a green `cd pwa && bun test`; `pwa/src/App.tsx` exports `default function App()`.

- [ ] **Step 1: Create `pwa/package.json`**

```json
{
  "name": "@dome/pwa",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit",
    "test": "bun test"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@happy-dom/global-registrator": "^16.0.0",
    "@testing-library/react": "^16.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "fake-indexeddb": "^6.0.0",
    "typescript": "^5.6.0",
    "vite": "^6.0.0"
  }
}
```

- [ ] **Step 2: Create `pwa/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "types": ["bun", "@types/react", "@types/react-dom"],
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "tests/**/*.ts", "tests/**/*.tsx", "vite.config.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create `pwa/bunfig.toml` + `pwa/tests/preload.ts`**

`pwa/bunfig.toml`:
```toml
[test]
preload = ["./tests/preload.ts"]
```
`pwa/tests/preload.ts`:
```typescript
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
```

- [ ] **Step 4: Create `pwa/vite.config.ts`, `pwa/index.html`, `pwa/src/main.tsx`, `pwa/src/App.tsx`**

`pwa/vite.config.ts` (the dev proxy lets `bun run dev` hit a running ask-server on :4664):
```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API = "http://127.0.0.1:4664";
const proxy = Object.fromEntries(
  ["/ask", "/ask/stream", "/capture", "/tasks", "/recents", "/resolve", "/transcribe", "/healthz"].map(
    (p) => [p, { target: API, changeOrigin: true }],
  ),
);

export default defineConfig({
  plugins: [react()],
  base: "/",
  build: { outDir: "dist", sourcemap: false },
  server: { port: 5173, proxy },
});
```
`pwa/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <title>Dome</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```
`pwa/src/main.tsx`:
```typescript
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```
`pwa/src/App.tsx` (placeholder, replaced in Task 11):
```typescript
export default function App(): React.ReactElement {
  return <main><h1>Dome</h1></main>;
}
```
Also create an empty `pwa/src/styles.css` (filled in Task 11) so the import resolves.

- [ ] **Step 5: Write the smoke test** `pwa/tests/smoke.test.tsx`

```typescript
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import App from "../src/App";

afterEach(cleanup);

describe("App", () => {
  test("renders the Dome heading", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "Dome" })).toBeDefined();
  });
});
```

- [ ] **Step 6: Install + run the smoke test**

Run: `cd /Users/mark.toda/dev/dome/.claude/worktrees/pwa-client/build/pwa && bun install && bun test`
Expected: 1 pass (happy-dom registers, App renders).

- [ ] **Step 7: Scope the SDK test boundary + gitignore.**

In repo-root `.gitignore`, append:
```
pwa/node_modules/
pwa/dist/
```
In repo-root `package.json`: read the current `"test"` and `"typecheck"` scripts. If `"test"` is a bare `bun test`, change it to `bun test tests/` (so root CI stays SDK/node-only and never discovers `pwa/tests`). Append ` && cd pwa && bun run typecheck` is NOT wanted in the root typecheck (pwa typechecks independently); instead leave root typecheck as-is. Verify the exact current scripts before editing and keep their existing extra `-p` args intact.

- [ ] **Step 8: Verify the boundary holds**

Run (from repo root): `cd /Users/mark.toda/dev/dome/.claude/worktrees/pwa-client/build && bun test tests/ 2>&1 | tail -3`
Expected: the SDK suite runs (2900+ pass), and NO `pwa/` test files appear in the output.
Run: `cd pwa && bun run build 2>&1 | tail -3`
Expected: Vite writes `pwa/dist/index.html` + `pwa/dist/assets/*`.

- [ ] **Step 9: Commit**

```bash
cd /Users/mark.toda/dev/dome/.claude/worktrees/pwa-client/build
git add pwa .gitignore package.json
git commit -m "feat(pwa): scaffold React+Vite app, test boundary (happy-dom), build wiring"
```

---

## Task 2: `api/types.ts` — the wire types

**Files:**
- Create: `pwa/src/api/types.ts`
- Test: `pwa/tests/api-types.test.ts` (a compile-only assertion test)

**Interfaces:**
- Produces (exact field names — from the shipped server):
  - `Citation = { path: string; commit?: string; snippet?: string }`
  - `AskResult = { schema: "dome.ask/v1"; status: "ok"; answer: string; citations: Citation[]; steps: number; stopReason: "final" | "budget" }`
  - `StreamEvent = { type: "text"; text: string } | { type: "done"; citations: Citation[]; stopReason: "final" | "budget" } | { type: "error"; message: string }`
  - `CaptureResult = { schema: "dome.capture/v1"; status: "captured" | "duplicate" | "error"; path?: string; commit?: string; title?: string; error?: string }`
  - `TodayItem = { text: string; path: string; line: number | null; dueDate: string | null; origin?: string; entities?: string[] }`
  - `TodayQuestion = { id: number; question: string; resolveCommand: string; options: string[] }`
  - `Today = { schema: "dome.daily.today/v1"; date: string; openTasks: TodayItem[]; followups: TodayItem[]; questions: TodayQuestion[]; brief: { text: string; sourceRef: { path: string } } | null; calendar: { events: { time: string; title: string; meta: string }[]; sourceRef: { path: string } } | null; hero: { kind: "task" | "question"; item: TodayItem | TodayQuestion } | null; counts: { openTasks: number; followups: number; questions: number } }`
  - `RecentEntry = { path: string; title: string; lastChangedAt: string; changedBy: "human" | "engine"; subject: string }`
  - `Recents = { schema: "dome.recents/v1"; count: number; entries: RecentEntry[] }`
  - `ResolveResult = { schema: "dome.answer/v1"; status: "answered" | "already-answered" | "invalid-option" | "error"; options?: string[]; question?: { id: number; status: string; question: string; answer: string | null }; message?: string }`
  - `Transcript = { schema: "dome.transcribe/v1"; text: string }`
  - `ApiError = { status: "error"; error: string; message?: string }`

- [ ] **Step 1: Write the types file** exactly as the Interfaces block above (each `export type`). For unions use the discriminants shown.

- [ ] **Step 2: Write a compile assertion test** `pwa/tests/api-types.test.ts`

```typescript
import { describe, expect, test } from "bun:test";
import type { Today, Recents, StreamEvent } from "../src/api/types";

describe("api types", () => {
  test("shapes accept representative server payloads", () => {
    const today: Today = {
      schema: "dome.daily.today/v1", date: "2026-06-17",
      openTasks: [{ text: "x", path: "wiki/dailies/2026-06-17.md", line: 3, dueDate: null }],
      followups: [], questions: [], brief: null, calendar: null, hero: null,
      counts: { openTasks: 1, followups: 0, questions: 0 },
    };
    const recents: Recents = { schema: "dome.recents/v1", count: 1, entries: [{ path: "wiki/x.md", title: "X", lastChangedAt: "2026-06-17T00:00:00Z", changedBy: "human", subject: "edit" }] };
    const evt: StreamEvent = { type: "done", citations: [{ path: "wiki/x.md" }], stopReason: "final" };
    expect(today.openTasks[0]!.text).toBe("x");
    expect(recents.entries[0]!.changedBy).toBe("human");
    expect(evt.type).toBe("done");
  });
});
```

- [ ] **Step 3: Run** — `cd pwa && bun test tests/api-types.test.ts` — expect PASS (compiles + asserts).
- [ ] **Step 4: Commit** — `git add pwa/src/api/types.ts pwa/tests/api-types.test.ts && git commit -m "feat(pwa): wire types for the ask-server routes"`

---

## Task 3: `api/client.ts` — typed client (non-streaming routes)

**Files:**
- Create: `pwa/src/api/client.ts`
- Test: `pwa/tests/api-client.test.ts`

**Interfaces:**
- Consumes: types from Task 2.
- Produces: `class DomeClient` constructed `new DomeClient(token: string, baseUrl = "")`; methods (all reject with `ApiError`-shaped `Error` on non-2xx):
  - `tasks(date?: string): Promise<Today>` → `GET /tasks`
  - `recents(limit?: number): Promise<Recents>` → `GET /recents`
  - `capture(input: { text: string; title?: string; captureId?: string }): Promise<CaptureResult>` → `POST /capture`
  - `resolve(id: number, value: string): Promise<ResolveResult>` → `POST /resolve`
  - `transcribe(audio: Blob): Promise<Transcript>` → `POST /transcribe` (raw body, `content-type` from the blob)
  - `ask(question: string): Promise<AskResult>` → `POST /ask`
  - (streaming `askStream` added in Task 4.)
  - All requests send `Authorization: Bearer <token>` and (for JSON POSTs) `content-type: application/json`. A private `authHeaders()` builds them. `baseUrl` is "" in production (same origin).

- [ ] **Step 1: Write the failing test** `pwa/tests/api-client.test.ts` (mock `globalThis.fetch`):

```typescript
import { afterEach, describe, expect, test, mock } from "bun:test";
import { DomeClient } from "../src/api/client";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function mockJson(status: number, body: unknown): void {
  globalThis.fetch = mock(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as never;
}

describe("DomeClient", () => {
  test("recents() GETs /recents with the bearer token and parses the body", async () => {
    let seen: Request | undefined;
    globalThis.fetch = mock(async (req: Request) => {
      seen = req;
      return new Response(JSON.stringify({ schema: "dome.recents/v1", count: 0, entries: [] }), { status: 200 });
    }) as never;
    const c = new DomeClient("tok");
    const r = await c.recents();
    expect(r.entries).toEqual([]);
    expect(seen!.url).toContain("/recents");
    expect(seen!.headers.get("authorization")).toBe("Bearer tok");
  });

  test("capture() POSTs JSON and returns the doc", async () => {
    mockJson(200, { schema: "dome.capture/v1", status: "captured", path: "inbox/raw/x.md", commit: "abc" });
    const c = new DomeClient("tok");
    const res = await c.capture({ text: "hi" });
    expect(res.status).toBe("captured");
    expect(res.path).toBe("inbox/raw/x.md");
  });

  test("a non-2xx rejects with the error envelope message", async () => {
    mockJson(400, { status: "error", error: "capture-usage", message: "needs text" });
    const c = new DomeClient("tok");
    await expect(c.capture({ text: "" })).rejects.toThrow("capture-usage");
  });

  test("resolve() POSTs id+value to /resolve", async () => {
    let body: unknown;
    globalThis.fetch = mock(async (req: Request) => { body = await req.json(); return new Response(JSON.stringify({ schema: "dome.answer/v1", status: "answered" }), { status: 200 }); }) as never;
    const c = new DomeClient("tok");
    const r = await c.resolve(3, "yes");
    expect(r.status).toBe("answered");
    expect(body).toEqual({ id: 3, value: "yes" });
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `cd pwa && bun test tests/api-client.test.ts`.

- [ ] **Step 3: Implement** `pwa/src/api/client.ts`:

```typescript
import type { AskResult, CaptureResult, Recents, ResolveResult, Today, Transcript } from "./types";

export class DomeClient {
  constructor(private readonly token: string, private readonly baseUrl: string = "") {}

  private authHeaders(json: boolean): Record<string, string> {
    const h: Record<string, string> = { authorization: `Bearer ${this.token}` };
    if (json) h["content-type"] = "application/json";
    return h;
  }

  private async parse<T>(res: Response): Promise<T> {
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const msg = body && typeof body["error"] === "string"
        ? `${body["error"]}${typeof body["message"] === "string" ? `: ${body["message"]}` : ""}`
        : `request failed (${res.status})`;
      throw new Error(msg);
    }
    return body as T;
  }

  async tasks(date?: string): Promise<Today> {
    const q = date !== undefined ? `?date=${encodeURIComponent(date)}` : "";
    return this.parse<Today>(await fetch(`${this.baseUrl}/tasks${q}`, { headers: this.authHeaders(false) }));
  }

  async recents(limit?: number): Promise<Recents> {
    const q = limit !== undefined ? `?limit=${limit}` : "";
    return this.parse<Recents>(await fetch(`${this.baseUrl}/recents${q}`, { headers: this.authHeaders(false) }));
  }

  async capture(input: { text: string; title?: string; captureId?: string }): Promise<CaptureResult> {
    return this.parse<CaptureResult>(await fetch(`${this.baseUrl}/capture`, { method: "POST", headers: this.authHeaders(true), body: JSON.stringify(input) }));
  }

  async resolve(id: number, value: string): Promise<ResolveResult> {
    return this.parse<ResolveResult>(await fetch(`${this.baseUrl}/resolve`, { method: "POST", headers: this.authHeaders(true), body: JSON.stringify({ id, value }) }));
  }

  async transcribe(audio: Blob): Promise<Transcript> {
    return this.parse<Transcript>(await fetch(`${this.baseUrl}/transcribe`, { method: "POST", headers: { ...this.authHeaders(false), "content-type": audio.type || "audio/webm" }, body: audio }));
  }

  async ask(question: string): Promise<AskResult> {
    return this.parse<AskResult>(await fetch(`${this.baseUrl}/ask`, { method: "POST", headers: this.authHeaders(true), body: JSON.stringify({ question }) }));
  }
}
```

- [ ] **Step 4: Run, expect PASS** — `cd pwa && bun test tests/api-client.test.ts`.
- [ ] **Step 5: Commit** — `git add pwa/src/api/client.ts pwa/tests/api-client.test.ts && git commit -m "feat(pwa): DomeClient typed API (tasks/recents/capture/resolve/transcribe/ask)"`

---

## Task 4: `askStream` — SSE parsing on the client

**Files:**
- Modify: `pwa/src/api/client.ts` (add `askStream`)
- Test: `pwa/tests/api-stream.test.ts`

**Interfaces:**
- Consumes: `StreamEvent` from Task 2.
- Produces: `DomeClient.askStream(question: string, onEvent: (e: StreamEvent) => void, signal?: AbortSignal): Promise<void>` — POSTs `/ask/stream`, reads the `text/event-stream` body, parses each `data: <json>\n\n` frame into a `StreamEvent`, calls `onEvent` per event; resolves when the stream ends. Also export a standalone pure parser `parseSseChunk(buffer: string): { events: StreamEvent[]; rest: string }` for testability.

- [ ] **Step 1: Write the failing test** `pwa/tests/api-stream.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { parseSseChunk } from "../src/api/client";
import type { StreamEvent } from "../src/api/types";

describe("parseSseChunk", () => {
  test("parses complete data: frames and keeps the trailing partial", () => {
    const input = `data: ${JSON.stringify({ type: "text", text: "Hello " })}\n\n` +
                  `data: ${JSON.stringify({ type: "text", text: "world" })}\n\n` +
                  `data: {"type":"do`;
    const { events, rest } = parseSseChunk(input);
    expect(events.map((e) => (e.type === "text" ? e.text : e.type))).toEqual(["Hello ", "world"]);
    expect(rest).toBe(`data: {"type":"do`);
  });

  test("ignores blank lines and malformed frames without throwing", () => {
    const { events } = parseSseChunk(`\n\ndata: not json\n\ndata: ${JSON.stringify({ type: "done", citations: [], stopReason: "final" } as StreamEvent)}\n\n`);
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe("done");
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `cd pwa && bun test tests/api-stream.test.ts`.

- [ ] **Step 3: Implement** — add to `pwa/src/api/client.ts`:

```typescript
import type { StreamEvent } from "./types";

// Parse a buffer of SSE text into complete events + the leftover partial frame.
export function parseSseChunk(buffer: string): { events: StreamEvent[]; rest: string } {
  const events: StreamEvent[] = [];
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? ""; // last element is the (possibly empty) partial
  for (const part of parts) {
    const line = part.split("\n").find((l) => l.startsWith("data:"));
    if (line === undefined) continue;
    const json = line.slice("data:".length).trim();
    if (json.length === 0) continue;
    try {
      events.push(JSON.parse(json) as StreamEvent);
    } catch {
      // malformed frame — skip
    }
  }
  return { events, rest };
}
```
And the method on `DomeClient`:
```typescript
  async askStream(question: string, onEvent: (e: StreamEvent) => void, signal?: AbortSignal): Promise<void> {
    const res = await fetch(`${this.baseUrl}/ask/stream`, {
      method: "POST",
      headers: { ...this.authHeaders(true), accept: "text/event-stream" },
      body: JSON.stringify({ question }),
      ...(signal !== undefined ? { signal } : {}),
    });
    if (!res.ok || res.body === null) {
      onEvent({ type: "error", message: `stream failed (${res.status})` });
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseSseChunk(buffer);
      buffer = rest;
      for (const e of events) onEvent(e);
    }
  }
```

- [ ] **Step 4: Run, expect PASS** — `cd pwa && bun test tests/api-stream.test.ts`.
- [ ] **Step 5: Commit** — `git add pwa/src/api/client.ts pwa/tests/api-stream.test.ts && git commit -m "feat(pwa): askStream SSE parsing"`

---

## Task 5: token gate (`useToken` + `TokenGate`)

**Files:**
- Create: `pwa/src/auth/useToken.ts`, `pwa/src/auth/TokenGate.tsx`
- Test: `pwa/tests/token-gate.test.tsx`

**Interfaces:**
- Produces:
  - `useToken(): { token: string | null; setToken: (t: string) => void; clear: () => void }` — reads/writes `localStorage["dome.token"]`, state-backed.
  - `TokenGate({ children }: { children: (token: string) => React.ReactNode }): React.ReactElement` — when no token, renders a single-field form (input + "Connect" button) that calls `setToken`; when a token exists, renders `children(token)`.

- [ ] **Step 1: Write the failing test** `pwa/tests/token-gate.test.tsx`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TokenGate } from "../src/auth/TokenGate";

afterEach(cleanup);
beforeEach(() => localStorage.clear());

describe("TokenGate", () => {
  test("prompts for a token when none stored, then renders children with it", () => {
    render(<TokenGate>{(t) => <div>connected:{t}</div>}</TokenGate>);
    expect(screen.getByRole("button", { name: /connect/i })).toBeDefined();
    fireEvent.change(screen.getByLabelText(/token/i), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: /connect/i }));
    expect(screen.getByText("connected:secret")).toBeDefined();
    expect(localStorage.getItem("dome.token")).toBe("secret");
  });

  test("renders children immediately when a token is already stored", () => {
    localStorage.setItem("dome.token", "pre");
    render(<TokenGate>{(t) => <div>connected:{t}</div>}</TokenGate>);
    expect(screen.getByText("connected:pre")).toBeDefined();
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `cd pwa && bun test tests/token-gate.test.tsx`.

- [ ] **Step 3: Implement.**
`pwa/src/auth/useToken.ts`:
```typescript
import { useCallback, useState } from "react";

const KEY = "dome.token";

export function useToken(): { token: string | null; setToken: (t: string) => void; clear: () => void } {
  const [token, setTokenState] = useState<string | null>(() => localStorage.getItem(KEY));
  const setToken = useCallback((t: string) => { localStorage.setItem(KEY, t); setTokenState(t); }, []);
  const clear = useCallback(() => { localStorage.removeItem(KEY); setTokenState(null); }, []);
  return { token, setToken, clear };
}
```
`pwa/src/auth/TokenGate.tsx`:
```typescript
import { useState } from "react";
import { useToken } from "./useToken";

export function TokenGate({ children }: { children: (token: string) => React.ReactNode }): React.ReactElement {
  const { token, setToken } = useToken();
  const [draft, setDraft] = useState("");
  if (token !== null) return <>{children(token)}</>;
  return (
    <main className="gate">
      <h1>Dome</h1>
      <form
        onSubmit={(e) => { e.preventDefault(); if (draft.trim().length > 0) setToken(draft.trim()); }}
      >
        <label htmlFor="token">Access token</label>
        <input id="token" type="password" value={draft} onChange={(e) => setDraft(e.target.value)} autoComplete="off" />
        <button type="submit">Connect</button>
      </form>
    </main>
  );
}
```

- [ ] **Step 4: Run, expect PASS** — `cd pwa && bun test tests/token-gate.test.tsx`.
- [ ] **Step 5: Commit** — `git add pwa/src/auth pwa/tests/token-gate.test.tsx && git commit -m "feat(pwa): bearer-token gate (localStorage)"`

---

## Task 6: `Brief` + `Recents` panels

**Files:**
- Create: `pwa/src/components/Brief.tsx`, `pwa/src/components/Recents.tsx`
- Test: `pwa/tests/brief.test.tsx`, `pwa/tests/recents.test.tsx`

**Interfaces:**
- Consumes: `Today`, `Recents`, `TodayItem`, `TodayQuestion` (Task 2).
- Produces:
  - `Brief({ today, onResolve }: { today: Today; onResolve: (id: number, value: string) => void }): React.ReactElement` — header `today · N open` (N = counts.openTasks + counts.followups + counts.questions); a hero line if `today.hero`; open tasks + follow-ups as lines (text + optional `due <dueDate>`); questions with their `options` as buttons that call `onResolve(id, option)`; an all-clear state ("you're clear") when all three counts are 0.
  - `Recents({ recents }: { recents: Recents }): React.ReactElement` — a list: each entry `title` + a dim `changedBy · relative-time` line; empty state when `count === 0`.

- [ ] **Step 1: Write the failing tests.**
`pwa/tests/brief.test.tsx`:
```typescript
import { afterEach, describe, expect, test, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Brief } from "../src/components/Brief";
import type { Today } from "../src/api/types";

afterEach(cleanup);
const base: Today = { schema: "dome.daily.today/v1", date: "2026-06-17", openTasks: [], followups: [], questions: [], brief: null, calendar: null, hero: null, counts: { openTasks: 0, followups: 0, questions: 0 } };

describe("Brief", () => {
  test("renders open tasks with due dates and a question whose option resolves", () => {
    const onResolve = mock(() => {});
    const today: Today = { ...base,
      openTasks: [{ text: "Draft roadmap", path: "wiki/dailies/d.md", line: 1, dueDate: "2026-06-20" }],
      questions: [{ id: 7, question: "Hourly or daily?", resolveCommand: "dome resolve 7 <value>", options: ["hourly", "daily"] }],
      counts: { openTasks: 1, followups: 0, questions: 1 } };
    render(<Brief today={today} onResolve={onResolve} />);
    expect(screen.getByText(/Draft roadmap/)).toBeDefined();
    expect(screen.getByText(/2026-06-20/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "hourly" }));
    expect(onResolve).toHaveBeenCalledWith(7, "hourly");
  });

  test("shows an all-clear state when nothing is open", () => {
    render(<Brief today={base} onResolve={() => {}} />);
    expect(screen.getByText(/clear/i)).toBeDefined();
  });
});
```
`pwa/tests/recents.test.tsx`:
```typescript
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { Recents } from "../src/components/Recents";
import type { Recents as RecentsT } from "../src/api/types";

afterEach(cleanup);

describe("Recents", () => {
  test("lists entries by title", () => {
    const recents: RecentsT = { schema: "dome.recents/v1", count: 1, entries: [{ path: "wiki/entities/rh.md", title: "Robinhood Chain", lastChangedAt: new Date().toISOString(), changedBy: "engine", subject: "consolidate" }] };
    render(<Recents recents={recents} />);
    expect(screen.getByText("Robinhood Chain")).toBeDefined();
  });
  test("empty state when count is 0", () => {
    render(<Recents recents={{ schema: "dome.recents/v1", count: 0, entries: [] }} />);
    expect(screen.getByText(/nothing recent/i)).toBeDefined();
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `cd pwa && bun test tests/brief.test.tsx tests/recents.test.tsx`.

- [ ] **Step 3: Implement.**
`pwa/src/components/Brief.tsx`:
```typescript
import type { Today, TodayItem, TodayQuestion } from "../api/types";

function Item({ item }: { item: TodayItem }): React.ReactElement {
  return (
    <li className="item">
      <span>{item.text}</span>
      {item.dueDate !== null ? <span className="due"> · due {item.dueDate}</span> : null}
    </li>
  );
}

function Question({ q, onResolve }: { q: TodayQuestion; onResolve: (id: number, value: string) => void }): React.ReactElement {
  return (
    <li className="question">
      <div>{q.question}</div>
      <div className="options">
        {q.options.map((opt) => (
          <button key={opt} type="button" onClick={() => onResolve(q.id, opt)}>{opt}</button>
        ))}
      </div>
    </li>
  );
}

export function Brief({ today, onResolve }: { today: Today; onResolve: (id: number, value: string) => void }): React.ReactElement {
  const open = today.counts.openTasks + today.counts.followups + today.counts.questions;
  return (
    <section className="brief">
      <header>today · {open === 0 ? "all clear" : `${open} open`}</header>
      {today.brief !== null ? <p className="brief-text">{today.brief.text}</p> : null}
      {open === 0 ? <p className="all-clear">You're clear.</p> : null}
      {today.hero !== null ? <div className="hero">⚠ {"text" in today.hero.item ? today.hero.item.text : today.hero.item.question}</div> : null}
      {today.openTasks.length > 0 ? <ul>{today.openTasks.map((t, i) => <Item key={`${t.path}:${t.line}:${i}`} item={t} />)}</ul> : null}
      {today.followups.length > 0 ? <ul className="followups">{today.followups.map((t, i) => <Item key={`f${t.path}:${t.line}:${i}`} item={t} />)}</ul> : null}
      {today.questions.length > 0 ? <ul className="questions">{today.questions.map((q) => <Question key={q.id} q={q} onResolve={onResolve} />)}</ul> : null}
    </section>
  );
}
```
`pwa/src/components/Recents.tsx`:
```typescript
import type { Recents as RecentsT } from "../api/types";

function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function Recents({ recents }: { recents: RecentsT }): React.ReactElement {
  if (recents.count === 0) return <section className="recents"><p className="empty">nothing recent</p></section>;
  return (
    <section className="recents">
      <ul>
        {recents.entries.map((e) => (
          <li key={e.path}>
            <span className="title">{e.title}</span>
            <span className="meta"> · {e.changedBy} · {ago(e.lastChangedAt)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 4: Run, expect PASS** — `cd pwa && bun test tests/brief.test.tsx tests/recents.test.tsx`.
- [ ] **Step 5: Commit** — `git add pwa/src/components/Brief.tsx pwa/src/components/Recents.tsx pwa/tests/brief.test.tsx pwa/tests/recents.test.tsx && git commit -m "feat(pwa): Brief + Recents panels"`

> **MILESTONE 1 boundary.** After Task 6, a minimal `App` could already wire TokenGate → fetch tasks/recents → Brief + Recents into a working read-only glance app. (Full assembly is Task 11; if you want to ship M1 early, do a thin App here.)

---

## Task 7: chat stream reducer + `ChatTranscript`

**Files:**
- Create: `pwa/src/chat/streamReducer.ts`, `pwa/src/components/ChatTranscript.tsx`
- Test: `pwa/tests/stream-reducer.test.ts`, `pwa/tests/chat-transcript.test.tsx`

**Interfaces:**
- Consumes: `StreamEvent`, `Citation` (Task 2).
- Produces:
  - `type ChatMessage = { role: "user" | "assistant"; text: string; citations: Citation[]; streaming: boolean }`
  - `type ChatState = { messages: ChatMessage[] }`
  - reducer actions: `{ kind: "user"; text: string }`, `{ kind: "assistant-start" }`, `{ kind: "event"; event: StreamEvent }`. `chatReducer(state, action): ChatState` — `user` appends a user message; `assistant-start` appends an empty streaming assistant message; `event` mutates the last assistant message: `text` appends `text`, `done` sets citations + `streaming=false`, `error` appends ` [error: <message>]` and ends streaming.
  - `ChatTranscript({ state }: { state: ChatState }): React.ReactElement` — renders messages; assistant citations as `[path]` chips.

- [ ] **Step 1: Write the failing tests.**
`pwa/tests/stream-reducer.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { chatReducer, type ChatState } from "../src/chat/streamReducer";

describe("chatReducer", () => {
  test("streams an assistant answer then finalizes with citations", () => {
    let s: ChatState = { messages: [] };
    s = chatReducer(s, { kind: "user", text: "when?" });
    s = chatReducer(s, { kind: "assistant-start" });
    s = chatReducer(s, { kind: "event", event: { type: "text", text: "July " } });
    s = chatReducer(s, { kind: "event", event: { type: "text", text: "2026" } });
    s = chatReducer(s, { kind: "event", event: { type: "done", citations: [{ path: "wiki/x.md" }], stopReason: "final" } });
    expect(s.messages).toHaveLength(2);
    const a = s.messages[1]!;
    expect(a.role).toBe("assistant");
    expect(a.text).toBe("July 2026");
    expect(a.streaming).toBe(false);
    expect(a.citations[0]!.path).toBe("wiki/x.md");
  });
  test("error event ends streaming with an inline note", () => {
    let s: ChatState = { messages: [] };
    s = chatReducer(s, { kind: "assistant-start" });
    s = chatReducer(s, { kind: "event", event: { type: "error", message: "timeout" } });
    expect(s.messages[0]!.streaming).toBe(false);
    expect(s.messages[0]!.text).toContain("timeout");
  });
});
```
`pwa/tests/chat-transcript.test.tsx`:
```typescript
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { ChatTranscript } from "../src/components/ChatTranscript";

afterEach(cleanup);

describe("ChatTranscript", () => {
  test("renders messages and citation chips", () => {
    render(<ChatTranscript state={{ messages: [
      { role: "user", text: "q", citations: [], streaming: false },
      { role: "assistant", text: "a", citations: [{ path: "wiki/x.md" }], streaming: false },
    ] }} />);
    expect(screen.getByText("q")).toBeDefined();
    expect(screen.getByText("a")).toBeDefined();
    expect(screen.getByText(/wiki\/x\.md/)).toBeDefined();
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `cd pwa && bun test tests/stream-reducer.test.ts tests/chat-transcript.test.tsx`.

- [ ] **Step 3: Implement.**
`pwa/src/chat/streamReducer.ts`:
```typescript
import type { Citation, StreamEvent } from "../api/types";

export type ChatMessage = { role: "user" | "assistant"; text: string; citations: Citation[]; streaming: boolean };
export type ChatState = { messages: ChatMessage[] };
export type ChatAction =
  | { kind: "user"; text: string }
  | { kind: "assistant-start" }
  | { kind: "event"; event: StreamEvent };

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.kind) {
    case "user":
      return { messages: [...state.messages, { role: "user", text: action.text, citations: [], streaming: false }] };
    case "assistant-start":
      return { messages: [...state.messages, { role: "assistant", text: "", citations: [], streaming: true }] };
    case "event": {
      const msgs = state.messages.slice();
      const last = msgs[msgs.length - 1];
      if (last === undefined || last.role !== "assistant") return state;
      const e = action.event;
      if (e.type === "text") msgs[msgs.length - 1] = { ...last, text: last.text + e.text };
      else if (e.type === "done") msgs[msgs.length - 1] = { ...last, citations: e.citations, streaming: false };
      else msgs[msgs.length - 1] = { ...last, text: `${last.text} [error: ${e.message}]`, streaming: false };
      return { messages: msgs };
    }
  }
}
```
`pwa/src/components/ChatTranscript.tsx`:
```typescript
import type { ChatState } from "../chat/streamReducer";

export function ChatTranscript({ state }: { state: ChatState }): React.ReactElement {
  return (
    <div className="transcript">
      {state.messages.map((m, i) => (
        <div key={i} className={`msg ${m.role}`}>
          <p>{m.text}{m.streaming ? <span className="cursor">▍</span> : null}</p>
          {m.citations.length > 0 ? (
            <div className="cites">{m.citations.map((c) => <span key={c.path} className="chip">{c.path}</span>)}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run, expect PASS** — `cd pwa && bun test tests/stream-reducer.test.ts tests/chat-transcript.test.tsx`.
- [ ] **Step 5: Commit** — `git add pwa/src/chat pwa/src/components/ChatTranscript.tsx pwa/tests/stream-reducer.test.ts pwa/tests/chat-transcript.test.tsx && git commit -m "feat(pwa): chat stream reducer + ChatTranscript"`

---

## Task 8: capture state machine (`captureMachine`)

**Files:**
- Create: `pwa/src/capture/captureMachine.ts`
- Test: `pwa/tests/capture-machine.test.ts`

**Interfaces:**
- Produces: a pure reducer for the voice-capture lifecycle (the Composer drives the side effects; this is the logic):
  - `type CaptureState = { phase: "idle" | "recording" | "transcribing" | "review" | "filing"; draft: string; error: string | null }`
  - `INITIAL: CaptureState = { phase: "idle", draft: "", error: null }`
  - actions: `{ kind: "start-recording" }`, `{ kind: "stop-recording" }` (→ transcribing), `{ kind: "transcribed"; text: string }` (→ review, draft=text), `{ kind: "edit"; text: string }` (review), `{ kind: "file" }` (review→filing), `{ kind: "filed" }` (→ idle, clear), `{ kind: "fail"; error: string }` (→ idle with error), `{ kind: "cancel" }` (→ idle, clear).
  - `captureReducer(state, action): CaptureState` enforcing legal transitions (illegal action in a phase returns state unchanged).

- [ ] **Step 1: Write the failing test** `pwa/tests/capture-machine.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { captureReducer, INITIAL } from "../src/capture/captureMachine";

describe("captureReducer", () => {
  test("happy path: record → transcribe → review → file → idle", () => {
    let s = INITIAL;
    s = captureReducer(s, { kind: "start-recording" }); expect(s.phase).toBe("recording");
    s = captureReducer(s, { kind: "stop-recording" }); expect(s.phase).toBe("transcribing");
    s = captureReducer(s, { kind: "transcribed", text: "buy milk" }); expect(s.phase).toBe("review"); expect(s.draft).toBe("buy milk");
    s = captureReducer(s, { kind: "edit", text: "buy oat milk" }); expect(s.draft).toBe("buy oat milk");
    s = captureReducer(s, { kind: "file" }); expect(s.phase).toBe("filing");
    s = captureReducer(s, { kind: "filed" }); expect(s.phase).toBe("idle"); expect(s.draft).toBe("");
  });
  test("fail during transcribing returns to idle with an error", () => {
    let s = captureReducer(captureReducer(INITIAL, { kind: "start-recording" }), { kind: "stop-recording" });
    s = captureReducer(s, { kind: "fail", error: "no mic" });
    expect(s.phase).toBe("idle"); expect(s.error).toBe("no mic");
  });
  test("illegal transition is a no-op (file from idle)", () => {
    expect(captureReducer(INITIAL, { kind: "file" })).toEqual(INITIAL);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `cd pwa && bun test tests/capture-machine.test.ts`.

- [ ] **Step 3: Implement** `pwa/src/capture/captureMachine.ts`:
```typescript
export type CapturePhase = "idle" | "recording" | "transcribing" | "review" | "filing";
export type CaptureState = { phase: CapturePhase; draft: string; error: string | null };
export const INITIAL: CaptureState = { phase: "idle", draft: "", error: null };

export type CaptureAction =
  | { kind: "start-recording" } | { kind: "stop-recording" }
  | { kind: "transcribed"; text: string } | { kind: "edit"; text: string }
  | { kind: "file" } | { kind: "filed" }
  | { kind: "fail"; error: string } | { kind: "cancel" };

export function captureReducer(s: CaptureState, a: CaptureAction): CaptureState {
  switch (a.kind) {
    case "start-recording": return s.phase === "idle" ? { phase: "recording", draft: "", error: null } : s;
    case "stop-recording": return s.phase === "recording" ? { ...s, phase: "transcribing" } : s;
    case "transcribed": return s.phase === "transcribing" ? { phase: "review", draft: a.text, error: null } : s;
    case "edit": return s.phase === "review" ? { ...s, draft: a.text } : s;
    case "file": return s.phase === "review" && s.draft.trim().length > 0 ? { ...s, phase: "filing" } : s;
    case "filed": return s.phase === "filing" ? INITIAL : s;
    case "fail": return { phase: "idle", draft: "", error: a.error };
    case "cancel": return INITIAL;
  }
}
```

- [ ] **Step 4: Run, expect PASS** — `cd pwa && bun test tests/capture-machine.test.ts`.
- [ ] **Step 5: Commit** — `git add pwa/src/capture/captureMachine.ts pwa/tests/capture-machine.test.ts && git commit -m "feat(pwa): voice-capture state machine"`

---

## Task 9: offline `captureQueue` (IndexedDB)

**Files:**
- Create: `pwa/src/capture/captureQueue.ts`
- Test: `pwa/tests/capture-queue.test.ts`

**Interfaces:**
- Produces: an IndexedDB-backed FIFO queue for captures made while offline:
  - `type QueuedCapture = { id: string; text: string; title?: string }`
  - `class CaptureQueue { constructor(factory?: IDBFactory) ; enqueue(c: QueuedCapture): Promise<void> ; all(): Promise<QueuedCapture[]> ; remove(id: string): Promise<void> }` — DB name `dome-pwa`, store `captures` (keyPath `id`). `factory` defaults to `indexedDB` (injectable so the test passes `fake-indexeddb`).

- [ ] **Step 1: Write the failing test** `pwa/tests/capture-queue.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { CaptureQueue } from "../src/capture/captureQueue";

describe("CaptureQueue", () => {
  test("enqueue → all → remove (FIFO, survives reopen)", async () => {
    const factory = new IDBFactory();
    const q = new CaptureQueue(factory);
    await q.enqueue({ id: "1", text: "first" });
    await q.enqueue({ id: "2", text: "second" });
    expect((await q.all()).map((c) => c.text)).toEqual(["first", "second"]);
    await q.remove("1");
    // a fresh instance over the same factory sees the persisted state
    const q2 = new CaptureQueue(factory);
    expect((await q2.all()).map((c) => c.id)).toEqual(["2"]);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `cd pwa && bun test tests/capture-queue.test.ts`.

- [ ] **Step 3: Implement** `pwa/src/capture/captureQueue.ts`:
```typescript
export type QueuedCapture = { id: string; text: string; title?: string };

const DB = "dome-pwa";
const STORE = "captures";

export class CaptureQueue {
  constructor(private readonly factory: IDBFactory = indexedDB) {}

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = this.factory.open(DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("indexeddb open failed"));
    });
  }

  private async tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("indexeddb tx failed"));
      t.oncomplete = () => db.close();
    });
  }

  async enqueue(c: QueuedCapture): Promise<void> { await this.tx("readwrite", (s) => s.put(c)); }
  async all(): Promise<QueuedCapture[]> { return (await this.tx<QueuedCapture[]>("readonly", (s) => s.getAll() as IDBRequest<QueuedCapture[]>)); }
  async remove(id: string): Promise<void> { await this.tx("readwrite", (s) => s.delete(id)); }
}
```
(Note: `getAll()` returns insertion order for an `id` keyPath where ids are assigned in order; the test uses ordered ids "1","2".)

- [ ] **Step 4: Run, expect PASS** — `cd pwa && bun test tests/capture-queue.test.ts`.
- [ ] **Step 5: Commit** — `git add pwa/src/capture/captureQueue.ts pwa/tests/capture-queue.test.ts && git commit -m "feat(pwa): offline capture queue (IndexedDB)"`

---

## Task 10: `Composer` (mic + text), wired to the capture machine

**Files:**
- Create: `pwa/src/components/Composer.tsx`
- Test: `pwa/tests/composer.test.tsx`

**Interfaces:**
- Consumes: `captureReducer`/`INITIAL` (Task 8).
- Produces: `Composer({ onAsk, onTranscribe, onFile }: { onAsk: (q: string) => void; onTranscribe: (audio: Blob) => Promise<string>; onFile: (text: string) => Promise<void> }): React.ReactElement`. A pinned bar: a text input + send (calls `onAsk(text)` and clears) and a mic button. The mic flow uses `MediaRecorder` (guarded — if unavailable, the button is disabled); on stop it calls `onTranscribe(blob)` → puts the result in the draft (review phase: the text field shows the transcript with a "file" + "cancel" affordance) → "file" calls `onFile(draft)`. The recording/transcription side effects are driven through `captureReducer`. Because `MediaRecorder`/`getUserMedia` aren't in happy-dom, the **test exercises the text-ask path and the review→file path by simulating the machine transitions via the exposed handlers** (do NOT require a real recorder in the test).

- [ ] **Step 1: Write the failing test** `pwa/tests/composer.test.tsx`:
```typescript
import { afterEach, describe, expect, test, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Composer } from "../src/components/Composer";

afterEach(cleanup);

describe("Composer", () => {
  test("typing + send calls onAsk and clears the field", () => {
    const onAsk = mock(() => {});
    render(<Composer onAsk={onAsk} onTranscribe={async () => ""} onFile={async () => {}} />);
    const input = screen.getByPlaceholderText(/ask/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "what's open?" } });
    fireEvent.submit(input.closest("form")!);
    expect(onAsk).toHaveBeenCalledWith("what's open?");
    expect(input.value).toBe("");
  });

  test("mic button is present (recording support is feature-detected)", () => {
    render(<Composer onAsk={() => {}} onTranscribe={async () => ""} onFile={async () => {}} />);
    expect(screen.getByRole("button", { name: /record|mic|🎤/i })).toBeDefined();
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `cd pwa && bun test tests/composer.test.tsx`.

- [ ] **Step 3: Implement** `pwa/src/components/Composer.tsx`:
```typescript
import { useReducer, useRef, useState } from "react";
import { captureReducer, INITIAL } from "../capture/captureMachine";

type Props = {
  onAsk: (q: string) => void;
  onTranscribe: (audio: Blob) => Promise<string>;
  onFile: (text: string) => Promise<void>;
};

const canRecord = typeof navigator !== "undefined" && typeof (navigator as Navigator).mediaDevices?.getUserMedia === "function" && typeof MediaRecorder !== "undefined";

export function Composer({ onAsk, onTranscribe, onFile }: Props): React.ReactElement {
  const [text, setText] = useState("");
  const [cap, dispatch] = useReducer(captureReducer, INITIAL);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const startRecording = async (): Promise<void> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        dispatch({ kind: "stop-recording" });
        try {
          const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
          dispatch({ kind: "transcribed", text: await onTranscribe(blob) });
        } catch (e) { dispatch({ kind: "fail", error: e instanceof Error ? e.message : String(e) }); }
      };
      recorderRef.current = rec;
      rec.start();
      dispatch({ kind: "start-recording" });
    } catch (e) { dispatch({ kind: "fail", error: e instanceof Error ? e.message : String(e) }); }
  };

  const file = async (): Promise<void> => {
    dispatch({ kind: "file" });
    try { await onFile(cap.draft); dispatch({ kind: "filed" }); }
    catch (e) { dispatch({ kind: "fail", error: e instanceof Error ? e.message : String(e) }); }
  };

  if (cap.phase === "review") {
    return (
      <div className="composer review">
        <textarea value={cap.draft} onChange={(e) => dispatch({ kind: "edit", text: e.target.value })} aria-label="capture draft" />
        <button type="button" onClick={file}>File</button>
        <button type="button" onClick={() => dispatch({ kind: "cancel" })}>Cancel</button>
      </div>
    );
  }

  return (
    <form className="composer" onSubmit={(e) => { e.preventDefault(); const q = text.trim(); if (q.length > 0) { onAsk(q); setText(""); } }}>
      <button type="button" aria-label="record" disabled={!canRecord || cap.phase !== "idle"}
        onClick={() => { if (cap.phase === "idle") void startRecording(); else recorderRef.current?.stop(); }}>
        {cap.phase === "recording" ? "■" : "🎤"}
      </button>
      <input placeholder="ask your brain…" value={text} onChange={(e) => setText(e.target.value)} />
      <button type="submit" aria-label="send">↦</button>
      {cap.error !== null ? <span className="err">{cap.error}</span> : null}
      {cap.phase === "transcribing" ? <span className="status">transcribing…</span> : null}
    </form>
  );
}
```

- [ ] **Step 4: Run, expect PASS** — `cd pwa && bun test tests/composer.test.tsx`.
- [ ] **Step 5: Commit** — `git add pwa/src/components/Composer.tsx pwa/tests/composer.test.tsx && git commit -m "feat(pwa): Composer (text ask + voice capture review)"`

---

## Task 11: App shell assembly + manifest + service worker + styling

**Files:**
- Modify: `pwa/src/App.tsx`, `pwa/src/styles.css`
- Create: `pwa/public/manifest.webmanifest`, `pwa/src/sw.ts`
- Modify: `pwa/index.html` (register SW), `pwa/vite.config.ts` (build the SW)
- Test: `pwa/tests/app.test.tsx` (replaces the Task 1 smoke test)

**Interfaces:**
- Consumes: everything above (`DomeClient`, `TokenGate`, `Brief`, `Recents`, `ChatTranscript` + `chatReducer`, `Composer`, `CaptureQueue`).
- Produces: the assembled single-screen app. `App` wraps content in `TokenGate`; once tokened, constructs a `DomeClient`, loads `/tasks` + `/recents` on mount + on `visibilitychange` (foreground refresh), renders Brief + collapsed Recents + ChatTranscript + Composer. Composer's `onAsk` runs `client.askStream` dispatching into `chatReducer`; `onTranscribe` = `client.transcribe`; `onFile` = `client.capture` (on network failure, enqueue to `CaptureQueue` and flush on next foreground). Resolving a brief question calls `client.resolve` then refetches `/tasks`.

- [ ] **Step 1: Write the assembly test** `pwa/tests/app.test.tsx` (mock `fetch` for tasks+recents; assert the screen renders both panels + the composer once a token is present):
```typescript
import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import App from "../src/App";

afterEach(cleanup);
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("dome.token", "tok");
  globalThis.fetch = mock(async (req: Request) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/tasks") return new Response(JSON.stringify({ schema: "dome.daily.today/v1", date: "2026-06-17", openTasks: [], followups: [], questions: [], brief: null, calendar: null, hero: null, counts: { openTasks: 0, followups: 0, questions: 0 } }), { status: 200 });
    if (url.pathname === "/recents") return new Response(JSON.stringify({ schema: "dome.recents/v1", count: 0, entries: [] }), { status: 200 });
    return new Response("{}", { status: 200 });
  }) as never;
});

describe("App", () => {
  test("renders the brief (all-clear), recents, and composer when tokened", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText(/clear/i)).toBeDefined());
    expect(screen.getByPlaceholderText(/ask/i)).toBeDefined();
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `cd pwa && bun test tests/app.test.tsx`.

- [ ] **Step 3: Implement `pwa/src/App.tsx`** (assemble; use a small `useEffect` loader). Delete `pwa/tests/smoke.test.tsx` (superseded by `app.test.tsx`).
```typescript
import { useCallback, useEffect, useReducer, useState } from "react";
import { DomeClient } from "./api/client";
import type { Recents as RecentsT, Today } from "./api/types";
import { TokenGate } from "./auth/TokenGate";
import { Brief } from "./components/Brief";
import { Recents } from "./components/Recents";
import { ChatTranscript } from "./components/ChatTranscript";
import { Composer } from "./components/Composer";
import { chatReducer } from "./chat/streamReducer";

function Screen({ token }: { token: string }): React.ReactElement {
  const client = new DomeClient(token);
  const [today, setToday] = useState<Today | null>(null);
  const [recents, setRecents] = useState<RecentsT | null>(null);
  const [chat, dispatch] = useReducer(chatReducer, { messages: [] });

  const refresh = useCallback(() => {
    client.tasks().then(setToday).catch(() => {});
    client.recents().then(setRecents).catch(() => {});
  }, [token]);

  useEffect(() => {
    refresh();
    const onVis = (): void => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [refresh]);

  const onAsk = (q: string): void => {
    dispatch({ kind: "user", text: q });
    dispatch({ kind: "assistant-start" });
    void client.askStream(q, (e) => dispatch({ kind: "event", event: e }));
  };

  return (
    <main className="screen">
      {today !== null ? <Brief today={today} onResolve={(id, v) => { void client.resolve(id, v).then(refresh); }} /> : null}
      {recents !== null ? <details className="recents-wrap"><summary>recents ({recents.count})</summary><Recents recents={recents} /></details> : null}
      <ChatTranscript state={chat} />
      <Composer
        onAsk={onAsk}
        onTranscribe={(blob) => client.transcribe(blob).then((t) => t.text)}
        onFile={(text) => client.capture({ text }).then(() => undefined)}
      />
    </main>
  );
}

export default function App(): React.ReactElement {
  return <TokenGate>{(token) => <Screen token={token} />}</TokenGate>;
}
```

- [ ] **Step 4: Implement the PWA shell.**
`pwa/public/manifest.webmanifest`:
```json
{ "name": "Dome", "short_name": "Dome", "start_url": "/", "display": "standalone", "background_color": "#111111", "theme_color": "#111111", "icons": [] }
```
`pwa/src/sw.ts` (minimal — cache the shell for offline boot):
```typescript
/// <reference lib="webworker" />
const CACHE = "dome-shell-v1";
self.addEventListener("install", (e) => { (e as ExtendableEvent).waitUntil(caches.open(CACHE).then((c) => c.addClose ? c : c)); });
self.addEventListener("fetch", () => { /* network-first; shell cached by the browser. v1: no-op passthrough. */ });
export {};
```
(Keep the SW minimal for v1 — install + passthrough. Offline capture resilience lives in `CaptureQueue`, not the SW.) Register it in `pwa/index.html` before `</body>`:
```html
<script>if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});</script>
```
In `pwa/vite.config.ts`, add a second rollup input so `sw.ts` builds to `sw.js` at the root (or document building it separately). Simplest: add to `build`: `rollupOptions: { input: { main: "index.html", sw: "src/sw.ts" }, output: { entryFileNames: (c) => c.name === "sw" ? "sw.js" : "assets/[name]-[hash].js" } }`.

- [ ] **Step 5: Styling pass** — fill `pwa/src/styles.css` with the signal-first/calm aesthetic (dark `#111`/`#eee`, system-ui, ~42rem centered column, the composer pinned at the bottom, dim `.meta`/`.due`, citation `.chip`s, a calm `.all-clear`). Keep it dependency-free. (This is where the `frontend-design` skill applies — the implementer may invoke it for this step.)

- [ ] **Step 6: Run the app test + full pwa suite + build**
Run: `cd pwa && bun test` (all pass) ; `bun run build` (writes `dist/index.html`, `dist/assets/*`, `dist/sw.js`, copies `manifest.webmanifest`).

- [ ] **Step 7: Manual smoke (optional, needs the backend).**
```bash
cd pwa && bun run build && cd ..
DOME_ASK_TOKEN=dev bin/dome ask-server --vault ~/vaults/work --static-dir pwa/dist --port 4664 &
# open http://127.0.0.1:4664 , enter token "dev", verify brief + recents load, ask a question, record a capture.
```

- [ ] **Step 8: Commit** — `git add pwa && git commit -m "feat(pwa): assemble app shell + manifest + service worker + styling"`

---

## Task 12: docs + full-suite verify

- [ ] **Step 1: Doc note.** In `docs/cohesive/brainstorms/2026-06-16-hosted-agent-and-mobile-client.md`, mark the PWA client SHIPPED: React app in `pwa/`, served via `dome ask-server --static-dir pwa/dist`; voice-capture + text-chat + brief + recents; the remaining mobile-arc piece is the always-on home server.
- [ ] **Step 2: SDK suite untouched.** Run (repo root): `bun test tests/ 2>&1 | tail -3` — the SDK suite passes and discovers NO `pwa/` tests. Run `cd pwa && bun test 2>&1 | tail -3` — the PWA suite passes.
- [ ] **Step 3: Typecheck both.** `bunx tsc --noEmit` (root, SDK) and `cd pwa && bun run typecheck` — both clean.
- [ ] **Step 4: Commit** — `git add docs && git commit -m "docs: PWA client shipped — ask-server + React app is the phone surface"`

---

## Self-Review

**Spec coverage** (against `2026-06-16-pwa-design.md`): apiClient (T2–4), Composer + capture state machine (T8, T10), ChatTranscript + stream reducer (T7), Brief (T6), Recents (T6), captureQueue (T9), tokenGate (T5), manifest+SW (T11), the single-screen layout + signal-first styling (T11), served-by-ask-server build (T1). Voice = MediaRecorder→/transcribe→review→/capture (T8/T10/T11). Deferred items (voice-for-ask/TTS, push, page viewer, native wrapper, per-device tokens) are not tasked — correct.

**Placeholder scan:** the SW is intentionally minimal (documented as v1 passthrough; offline resilience is the IndexedDB queue, not the SW) — that's a scope decision, not a placeholder. The styling step (T11.5) is prose-directed rather than full CSS because it's the one genuinely design-judgment step (frontend-design territory); every other step has complete code. No "TBD"/"handle errors generically".

**Type consistency:** `DomeClient` method names (`tasks/recents/capture/resolve/transcribe/ask/askStream`) consistent T3↔T4↔T11. `StreamEvent`/`Citation`/`Today`/`Recents` from T2 used verbatim downstream. `captureReducer`/`INITIAL`/`CaptureState` (T8) consumed by Composer (T10). `chatReducer`/`ChatState`/`ChatAction` (T7) consumed by ChatTranscript (T7) + App (T11). The today-view field names (`openTasks`/`followups`/`questions`/`counts`/`hero`/`dueDate`) match the shipped server shape.

**Known risk flagged for execution:** (1) the dev-dep versions (React 19 / Vite 6 / testing-library 16 / happy-dom 16 / fake-indexeddb 6) are current-stable recommendations — `bun install` resolves exact; if a major has moved, the implementer adjusts and notes it. (2) happy-dom lacks `MediaRecorder`/`getUserMedia` (Composer test exercises text + feature-detection only, not a real recording) and lacks `IndexedDB` (the queue test injects `fake-indexeddb`) — both handled in-plan. (3) The Vite SW build (T11.4) is the fiddly bit; if the dual-input rollup config misbehaves, fall back to a plain copied `public/sw.js` (no bundling) and note it.
