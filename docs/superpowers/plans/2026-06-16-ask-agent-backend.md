# Ask-Agent Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the "ask my brain" agent backend — a companion HTTP service that runs a tool-calling model loop over Dome's existing read collectors and returns a synthesized, source-backed answer. This is the server-side agent of [[cohesive/brainstorms/2026-06-16-hosted-agent-and-mobile-client]] Architecture A (step 2).

**Architecture:** A new companion entrypoint `src/agent/` (peer of `src/mcp/` and `src/http/`), reached only via dynamic import from a new `dome ask-server` CLI verb — keeping it out of the core static import graph per `ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY`. The service is a **client of the contract**: it opens the vault via `openVault`, exposes read collectors (`query`, `export-context`, `today`, `readDocument`) as tools, runs a provider-neutral tool loop against the vault's configured model provider (obtained via `buildCommandModelStepProvider` — pure subprocess, no LLM SDK), and returns `{answer, citations}`. Synthesis lives in this backend, not in Dome — consistent with [[wiki/concepts/client-model]] ("evidence lives in Dome; synthesis lives in the client"). The CLI verb only *runs the server*, like `dome http`/`dome mcp`; there is no human-facing `dome ask` synthesis command.

**Tech Stack:** TypeScript on Bun. `Bun.serve` for HTTP. Existing seams: `src/surface/adapter.ts` (`withVault`, `makeVaultMutex`), `src/vault.ts` (`openVault`, `Vault.runView`, `Vault.readDocument`), `src/engine/host/command-model-provider.ts` (`buildCommandModelStepProvider`), `src/engine/core/capability-policy.ts` (`loadCapabilityPolicy`), `src/engine/core/model-invoke.ts` (`ModelStepProvider`, `ModelStepResponse`, `ModelMessage`, `ModelToolSchema`, `ModelToolCall` types).

**Scope boundary:** This plan builds the backend only. The PWA shell, voice capture, recents panel, per-device tokens, and home-server deployment are a separate follow-on plan. v1 phone scope is capture+ask+read (no phone authoring), so this backend exposes **read-only** tools.

---

## File Structure

- `src/agent/types.ts` — shared types (`AskTool`, `AskState`, `AskResult`, `AskCitation`).
- `src/agent/tools.ts` — read-only tool definitions wrapping `Vault` collectors; each accumulates citations into `AskState`.
- `src/agent/loop.ts` — provider-neutral tool-calling loop (`runAskLoop`), adapted from the `dome.agent` harness (which lives in `assets/` and isn't importable from `src/`).
- `src/agent/ask.ts` — `runAsk({vault, step, question, model?, maxSteps?})` → `AskResult`; the orchestration that wires tools + loop + citation extraction.
- `src/agent/provider.ts` — `getModelStepProvider(vaultPath)` → `{ step, model? }` via `loadCapabilityPolicy` + `buildCommandModelStepProvider`.
- `src/agent/server.ts` — `createAskServer({vaultPath, bundlesRoot, token, model?, maxBodyBytes?, askImpl?})` → `{ fetch }`; `POST /ask`.
- `src/cli/commands/ask-server.ts` — `runAskServer(opts)`; mirrors `src/cli/commands/http.ts`.
- `src/cli/index.ts` — register the `ask-server` command (dynamic import).
- Tests: `tests/agent/tools.test.ts`, `tests/agent/loop.test.ts`, `tests/agent/ask.test.ts`, `tests/agent/server.test.ts`.

**Reference files to read before starting** (for exact types/patterns):
- `src/engine/core/model-invoke.ts` — `ModelStepProvider`, `ModelStepResponse`, `ModelMessage`, `ModelToolSchema`, `ModelToolCall`.
- `src/surface/adapter.ts` — `withVault`, `makeVaultMutex`, `openVaultErrorKind`.
- `src/http/server.ts` — the route/auth/jsonBody/response-helper patterns to mirror.
- `src/cli/commands/http.ts` + `src/cli/index.ts` (the `http` command block) — the CLI wiring to mirror.
- `assets/extensions/dome.agent/lib/agent-loop.ts` — the loop to adapt (do NOT import it from `src/`).
- `tests/extensions/dome.agent/ingest.test.ts` (the `makeCtx` mock) — the model-step mock style to reuse.

---

## Task 1: Shared types

**Files:**
- Create: `src/agent/types.ts`

- [ ] **Step 1: Write the types**

```typescript
// src/agent/types.ts
//
// Types for the ask-agent backend (companion entrypoint). Kept LLM-SDK-free:
// the model loop talks to the vault's configured command model provider via
// the ModelStepProvider seam, which is pure subprocess + fetch.

import type {
  ModelStepProvider,
  ModelToolSchema,
} from "../engine/core/model-invoke";

/** A source the answer rests on — surfaced by a read tool during the run. */
export type AskCitation = {
  readonly path: string;
  readonly commit?: string | undefined;
  readonly snippet?: string | undefined;
};

/** Mutable run state threaded through tool executions. */
export type AskState = {
  readonly citations: AskCitation[];
};

/** A read-only tool the ask agent can call. */
export type AskTool = {
  readonly schema: ModelToolSchema;
  readonly execute: (input: unknown, state: AskState) => Promise<string>;
};

/** The synthesized answer plus the evidence it cited. */
export type AskResult = {
  readonly answer: string;
  readonly citations: ReadonlyArray<AskCitation>;
  readonly steps: number;
  readonly stopReason: "final" | "budget";
};

export type { ModelStepProvider };
```

- [ ] **Step 2: Typecheck**

Run: `cd <worktree> && bunx tsc --noEmit 2>&1 | grep -i "src/agent/types" || echo "types clean"`
Expected: `types clean` (no errors referencing the new file). Confirm `ModelToolSchema` and `ModelStepProvider` are the real exported names in `src/engine/core/model-invoke.ts`; if a name differs, use the actual export.

- [ ] **Step 3: Commit**

```bash
git add src/agent/types.ts
git commit -m "feat(agent): ask-backend shared types"
```

---

## Task 2: Read-only tools over the Vault collectors

Tools wrap `vault.runView(...)` and `vault.readDocument(...)`. Each tool returns a compact text payload for the model AND pushes the sources it surfaced into `state.citations`, so the final answer is source-backed by construction.

**Files:**
- Create: `src/agent/tools.ts`
- Test: `tests/agent/tools.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/agent/tools.test.ts
import { describe, expect, test } from "bun:test";
import { buildAskTools } from "../../src/agent/tools";
import type { AskState } from "../../src/agent/types";

// Minimal fake Vault exposing only what the tools use.
function fakeVault(over: Partial<{ runView: unknown; readDocument: unknown }> = {}) {
  return {
    runView:
      over.runView ??
      (async (_cmd: string, _args: unknown) => ({
        kind: "ok",
        data: {
          matches: [
            {
              title: "Robinhood Chain",
              path: "wiki/entities/robinhood-chain.md",
              snippet: "launches ~early July 2026",
              sourceRef: { path: "wiki/entities/robinhood-chain.md", commit: "abc123" },
            },
          ],
        },
      })),
    readDocument:
      over.readDocument ??
      (async (path: string) => ({ path, commit: "abc123", content: "# Hello" })),
  } as never;
}

describe("buildAskTools", () => {
  test("query tool returns matches and records citations", async () => {
    const tools = buildAskTools(fakeVault());
    const query = tools.find((t) => t.schema.name === "search_vault");
    expect(query).toBeDefined();
    const state: AskState = { citations: [] };
    const out = await query!.execute({ text: "robinhood" }, state);
    expect(out).toContain("wiki/entities/robinhood-chain.md");
    expect(state.citations).toHaveLength(1);
    expect(state.citations[0]?.path).toBe("wiki/entities/robinhood-chain.md");
  });

  test("read_document tool returns content and records a citation", async () => {
    const tools = buildAskTools(fakeVault());
    const read = tools.find((t) => t.schema.name === "read_document");
    const state: AskState = { citations: [] };
    const out = await read!.execute({ path: "wiki/x.md" }, state);
    expect(out).toContain("# Hello");
    expect(state.citations.map((c) => c.path)).toContain("wiki/x.md");
  });

  test("read_document on a missing path returns a not-found message, no citation", async () => {
    const tools = buildAskTools(fakeVault({ readDocument: async () => null }));
    const read = tools.find((t) => t.schema.name === "read_document");
    const state: AskState = { citations: [] };
    const out = await read!.execute({ path: "missing.md" }, state);
    expect(out.toLowerCase()).toContain("not found");
    expect(state.citations).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd <worktree> && bun test tests/agent/tools.test.ts`
Expected: FAIL — `buildAskTools` not found.

- [ ] **Step 3: Implement the tools**

```typescript
// src/agent/tools.ts
import type { Vault } from "../vault";
import type { AskTool, AskState, AskCitation } from "./types";

function recordCitation(state: AskState, c: AskCitation): void {
  if (!state.citations.some((x) => x.path === c.path)) {
    state.citations.push(c);
  }
}

// Pull a {path, commit, snippet} from a view "match" row defensively — the
// query/today views attach a `sourceRef` (see src/surface view shapes).
function citationFromMatch(m: Record<string, unknown>): AskCitation | null {
  const ref = m["sourceRef"] as { path?: unknown; commit?: unknown } | undefined;
  const path = typeof ref?.path === "string" ? ref.path : typeof m["path"] === "string" ? (m["path"] as string) : null;
  if (path === null) return null;
  return {
    path,
    commit: typeof ref?.commit === "string" ? ref.commit : undefined,
    snippet: typeof m["snippet"] === "string" ? (m["snippet"] as string) : undefined,
  };
}

async function runViewMatches(
  vault: Vault,
  command: string,
  args: Record<string, unknown>,
  state: AskState,
): Promise<string> {
  const result = (await vault.runView(command, args)) as {
    kind: string;
    data?: { matches?: ReadonlyArray<Record<string, unknown>> };
  };
  if (result.kind !== "ok") {
    return `error: ${command} view unavailable (${result.kind}).`;
  }
  const matches = result.data?.matches ?? [];
  if (matches.length === 0) return `no results for ${command}.`;
  const lines: string[] = [];
  for (const m of matches) {
    const cite = citationFromMatch(m);
    if (cite !== null) recordCitation(state, cite);
    const title = typeof m["title"] === "string" ? m["title"] : "(untitled)";
    const path = cite?.path ?? "(no path)";
    const snippet = typeof m["snippet"] === "string" ? m["snippet"] : "";
    lines.push(`- ${title} [${path}]${snippet ? `: ${snippet}` : ""}`);
  }
  return lines.join("\n");
}

export function buildAskTools(vault: Vault): ReadonlyArray<AskTool> {
  return [
    {
      schema: {
        name: "search_vault",
        description:
          "Full-text + fact search over the adopted vault. Returns ranked matches with their source paths. Use this first to find relevant pages.",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string", description: "The search query." },
            limit: { type: "number", description: "Max matches (default 8)." },
          },
          required: ["text"],
          additionalProperties: false,
        },
      },
      execute: async (input, state) => {
        const text = typeof (input as Record<string, unknown>)?.["text"] === "string" ? (input as Record<string, string>)["text"] : "";
        if (text.trim().length === 0) return "error: search_vault requires non-empty `text`.";
        const limit = typeof (input as Record<string, unknown>)?.["limit"] === "number" ? (input as Record<string, number>)["limit"] : 8;
        return runViewMatches(vault, "query", { text, limit }, state);
      },
    },
    {
      schema: {
        name: "read_document",
        description:
          "Read the full markdown of a vault page by path (as returned by search_vault). Use to get detail before answering.",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string", description: "Vault-relative path, e.g. wiki/entities/x.md." } },
          required: ["path"],
          additionalProperties: false,
        },
      },
      execute: async (input, state) => {
        const path = typeof (input as Record<string, unknown>)?.["path"] === "string" ? (input as Record<string, string>)["path"] : "";
        if (path.trim().length === 0) return "error: read_document requires `path`.";
        const doc = await vault.readDocument(path);
        if (doc === null) return `not found: no adopted document at '${path}'.`;
        recordCitation(state, { path: doc.path, commit: doc.commit });
        return doc.content;
      },
    },
    {
      schema: {
        name: "todays_brief",
        description:
          "The owner's brief for today: open tasks, follow-ups, and questions. Use when the question is about 'today', 'now', or what's open.",
        inputSchema: {
          type: "object",
          properties: { date: { type: "string", description: "ISO date; defaults to today." } },
          additionalProperties: false,
        },
      },
      execute: async (input, state) => {
        const date = typeof (input as Record<string, unknown>)?.["date"] === "string" ? (input as Record<string, string>)["date"] : undefined;
        return runViewMatches(vault, "today", date !== undefined ? { date } : {}, state);
      },
    },
  ];
}
```

> NOTE for the implementer: confirm the `query`/`today` view result shape against `src/surface/view-catalog.ts` / the `dome.search.query/v1` doc. If matches live under a different key than `data.matches` or the per-match source field is named differently than `sourceRef`, adjust `runViewMatches`/`citationFromMatch` accordingly — keep the tests green by updating the fake to match the real shape first, then the code.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd <worktree> && bun test tests/agent/tools.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools.ts tests/agent/tools.test.ts
git commit -m "feat(agent): read-only vault tools for the ask backend"
```

---

## Task 3: The provider-neutral tool loop

A minimal adaptation of `assets/extensions/dome.agent/lib/agent-loop.ts` (which can't be imported from `src/`). Read-only — no edits/questions state.

**Files:**
- Create: `src/agent/loop.ts`
- Test: `tests/agent/loop.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/agent/loop.test.ts
import { describe, expect, test } from "bun:test";
import { runAskLoop } from "../../src/agent/loop";
import type { AskTool, AskState } from "../../src/agent/types";

function tool(name: string, fn: (input: unknown, s: AskState) => Promise<string>): AskTool {
  return { schema: { name, description: name, inputSchema: { type: "object", properties: {}, additionalProperties: true } }, execute: fn };
}

describe("runAskLoop", () => {
  test("executes a tool call then returns the final text", async () => {
    const calls: string[] = [];
    const tools = [tool("search_vault", async () => { calls.push("search"); return "found X [wiki/x.md]"; })];
    const steps = [
      { toolCalls: [{ id: "1", name: "search_vault", input: { text: "x" } }] },
      { text: "X is the answer." },
    ];
    let i = 0;
    const step = async () => steps[i++]!;
    const state: AskState = { citations: [] };
    const result = await runAskLoop({ charter: "c", question: "what is X?", tools, step, maxSteps: 5, state });
    expect(calls).toEqual(["search"]);
    expect(result.stopReason).toBe("final");
    expect(result.finalText).toBe("X is the answer.");
  });

  test("stops at maxSteps with budget stopReason", async () => {
    const tools = [tool("loop", async () => "again")];
    const step = async () => ({ toolCalls: [{ id: "1", name: "loop", input: {} }] });
    const result = await runAskLoop({ charter: "c", question: "q", tools, step, maxSteps: 3, state: { citations: [] } });
    expect(result.stopReason).toBe("budget");
    expect(result.steps).toBe(3);
  });

  test("unknown tool yields an error observation, loop continues", async () => {
    const tools = [tool("known", async () => "ok")];
    const steps = [
      { toolCalls: [{ id: "1", name: "nope", input: {} }] },
      { text: "done" },
    ];
    let i = 0;
    const result = await runAskLoop({ charter: "c", question: "q", tools, step: async () => steps[i++]!, maxSteps: 5, state: { citations: [] } });
    expect(result.finalText).toBe("done");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd <worktree> && bun test tests/agent/loop.test.ts`
Expected: FAIL — `runAskLoop` not found.

- [ ] **Step 3: Implement the loop**

```typescript
// src/agent/loop.ts
import type { ModelMessage, ModelStepProvider } from "../engine/core/model-invoke";
import type { AskTool, AskState } from "./types";

export type AskLoopResult = {
  readonly finalText: string | null;
  readonly stopReason: "final" | "budget";
  readonly steps: number;
};

// `step` accepts the same request shape as ModelStepProvider minus the signal,
// so tests can pass a trivial async fn. The server passes a bound provider.
export type AskStepFn = (req: {
  readonly messages: ReadonlyArray<ModelMessage>;
  readonly tools: ReadonlyArray<AskTool["schema"]>;
}) => Promise<{ readonly toolCalls?: ReadonlyArray<{ id: string; name: string; input: unknown }>; readonly text?: string }>;

export async function runAskLoop(opts: {
  readonly charter: string;
  readonly question: string;
  readonly tools: ReadonlyArray<AskTool>;
  readonly step: AskStepFn;
  readonly maxSteps: number;
  readonly state: AskState;
}): Promise<AskLoopResult> {
  const messages: ModelMessage[] = [
    { role: "system", content: opts.charter },
    { role: "user", content: opts.question },
  ];
  const schemas = opts.tools.map((t) => t.schema);
  const byName = new Map(opts.tools.map((t) => [t.schema.name, t] as const));

  let steps = 0;
  while (steps < opts.maxSteps) {
    steps += 1;
    const resp = await opts.step({ messages, tools: schemas });
    const calls = resp.toolCalls ?? [];
    if (calls.length === 0) {
      return { finalText: resp.text ?? null, stopReason: "final", steps };
    }
    messages.push({ role: "assistant", content: resp.text ?? "", toolCalls: calls });
    for (const call of calls) {
      const tool = byName.get(call.name);
      const content =
        tool === undefined
          ? `error: unknown tool "${call.name}"`
          : await tool.execute(call.input, opts.state);
      messages.push({ role: "tool", toolCallId: call.id, toolName: call.name, content });
    }
  }
  return { finalText: null, stopReason: "budget", steps };
}
```

> NOTE: confirm `ModelMessage` has the fields `role`, `content`, `toolCalls`, `toolCallId`, `toolName` (see `src/engine/core/model-invoke.ts` and the `dome.agent` loop usage). Match the real field names exactly.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd <worktree> && bun test tests/agent/loop.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/loop.ts tests/agent/loop.test.ts
git commit -m "feat(agent): provider-neutral read-only tool loop"
```

---

## Task 4: `runAsk` orchestration

Wires tools + loop + a charter, and shapes the `AskResult`. Falls back to a graceful answer when the loop hits budget without a final text.

**Files:**
- Create: `src/agent/ask.ts`
- Test: `tests/agent/ask.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/agent/ask.test.ts
import { describe, expect, test } from "bun:test";
import { runAsk } from "../../src/agent/ask";

function fakeVault() {
  return {
    runView: async () => ({
      kind: "ok",
      data: { matches: [{ title: "RH", path: "wiki/entities/robinhood-chain.md", snippet: "July 2026", sourceRef: { path: "wiki/entities/robinhood-chain.md", commit: "c1" } }] },
    }),
    readDocument: async (p: string) => ({ path: p, commit: "c1", content: "Robinhood Chain launches July 2026." }),
  } as never;
}

describe("runAsk", () => {
  test("returns a synthesized answer with citations gathered from tools", async () => {
    const steps = [
      { toolCalls: [{ id: "1", name: "search_vault", input: { text: "robinhood launch" } }] },
      { toolCalls: [{ id: "2", name: "read_document", input: { path: "wiki/entities/robinhood-chain.md" } }] },
      { text: "Robinhood Chain launches in early July 2026." },
    ];
    let i = 0;
    const result = await runAsk({
      vault: fakeVault(),
      step: async () => steps[i++]!,
      question: "When does Robinhood Chain launch?",
      maxSteps: 6,
    });
    expect(result.answer).toContain("July 2026");
    expect(result.citations.map((c) => c.path)).toContain("wiki/entities/robinhood-chain.md");
    expect(result.stopReason).toBe("final");
  });

  test("budget exhaustion yields a graceful answer, not null", async () => {
    const result = await runAsk({
      vault: fakeVault(),
      step: async () => ({ toolCalls: [{ id: "1", name: "search_vault", input: { text: "x" } }] }),
      question: "q",
      maxSteps: 2,
    });
    expect(typeof result.answer).toBe("string");
    expect(result.answer.length).toBeGreaterThan(0);
    expect(result.stopReason).toBe("budget");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd <worktree> && bun test tests/agent/ask.test.ts`
Expected: FAIL — `runAsk` not found.

- [ ] **Step 3: Implement `runAsk`**

```typescript
// src/agent/ask.ts
import type { Vault } from "../vault";
import { buildAskTools } from "./tools";
import { runAskLoop, type AskStepFn } from "./loop";
import type { AskResult, AskState } from "./types";

const ASK_CHARTER = [
  "You are the owner's second-brain assistant. Answer the owner's question using ONLY their vault.",
  "Always call search_vault first to find relevant pages, then read_document for detail before answering.",
  "Ground every claim in the vault. If the vault does not contain the answer, say so plainly — never invent.",
  "Cite the pages you used inline as [path]. Be concise and direct; lead with the answer.",
].join(" ");

export async function runAsk(opts: {
  readonly vault: Vault;
  readonly step: AskStepFn;
  readonly question: string;
  readonly model?: string | undefined;
  readonly maxSteps?: number | undefined;
}): Promise<AskResult> {
  const tools = buildAskTools(opts.vault);
  const state: AskState = { citations: [] };
  const loop = await runAskLoop({
    charter: ASK_CHARTER,
    question: opts.question,
    tools,
    step: opts.step,
    maxSteps: opts.maxSteps ?? 8,
    state,
  });
  const answer =
    loop.finalText ??
    "I couldn't reach a complete answer within the step budget. Here's what I found: " +
      (state.citations.length > 0
        ? state.citations.map((c) => c.path).join(", ")
        : "no relevant vault pages.");
  return { answer, citations: state.citations, steps: loop.steps, stopReason: loop.stopReason };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd <worktree> && bun test tests/agent/ask.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/ask.ts tests/agent/ask.test.ts
git commit -m "feat(agent): runAsk orchestration (tools + loop + citations)"
```

---

## Task 5: Model step provider from vault config

Adapts the vault's configured command model provider to the loop's `AskStepFn`. Pure subprocess via `buildCommandModelStepProvider`.

**Files:**
- Create: `src/agent/provider.ts`
- Test: `tests/agent/provider.test.ts`

- [ ] **Step 1: Write the failing test**

This test verifies the adapter wiring (it constructs a provider and that the returned step forwards a signal + returns text), using a fake `ModelStepProvider` rather than a real subprocess.

```typescript
// tests/agent/provider.test.ts
import { describe, expect, test } from "bun:test";
import { askStepFromProvider } from "../../src/agent/provider";

describe("askStepFromProvider", () => {
  test("adapts a ModelStepProvider into an AskStepFn (forwards messages/tools, returns text+toolCalls)", async () => {
    const fakeProvider = async (req: { messages: unknown; tools: unknown; signal: AbortSignal; model?: string }) => {
      expect(req.signal).toBeInstanceOf(AbortSignal);
      return { text: "hi", toolCalls: [{ id: "1", name: "search_vault", input: { text: "x" } }] };
    };
    const step = askStepFromProvider(fakeProvider as never, { model: "claude-opus-4-1", signal: new AbortController().signal });
    const out = await step({ messages: [{ role: "user", content: "q" }] as never, tools: [] });
    expect(out.text).toBe("hi");
    expect(out.toolCalls?.[0]?.name).toBe("search_vault");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd <worktree> && bun test tests/agent/provider.test.ts`
Expected: FAIL — `askStepFromProvider` not found.

- [ ] **Step 3: Implement the provider adapter + loader**

```typescript
// src/agent/provider.ts
import { loadCapabilityPolicy } from "../engine/core/capability-policy";
import { buildCommandModelStepProvider } from "../engine/host/command-model-provider";
import type { ModelStepProvider } from "../engine/core/model-invoke";
import type { AskStepFn } from "./loop";

/** Wrap a ModelStepProvider into the loop's AskStepFn, binding model + signal. */
export function askStepFromProvider(
  provider: ModelStepProvider,
  opts: { readonly model?: string | undefined; readonly signal: AbortSignal },
): AskStepFn {
  return async ({ messages, tools }) => {
    const resp = await provider({
      messages,
      tools,
      signal: opts.signal,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
    });
    return {
      ...(resp.text !== undefined ? { text: resp.text } : {}),
      ...(resp.toolCalls !== undefined ? { toolCalls: resp.toolCalls } : {}),
    };
  };
}

export type AskProvider = {
  readonly provider: ModelStepProvider;
};

/** Build the step provider from the vault's configured command model provider. */
export async function getModelStepProvider(
  vaultPath: string,
): Promise<{ kind: "ok"; provider: ModelStepProvider } | { kind: "no-provider" } | { kind: "error"; message: string }> {
  const policy = await loadCapabilityPolicy(vaultPath);
  if (!policy.ok) return { kind: "error", message: policy.error };
  const cfg = policy.value.runtime.modelProvider;
  if (cfg === undefined) return { kind: "no-provider" };
  const provider = buildCommandModelStepProvider(cfg, { cwd: vaultPath });
  return { kind: "ok", provider };
}
```

> NOTE: confirm against `src/engine/core/capability-policy.ts` that `loadCapabilityPolicy` returns a `Result` (`.ok`/`.value`/`.error`) and that the provider config is at `policy.value.runtime.modelProvider`. Confirm `buildCommandModelStepProvider(config, { cwd })` signature in `src/engine/host/command-model-provider.ts`. Adjust field access to the real shapes.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd <worktree> && bun test tests/agent/provider.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/agent/provider.ts tests/agent/provider.test.ts
git commit -m "feat(agent): model step provider from vault config (no LLM SDK)"
```

---

## Task 6: The ask HTTP server

`POST /ask {question}` → `{ answer, citations }`. Bearer auth + mutex + JSON body bounds, mirroring `src/http/server.ts`. Takes an injectable `askImpl` for testing without a model.

**Files:**
- Create: `src/agent/server.ts`
- Test: `tests/agent/server.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/agent/server.test.ts
import { describe, expect, test } from "bun:test";
import { createAskServer } from "../../src/agent/server";

const TOKEN = "test-token";

function server() {
  // Inject a fake askImpl so no vault/model is needed.
  return createAskServer({
    vaultPath: "/tmp/unused",
    token: TOKEN,
    askImpl: async (question: string) => ({
      answer: `answer to: ${question}`,
      citations: [{ path: "wiki/x.md", commit: "c1" }],
      steps: 2,
      stopReason: "final" as const,
    }),
  });
}

function post(body: unknown, token = TOKEN): Request {
  return new Request("http://localhost/ask", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("createAskServer", () => {
  test("POST /ask returns a synthesized answer + citations", async () => {
    const res = await server().fetch(post({ question: "what's open?" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { answer: string; citations: unknown[] };
    expect(json.answer).toContain("what's open?");
    expect(json.citations).toHaveLength(1);
  });

  test("401 without a valid bearer token", async () => {
    const res = await server().fetch(post({ question: "x" }, "wrong"));
    expect(res.status).toBe(401);
  });

  test("400 on empty question", async () => {
    const res = await server().fetch(post({ question: "  " }));
    expect(res.status).toBe(400);
  });

  test("404 on an unknown route", async () => {
    const res = await server().fetch(
      new Request("http://localhost/nope", { headers: { authorization: `Bearer ${TOKEN}` } }),
    );
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd <worktree> && bun test tests/agent/server.test.ts`
Expected: FAIL — `createAskServer` not found.

- [ ] **Step 3: Implement the server**

```typescript
// src/agent/server.ts
import { createHash, timingSafeEqual } from "node:crypto";
import { withVault, makeVaultMutex, openVaultErrorKind } from "../surface/adapter";
import { runAsk } from "./ask";
import { askStepFromProvider, getModelStepProvider } from "./provider";
import type { AskResult } from "./types";

const SCHEMA = "dome.ask/v1";

export type AskImpl = (question: string) => Promise<AskResult>;

export type CreateAskServerOptions = {
  readonly vaultPath: string;
  readonly bundlesRoot?: string | undefined;
  readonly token: string;
  readonly model?: string | undefined;
  readonly maxBodyBytes?: number | undefined;
  /** Test seam: bypass vault+model and answer directly. */
  readonly askImpl?: AskImpl | undefined;
};

export type AskServer = { readonly fetch: (request: Request) => Promise<Response> };

function sha256(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}
function json(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}
function authorized(request: Request, digest: Buffer): boolean {
  const header = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (m?.[1] === undefined) return false;
  const got = sha256(m[1]);
  return got.length === digest.length && timingSafeEqual(got, digest);
}

export function createAskServer(opts: CreateAskServerOptions): AskServer {
  if (opts.token.trim().length === 0) throw new Error("createAskServer: token must be non-empty");
  const digest = sha256(opts.token);
  const maxBodyBytes = opts.maxBodyBytes ?? 1024 * 1024;
  const enqueue = makeVaultMutex();

  // Default ask: open vault, build the real model provider, run the loop.
  const defaultAsk: AskImpl = async (question) => {
    const prov = await getModelStepProvider(opts.vaultPath);
    if (prov.kind !== "ok") {
      throw new Error(prov.kind === "no-provider" ? "no model provider configured in .dome/config.yaml" : prov.message);
    }
    const controller = new AbortController();
    const step = askStepFromProvider(prov.provider, { model: opts.model, signal: controller.signal });
    const outcome = await withVault({ path: opts.vaultPath, bundlesRoot: opts.bundlesRoot }, (vault) =>
      runAsk({ vault, step, question, model: opts.model }),
    );
    if (outcome.kind === "open-failed") {
      throw new Error(`vault open failed: ${openVaultErrorKind(outcome.error)}`);
    }
    return outcome.value;
  };
  const ask = opts.askImpl ?? defaultAsk;

  const routes = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    if (route === "GET /") return json(200, { schema: "dome.ask-server/v1", server: "dome-ask" });
    if (route === "POST /ask") {
      const declared = Number(request.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBodyBytes) return json(413, { schema: SCHEMA, status: "error", error: "payload-too-large" });
      let body: { question?: unknown } | null = null;
      try {
        body = (await request.json()) as { question?: unknown };
      } catch {
        return json(400, { schema: SCHEMA, status: "error", error: "invalid-json" });
      }
      const question = typeof body?.question === "string" ? body.question.trim() : "";
      if (question.length === 0) return json(400, { schema: SCHEMA, status: "error", error: "ask-usage", message: "POST /ask requires a non-empty `question`." });
      try {
        const result = await ask(question);
        return json(200, { schema: SCHEMA, status: "ok", answer: result.answer, citations: result.citations, steps: result.steps, stopReason: result.stopReason });
      } catch (e) {
        return json(500, { schema: SCHEMA, status: "error", error: "ask-failed", message: e instanceof Error ? e.message : String(e) });
      }
    }
    return json(404, { schema: SCHEMA, status: "error", error: "not-found", message: `no route for ${route}.` });
  };

  return {
    fetch: async (request) => {
      if (!authorized(request, digest)) return json(401, { schema: SCHEMA, status: "error", error: "unauthorized" });
      return enqueue(() => routes(request));
    },
  };
}
```

> NOTE: confirm `withVault`, `makeVaultMutex`, `openVaultErrorKind` signatures in `src/surface/adapter.ts` (the recon shows `withVault({path, bundlesRoot}, fn)` returning `{kind:"ok",value}|{kind:"open-failed",error}`). Match the real `makeVaultMutex` usage (the http server wraps route dispatch in `enqueue(() => routes(request))`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd <worktree> && bun test tests/agent/server.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/server.ts tests/agent/server.test.ts
git commit -m "feat(agent): POST /ask HTTP server (bearer auth, injectable ask)"
```

---

## Task 7: The `dome ask-server` CLI verb

**Files:**
- Create: `src/cli/commands/ask-server.ts`
- Modify: `src/cli/index.ts` (register the command; add the options type)

- [ ] **Step 1: Implement the command runner**

Read `src/cli/commands/http.ts` first and mirror it exactly (vault resolution, git-root + `.dome/config.yaml` check, token-from-flag-or-env, port validation, `Bun.serve`, SIGINT/SIGTERM + `signal` shutdown, `onReady`). Then:

```typescript
// src/cli/commands/ask-server.ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { findGitRoot } from "../../git";
import { resolveVaultPath } from "../../surface/resolve-vault";
import { createAskServer } from "../../agent/server";
import { EX_USAGE } from "../exit-codes";

export type RunAskServerOptions = {
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly port?: string | number | undefined;
  readonly host?: string | undefined;
  readonly token?: string | undefined;
  readonly model?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onReady?: ((server: { hostname: string; port: number }) => void) | undefined;
};

export async function runAskServer(options: RunAskServerOptions = {}): Promise<number> {
  const vaultPath = resolveVaultPath(options.vault);
  const gitRoot = await findGitRoot(vaultPath);
  if (gitRoot === null || !existsSync(join(vaultPath, ".dome", "config.yaml"))) {
    console.error("dome ask-server: not an initialized Dome vault; run `dome init` first.");
    return EX_USAGE;
  }
  const token = options.token ?? process.env["DOME_ASK_TOKEN"] ?? "";
  if (token.trim().length === 0) {
    console.error("dome ask-server: a bearer token is required — pass --token <value> or set DOME_ASK_TOKEN.");
    return EX_USAGE;
  }
  const port = options.port === undefined ? 4664 : Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error("dome ask-server: --port must be an integer in [0, 65535].");
    return EX_USAGE;
  }
  const handler = createAskServer({
    vaultPath,
    ...(options.bundlesRoot !== undefined ? { bundlesRoot: options.bundlesRoot } : {}),
    token,
    ...(options.model !== undefined ? { model: options.model } : {}),
  });
  const server = Bun.serve({ hostname: options.host ?? "127.0.0.1", port, fetch: handler.fetch });
  console.error(`dome ask-server: listening on http://${server.hostname}:${server.port}`);
  options.onReady?.({ hostname: server.hostname ?? "", port: server.port ?? 0 });
  await new Promise<void>((done) => {
    const finish = (): void => {
      process.removeListener("SIGINT", finish);
      process.removeListener("SIGTERM", finish);
      done();
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
    if (options.signal !== undefined) {
      if (options.signal.aborted) finish();
      else options.signal.addEventListener("abort", finish, { once: true });
    }
  });
  server.stop(true);
  return 0;
}
```

- [ ] **Step 2: Register the command in `src/cli/index.ts`**

Find the `program.command("http")` block and add an analogous block immediately after it:

```typescript
program
  .command("ask-server")
  .description("Run the ask-my-brain agent backend over this vault (bearer-token auth; loopback by default).")
  .option("--vault <path>", "Vault path (defaults to current directory).")
  .option("--bundles-root <path>", "Extension bundles root.")
  .option("--port <port>", "Port to listen on (default 4664).")
  .option("--host <host>", "Interface to bind (default 127.0.0.1).")
  .option("--token <token>", "Bearer token (or set DOME_ASK_TOKEN).")
  .option("--model <model>", "Model id override (else the provider default).")
  .action(async (options: AskServerCliOptions) => {
    // Dynamic import keeps the agent backend out of the CLI static graph,
    // matching the `dome mcp` / `dome http` companion-entrypoint discipline.
    const { runAskServer } = await import("./commands/ask-server");
    setExitCode(
      await runAskServer({
        vault: options.vault,
        bundlesRoot: options.bundlesRoot,
        port: options.port,
        host: options.host,
        token: options.token,
        model: options.model,
      }),
    );
  });
```

And add the options type alongside `HttpCliOptions`:

```typescript
type AskServerCliOptions = {
  readonly vault?: string;
  readonly bundlesRoot?: string;
  readonly port?: string;
  readonly host?: string;
  readonly token?: string;
  readonly model?: string;
};
```

- [ ] **Step 3: Verify the command is registered**

Run: `cd <worktree> && bin/dome ask-server --help 2>&1 | head -5`
Expected: shows the `ask-server` usage with the options above.

- [ ] **Step 4: Verify the no-LLM-in-core fence still passes**

Run: `cd <worktree> && bun test tests/integration/bundle-deps.test.ts tests/integration/public-surface-shape.test.ts`
Expected: PASS — `src/agent/` is reached only via dynamic import, so the core static graph is unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/ask-server.ts src/cli/index.ts
git commit -m "feat(cli): dome ask-server command (companion entrypoint)"
```

---

## Task 8: Full-suite check + integration smoke

**Files:** none (verification + a short doc note).
- Modify: `docs/cohesive/brainstorms/2026-06-16-hosted-agent-and-mobile-client.md` (mark step 2 in-progress)

- [ ] **Step 1: Run the full agent test folder**

Run: `cd <worktree> && bun test tests/agent`
Expected: PASS — all of tools/loop/ask/provider/server.

- [ ] **Step 2: Run the full suite to catch regressions**

Run: `cd <worktree> && bun test 2>&1 | tail -15`
Expected: the suite passes (same baseline as `main`; no new failures). If the `bundle-deps` or import-direction fences fail, the agent module leaked into the static graph — fix the import path / ensure only dynamic import reaches `src/agent/`.

- [ ] **Step 3: Manual smoke (optional, needs a real vault + model provider)**

```bash
DOME_ASK_TOKEN=dev bin/dome ask-server --vault ~/vaults/work --port 4664 &
curl -s -X POST http://127.0.0.1:4664/ask -H 'authorization: Bearer dev' -H 'content-type: application/json' \
  -d '{"question":"What did I decide about Robinhood Chain?"}' | jq .
kill %1
```
Expected: a JSON `{ answer, citations: [...] }` grounded in the work vault. (This spends real model tokens — optional.)

- [ ] **Step 4: Note progress in the architecture doc**

Add under §Sequencing item 2: `> Backend in progress: src/agent/ companion + dome ask-server, POST /ask returns {answer, citations}. PWA/voice/recents follow.`

- [ ] **Step 5: Commit**

```bash
git add docs/cohesive/brainstorms/2026-06-16-hosted-agent-and-mobile-client.md
git commit -m "docs: mark ask-backend (architecture step 2) in progress"
```

---

## Self-Review

**Spec coverage:** The architecture doc's step 2 is "Agent backend on the host: Claude API tool runner with Dome read/search/capture as tools + a synthesis prompt; expose a small HTTP surface." Covered: tool loop (Tasks 3–4), read tools wrapping collectors (Task 2), synthesis charter (Task 4), HTTP surface (Task 6), CLI to run it (Task 7), model provider wiring (Task 5). Capture-as-a-tool is intentionally deferred (v1 phone uses the existing `POST /capture` on `dome http`; the ask backend is read+synthesize only) — noted here so it's a deliberate omission, not a gap. Voice/recents/PWA/tokens are out of scope by the plan boundary.

**Placeholder scan:** No "TBD"/"handle errors appropriately" — every code step has complete code. The three `> NOTE` callouts ask the implementer to confirm real type/field names against named files and adjust; they are verification instructions, not missing logic (the recon-derived shapes are filled in; the notes guard against drift).

**Type consistency:** `AskTool`/`AskState`/`AskCitation`/`AskResult` defined in Task 1 and used identically in Tasks 2/4/6. `AskStepFn` defined in Task 3, consumed in Tasks 4/5. `runAsk` signature in Task 4 matches its call in Task 6's `defaultAsk`. `createAskServer` options in Task 6 match the call in Task 7. Tool names (`search_vault`, `read_document`, `todays_brief`) are consistent between Task 2's definitions and the tests.

**Known risk flagged for execution:** the view-result match shape (`data.matches[].sourceRef`) and the exact `ModelMessage`/`loadCapabilityPolicy`/`withVault`/`buildCommandModelStepProvider` signatures are recon-derived; the `> NOTE`s direct the implementer to confirm-then-adjust against the real source, keeping tests green by fixing the fake first.
