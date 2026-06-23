# Write-Capable Agent — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the hosted agent `author` capability — `create_document` / `edit_document` tools that write a markdown file under the vault working tree and git-commit it (with a `Dome-Agent` trailer), surfaced to the client as `done.changes` so the brief refetches.

**Architecture:** A new `src/agent/write.ts` module owns the file-write + commit (reusing `commitSingleFileOnHead` from `src/git.ts`, exactly like `dome capture`). `buildAgentTools` provisions the two write tools **only when an `AgentWriteContext` is passed** (the gate). The agent loop threads `allowWrite` → builds that context (from `vault.path`, the model id, and a shared `changes[]` accumulator) → returns/streams `changes`. The HTTP `/agent` routes pass `allowWrite` (gated on the `author` capability), add `changes` to the buffered JSON and the streaming `done` event. The PWA stores `changes` on the assistant message, renders a subtle "✎ updated `<page>`" line, and refetches `/tasks` + `/recents` when non-empty.

**Tech Stack:** TypeScript, Bun, Vercel AI SDK (`ai` — `tool()` / `generateText` / `streamText`), `isomorphic-git` (via `src/git.ts`), React + Vite (PWA), `bun:test`.

## Global Constraints

- **Phase 1 is already merged** (`dome http` is the single server; `/agent` + `/agent/stream` exist; `src/capabilities.ts` exports `grantedCapabilities` / `has`; `author` is granted iff `allowWrite`). This plan is **purely additive** on top of it.
- **Canonical test gate is the runtime suite**, not `tsc`. Run SDK tests with `bun test ./tests` (NOT bare `bun test`, which sweeps `pwa/` without happy-dom). Run PWA tests with `cd pwa && bun test`. Full-repo `tsc --noEmit` is already red with pre-existing test-file errors — do **not** use it as a gate.
- **`PROPOSALS_ARE_THE_ONLY_WRITE_PATH` holds:** a git commit *is* the write path; the running daemon adopts it. No `submitProposal`. Agent writes are human-side commits (like `dome capture`).
- **Write confinement:** vault-relative paths only; reject absolute paths, `..` escapes, anything under `.dome/`, and non-`.md` files.
- **Commit attribution:** author identity `{ name: "dome agent", email: "dome-agent@local" }`; message `author: <verb> <path>` with a single `Dome-Agent: <model-id>` trailer. `Dome-Agent` is **NOT** added to `DOME_TRAILER_KEYS` (that set is the engine's `Dome-Run`-family; keeping `Dome-Agent` out preserves `changedBy: "human"` classification).
- **Engine has no LLM/MCP dependency:** `src/agent/*` and `src/http/server.ts` are CLI dynamic-import companions, never in `src/index.ts`'s static graph. `write.ts` imports only `node:fs`/`node:path` + `src/git.ts` (already core) — no new SDK in the core graph.
- **`no-direct-mutation-outside-boundaries` fence:** `src/agent/write.ts` calls `writeFile`/`mkdir`, so it MUST be added to that test's `ALLOWED_FILES` (it is the hosted-agent human write path — same boundary class as `src/surface/capture.ts`).
- **Wire shape of a change (verbatim):** `{ path: string, kind: "create" | "edit" }`. No commit oid on the wire.
- Auto-commit + report; no confirm-each-write, no in-app undo (deferred).

---

## File Structure

**New:**
- `src/agent/write.ts` — the write-path module: path validation, `createDocument`, `editDocument`, `AGENT_TRAILER_KEY`, `AgentWriteError`.
- `tests/agent/write.test.ts` — unit tests against a real temp git vault.

**Modified (SDK):**
- `src/agent/types.ts` — add `AgentChange`; add `changes` to `AgentResult`.
- `src/agent/tools.ts` — add `AgentWriteContext`; extend `buildAgentTools` with optional `write`; provision `create_document` / `edit_document` when present.
- `src/agent/agent.ts` — `AgentOptions.allowWrite`; build the write context in `setupAgent`; return/stream `changes`; `AgentStream.changes`; write-mode charter suffix.
- `src/http/server.ts` — pass `allowWrite` into the agent loop (gated on `author`); add `changes` to `/agent` JSON + the streaming `done` event; `changes` getter on the stream wrapper.
- `tests/integration/no-direct-mutation-outside-boundaries.test.ts` — allow `src/agent/write.ts`.
- `tests/http/server-agent-routes.test.ts` — fix the stale `AskStream` import, add `changes: []` to stubs, assert `changes` plumbing.
- `tests/agent/agent.test.ts` — add a write-loop test.

**Modified (PWA):**
- `pwa/src/api/types.ts` — `AgentChange`; `changes?` on `AgentResult` and the `done` `StreamEvent`.
- `pwa/src/chat/streamReducer.ts` — store `changes` on the assistant message.
- `pwa/src/App.tsx` — refetch on non-empty `changes`.
- `pwa/src/components/ChatTranscript.tsx` — render the "✎ updated" line.
- `pwa/src/styles.css` — `.changes` / `.change` styling.
- `pwa/tests/stream-reducer.test.ts`, `pwa/tests/chat-transcript.test.tsx`, `pwa/tests/app.test.tsx` — cover the new behavior.

---

## Task 1: Write-path module (`src/agent/write.ts`)

The independently-testable core: validate a vault-relative path, write the file, commit it on HEAD with a `Dome-Agent` trailer. Defines `AgentChange` (in `types.ts`, to avoid a `types → write` cycle).

**Files:**
- Modify: `src/agent/types.ts`
- Create: `src/agent/write.ts`
- Create: `tests/agent/write.test.ts`
- Modify: `tests/integration/no-direct-mutation-outside-boundaries.test.ts:13-38`

**Interfaces:**
- Consumes: `commitSingleFileOnHead({ path, filepath, content, message, author }): Promise<string>` from `../git`.
- Produces:
  - `type AgentChange = { readonly path: string; readonly kind: "create" | "edit" }` (in `types.ts`).
  - `const AGENT_TRAILER_KEY = "Dome-Agent"`.
  - `class AgentWriteError extends Error`.
  - `createDocument(ctx: { vaultPath: string; modelId: string }, input: { path: string; content: string }): Promise<AgentChange>`.
  - `editDocument(ctx: { vaultPath: string; modelId: string }, input: { path: string; old_string: string; new_string: string }): Promise<AgentChange>`.

- [ ] **Step 1: Add `AgentChange` to `types.ts`**

In `src/agent/types.ts`, after the `Citation` type and before `AgentResult`, add:

```typescript
/** A vault write the agent made during a run (surfaced to the client as done.changes). */
export type AgentChange = {
  readonly path: string;
  readonly kind: "create" | "edit";
};
```

Then add `changes` to `AgentResult` (keep the existing fields):

```typescript
/** The synthesized answer plus the evidence it cited and any writes it made. */
export type AgentResult = {
  readonly answer: string;
  readonly citations: ReadonlyArray<Citation>;
  readonly steps: number;
  readonly stopReason: "final" | "budget";
  /** Vault writes made this run; empty for read-only turns. */
  readonly changes: ReadonlyArray<AgentChange>;
};
```

- [ ] **Step 2: Write the failing test (`tests/agent/write.test.ts`)**

```typescript
import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import git from "isomorphic-git";
import fs from "node:fs";
import { createDocument, editDocument, AgentWriteError } from "../../src/agent/write";

async function tempVault(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "dome-agent-write-"));
  await git.init({ fs, dir, defaultBranch: "main" });
  await mkdir(join(dir, "wiki"), { recursive: true });
  await writeFile(join(dir, "wiki", "seed.md"), "# Seed\n", "utf8");
  await git.add({ fs, dir, filepath: "wiki/seed.md" });
  await git.commit({ fs, dir, message: "seed", author: { name: "t", email: "t@t" } });
  return dir;
}

const CTX = (vaultPath: string) => ({ vaultPath, modelId: "claude-sonnet-4-5" });

describe("createDocument", () => {
  let vault: string;
  beforeEach(async () => { vault = await tempVault(); });

  test("writes a new page, commits it with a Dome-Agent trailer, returns the change", async () => {
    const change = await createDocument(CTX(vault), { path: "wiki/new.md", content: "# New\nbody\n" });
    expect(change).toEqual({ path: "wiki/new.md", kind: "create" });
    expect(await readFile(join(vault, "wiki/new.md"), "utf8")).toBe("# New\nbody\n");
    const head = await git.resolveRef({ fs, dir: vault, ref: "HEAD" });
    const { commit } = await git.readCommit({ fs, dir: vault, oid: head });
    expect(commit.message).toContain("author: create wiki/new.md");
    expect(commit.message).toContain("Dome-Agent: claude-sonnet-4-5");
    expect(commit.author.name).toBe("dome agent");
  });

  test("rejects an existing path", async () => {
    await expect(createDocument(CTX(vault), { path: "wiki/seed.md", content: "x" }))
      .rejects.toBeInstanceOf(AgentWriteError);
  });

  test("rejects .dome/, absolute, escape, and non-.md paths", async () => {
    for (const p of [".dome/config.yaml", "/etc/passwd", "../outside.md", "wiki/notes.txt"]) {
      await expect(createDocument(CTX(vault), { path: p, content: "x" }))
        .rejects.toBeInstanceOf(AgentWriteError);
    }
  });
});

describe("editDocument", () => {
  let vault: string;
  beforeEach(async () => { vault = await tempVault(); });

  test("replaces a unique substring, commits, returns the change", async () => {
    await writeFile(join(vault, "wiki/seed.md"), "- [ ] do the thing\n", "utf8");
    await git.add({ fs, dir: vault, filepath: "wiki/seed.md" });
    await git.commit({ fs, dir: vault, message: "task", author: { name: "t", email: "t@t" } });
    const change = await editDocument(CTX(vault), { path: "wiki/seed.md", old_string: "- [ ] do the thing", new_string: "- [x] do the thing" });
    expect(change).toEqual({ path: "wiki/seed.md", kind: "edit" });
    expect(await readFile(join(vault, "wiki/seed.md"), "utf8")).toBe("- [x] do the thing\n");
  });

  test("errors when old_string is missing", async () => {
    await expect(editDocument(CTX(vault), { path: "wiki/seed.md", old_string: "nope", new_string: "x" }))
      .rejects.toBeInstanceOf(AgentWriteError);
  });

  test("errors when old_string is not unique", async () => {
    await writeFile(join(vault, "wiki/seed.md"), "dup\ndup\n", "utf8");
    await git.add({ fs, dir: vault, filepath: "wiki/seed.md" });
    await git.commit({ fs, dir: vault, message: "dup", author: { name: "t", email: "t@t" } });
    await expect(editDocument(CTX(vault), { path: "wiki/seed.md", old_string: "dup", new_string: "x" }))
      .rejects.toBeInstanceOf(AgentWriteError);
  });

  test("errors when the file does not exist", async () => {
    await expect(editDocument(CTX(vault), { path: "wiki/ghost.md", old_string: "a", new_string: "b" }))
      .rejects.toBeInstanceOf(AgentWriteError);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test ./tests/agent/write.test.ts`
Expected: FAIL — `Cannot find module '../../src/agent/write'`.

- [ ] **Step 4: Implement `src/agent/write.ts`**

```typescript
// src/agent/write.ts
//
// The hosted agent's vault write path. Mirrors `dome capture` (src/surface/capture.ts):
// write one markdown file into the working tree and land it as an ordinary human
// commit via commitSingleFileOnHead — the running daemon adopts the resulting
// branch drift, so PROPOSALS_ARE_THE_ONLY_WRITE_PATH holds. The only difference
// from capture is the `author:` verb and a single `Dome-Agent: <model>` trailer
// for attribution (deliberately NOT in DOME_TRAILER_KEYS, so the commit stays
// classified human, not engine).

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { commitSingleFileOnHead } from "../git";
import type { AgentChange } from "./types";

/** Attribution trailer key; NOT part of DOME_TRAILER_KEYS (engine Dome-Run family). */
export const AGENT_TRAILER_KEY = "Dome-Agent";

const AGENT_COMMIT_AUTHOR = { name: "dome agent", email: "dome-agent@local" } as const;

/** A rejected/failed write the tool layer surfaces to the model as prose. */
export class AgentWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentWriteError";
  }
}

/** Validate + normalize a caller-supplied path to a safe vault-relative `.md` path. */
function vaultRelPath(raw: string): string {
  const rel = typeof raw === "string" ? raw.trim() : "";
  if (rel.length === 0) throw new AgentWriteError("path is required");
  if (isAbsolute(rel)) throw new AgentWriteError("path must be vault-relative, not absolute");
  const norm = normalize(rel).replace(/\\/g, "/").replace(/^\.\//, "");
  if (norm === ".." || norm.startsWith("../") || norm.includes("/../")) {
    throw new AgentWriteError(`path escapes the vault: ${raw}`);
  }
  if (norm.split("/")[0] === ".dome") {
    throw new AgentWriteError(".dome/ is engine-internal and off-limits to the agent");
  }
  if (!norm.endsWith(".md")) {
    throw new AgentWriteError("only markdown (.md) files can be written");
  }
  return norm;
}

function commitMessage(verb: "create" | "edit", rel: string, modelId: string): string {
  return `author: ${verb} ${rel}\n\n${AGENT_TRAILER_KEY}: ${modelId}`;
}

export type AgentWriteCtx = { readonly vaultPath: string; readonly modelId: string };

export async function createDocument(
  ctx: AgentWriteCtx,
  input: { path: string; content: string },
): Promise<AgentChange> {
  const rel = vaultRelPath(input.path);
  const abs = join(ctx.vaultPath, rel);
  if (existsSync(abs)) {
    throw new AgentWriteError(`already exists: ${rel} (use edit_document to change it)`);
  }
  if (typeof input.content !== "string" || input.content.length === 0) {
    throw new AgentWriteError("content is required");
  }
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, input.content, "utf8");
  await commitSingleFileOnHead({
    path: ctx.vaultPath,
    filepath: rel,
    content: input.content,
    message: commitMessage("create", rel, ctx.modelId),
    author: AGENT_COMMIT_AUTHOR,
  });
  return { path: rel, kind: "create" };
}

export async function editDocument(
  ctx: AgentWriteCtx,
  input: { path: string; old_string: string; new_string: string },
): Promise<AgentChange> {
  const rel = vaultRelPath(input.path);
  const abs = join(ctx.vaultPath, rel);
  if (!existsSync(abs)) {
    throw new AgentWriteError(`not found: ${rel} (use create_document for a new page)`);
  }
  if (typeof input.old_string !== "string" || input.old_string.length === 0) {
    throw new AgentWriteError("old_string is required");
  }
  if (typeof input.new_string !== "string") {
    throw new AgentWriteError("new_string is required");
  }
  const current = await readFile(abs, "utf8");
  const first = current.indexOf(input.old_string);
  if (first === -1) {
    throw new AgentWriteError(`old_string not found in ${rel}`);
  }
  if (current.indexOf(input.old_string, first + 1) !== -1) {
    throw new AgentWriteError(`old_string is not unique in ${rel}; add more surrounding context`);
  }
  const next =
    current.slice(0, first) + input.new_string + current.slice(first + input.old_string.length);
  await writeFile(abs, next, "utf8");
  await commitSingleFileOnHead({
    path: ctx.vaultPath,
    filepath: rel,
    content: next,
    message: commitMessage("edit", rel, ctx.modelId),
    author: AGENT_COMMIT_AUTHOR,
  });
  return { path: rel, kind: "edit" };
}
```

- [ ] **Step 5: Add `write.ts` to the mutation-fence allow-list**

In `tests/integration/no-direct-mutation-outside-boundaries.test.ts`, inside the `ALLOWED_FILES` set (after the `src/surface/capture.ts` entry, before `src/cli/commands/reanchor.ts`), add:

```typescript
  // The hosted agent's write path: create_document / edit_document write one
  // markdown file and land it as an ordinary human commit via
  // commitSingleFileOnHead — exactly like `dome capture`. Same boundary class
  // as capture.ts; the daemon constructs the Proposal from the branch drift.
  "src/agent/write.ts",
```

- [ ] **Step 6: Make the activity surface strip the `Dome-Agent` trailer line**

`src/surface/activity.ts` renders commit bodies with `stripDomeTrailers`, whose `DOME_TRAILER_LINE` regex (line ~182) only matches the four `DOME_TRAILER_KEYS`. An agent commit's body is exactly `Dome-Agent: <model>`, which would otherwise leak into `dome log`/activity prose. Extend the regex to also drop that line. (Use a literal string, NOT an import from `src/agent/write.ts` — `activity.ts` is a core surface module and must not depend on the agent layer.)

Replace the regex definition:

```typescript
// Also drop the hosted agent's attribution trailer (src/agent/write.ts
// AGENT_TRAILER_KEY = "Dome-Agent"). Kept as a literal — activity.ts is core
// and must not import the agent layer — and deliberately out of DOME_TRAILER_KEYS
// so it never affects engine/human commit classification.
const DOME_TRAILER_LINE = new RegExp(`^(?:${[...DOME_TRAILER_KEYS, "Dome-Agent"].join("|")}):`);
```

Add a test to `tests/surface/activity.test.ts` (or wherever activity is tested — `grep -rln "stripDomeTrailers\|surface/activity" tests`) asserting a body of `"Dome-Agent: claude-sonnet-4-5"` renders empty after stripping. If no such test file exists, add a minimal one importing the module's tested entrypoint; otherwise extend the nearest body-rendering test.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun test ./tests/agent/write.test.ts ./tests/integration/no-direct-mutation-outside-boundaries.test.ts ./tests/surface`
Expected: PASS (all write.test cases green; the fence test green with the new allow-list entry; activity strip test green).

- [ ] **Step 8: Commit**

```bash
git add src/agent/write.ts src/agent/types.ts src/surface/activity.ts tests/agent/write.test.ts tests/integration/no-direct-mutation-outside-boundaries.test.ts tests/surface
git commit -m "feat(agent): write-path module (create/edit document → Dome-Agent commit)"
```

---

## Task 2: Provision write tools in `buildAgentTools`

Add the two author-gated tools. The presence of an `AgentWriteContext` IS the gate — read-only callers pass nothing and get exactly today's three tools. Each tool catches errors and returns an `"error: …"` string (matching the existing tools) so a rejected write never crashes the loop.

**Files:**
- Modify: `src/agent/tools.ts`
- Create/modify test: `tests/agent/tools.test.ts`

**Interfaces:**
- Consumes: `createDocument` / `editDocument` from `./write`; `AgentChange` from `./types`.
- Produces:
  - `type AgentWriteContext = { readonly vaultPath: string; readonly modelId: string; readonly changes: AgentChange[] }`.
  - `buildAgentTools(vault: Vault, citations: Citation[], write?: AgentWriteContext): ToolSet` — adds `create_document` + `edit_document` keys iff `write` is provided.

- [ ] **Step 1: Write the failing test**

Append to `tests/agent/tools.test.ts` (create the file if it does not exist, with the imports shown):

```typescript
import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import git from "isomorphic-git";
import fs from "node:fs";
import { buildAgentTools, type AgentWriteContext } from "../../src/agent/tools";
import type { AgentChange } from "../../src/agent/types";

async function tempVault(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "dome-tools-write-"));
  await git.init({ fs, dir, defaultBranch: "main" });
  await mkdir(join(dir, "wiki"), { recursive: true });
  await writeFile(join(dir, "wiki", "seed.md"), "# Seed\n", "utf8");
  await git.add({ fs, dir, filepath: "wiki/seed.md" });
  await git.commit({ fs, dir, message: "seed", author: { name: "t", email: "t@t" } });
  return dir;
}

// Minimal Vault stub: tools only need `.path` for writes here.
function vaultAt(path: string) {
  return { path, runView: async () => ({ kind: "ok", structured: { data: { matches: [] } } }), readDocument: async () => null } as never;
}

describe("buildAgentTools write provisioning", () => {
  test("omits write tools when no write context is given", () => {
    const tools = buildAgentTools(vaultAt("/tmp/x"), []);
    expect(Object.keys(tools)).not.toContain("create_document");
    expect(Object.keys(tools)).not.toContain("edit_document");
  });

  test("includes write tools when a write context is given", () => {
    const tools = buildAgentTools(vaultAt("/tmp/x"), [], { vaultPath: "/tmp/x", modelId: "m", changes: [] });
    expect(Object.keys(tools)).toContain("create_document");
    expect(Object.keys(tools)).toContain("edit_document");
  });

  test("create_document writes, commits, and records the change", async () => {
    const vault = await tempVault();
    const changes: AgentChange[] = [];
    const write: AgentWriteContext = { vaultPath: vault, modelId: "m", changes };
    const tools = buildAgentTools(vaultAt(vault), [], write);
    const out = await (tools["create_document"] as { execute: (i: unknown) => Promise<string> }).execute({ path: "wiki/n.md", content: "# N\n" });
    expect(out).toContain("created wiki/n.md");
    expect(changes).toEqual([{ path: "wiki/n.md", kind: "create" }]);
    expect(await readFile(join(vault, "wiki/n.md"), "utf8")).toBe("# N\n");
  });

  test("create_document returns an error string (does not throw) on a bad path", async () => {
    const vault = await tempVault();
    const changes: AgentChange[] = [];
    const tools = buildAgentTools(vaultAt(vault), [], { vaultPath: vault, modelId: "m", changes });
    const out = await (tools["create_document"] as { execute: (i: unknown) => Promise<string> }).execute({ path: ".dome/x.md", content: "y" });
    expect(out).toStartWith("error:");
    expect(changes).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test ./tests/agent/tools.test.ts`
Expected: FAIL — `buildAgentTools` does not accept a third arg / `create_document` absent.

- [ ] **Step 3: Implement the write tools in `tools.ts`**

Add imports near the top of `src/agent/tools.ts` (after the existing `import type { Citation } from "./types";`):

```typescript
import type { AgentChange } from "./types";
import { createDocument, editDocument } from "./write";
```

Add the exported context type just above the `buildAgentTools` declaration:

```typescript
/**
 * Author context for the write tools. When passed to buildAgentTools, the
 * create_document / edit_document tools are provisioned (this presence IS the
 * `author` gate); the tools push each successful write into `changes`.
 */
export type AgentWriteContext = {
  readonly vaultPath: string;
  readonly modelId: string;
  readonly changes: AgentChange[];
};
```

Replace the `buildAgentTools` signature + body so it appends write tools when `write` is provided. Keep the three existing tools exactly as-is; change only the signature and the `return`:

```typescript
export function buildAgentTools(
  vault: Vault,
  citations: Citation[],
  write?: AgentWriteContext | undefined,
): ToolSet {
  const tools: ToolSet = {
    search_vault: tool({
      // ... unchanged ...
    }),
    read_document: tool({
      // ... unchanged ...
    }),
    todays_brief: tool({
      // ... unchanged ...
    }),
  };

  if (write !== undefined) {
    tools["create_document"] = tool({
      description:
        "Create a NEW markdown page in the vault and commit it. Fails if the path already exists — use edit_document for an existing page. Path is vault-relative (e.g. wiki/notes/foo.md), .md only; .dome/ is off-limits.",
      inputSchema: z.object({
        path: z.string().describe("Vault-relative .md path for the new page."),
        content: z.string().describe("Full markdown content of the new page."),
      }),
      execute: async (input) => {
        try {
          const change = await createDocument(
            { vaultPath: write.vaultPath, modelId: write.modelId },
            { path: String(input.path), content: String(input.content) },
          );
          write.changes.push(change);
          return `created ${change.path}`;
        } catch (e) {
          return `error: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    });
    tools["edit_document"] = tool({
      description:
        "Edit an existing vault page by replacing an exact, UNIQUE substring, then commit. old_string must appear exactly once — include enough surrounding context to be unique. Use to check off a task ('- [ ]' → '- [x]'), fix a line, etc.",
      inputSchema: z.object({
        path: z.string().describe("Vault-relative .md path of the page to edit."),
        old_string: z.string().describe("Exact text to replace; must be unique in the file."),
        new_string: z.string().describe("Replacement text."),
      }),
      execute: async (input) => {
        try {
          const change = await editDocument(
            { vaultPath: write.vaultPath, modelId: write.modelId },
            {
              path: String(input.path),
              old_string: String(input.old_string),
              new_string: String(input.new_string),
            },
          );
          write.changes.push(change);
          return `edited ${change.path}`;
        } catch (e) {
          return `error: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    });
  }

  return tools;
}
```

> NOTE: the three existing tool definitions (`search_vault`, `read_document`, `todays_brief`) are copied verbatim from the current file into the `tools` object literal — do not change their bodies. Only the function signature, the `const tools: ToolSet = { … }` wrapper, the `if (write !== undefined)` block, and the trailing `return tools;` are new.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test ./tests/agent/tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools.ts tests/agent/tools.test.ts
git commit -m "feat(agent): provision author-gated create/edit_document tools"
```

---

## Task 3: Thread `allowWrite` + `changes` through the agent loop

`setupAgent` builds the `AgentWriteContext` from `vault.path`, the resolved model id, and a fresh `changes[]`, and passes it to `buildAgentTools` when `allowWrite`. `runAgent` returns `changes`; `runAgentStream` exposes the same-reference `changes` array (drained-complete once `finished` resolves). A write-mode charter suffix tells the model it can edit.

**Files:**
- Modify: `src/agent/agent.ts`
- Modify: `tests/agent/agent.test.ts`

**Interfaces:**
- Consumes: `buildAgentTools(vault, citations, write?)` + `AgentWriteContext` from `./tools`; `AgentChange`, `AgentResult` from `./types`.
- Produces:
  - `AgentOptions.allowWrite?: boolean | undefined`.
  - `runAgent` returns `AgentResult` including `changes`.
  - `AgentStream` gains `readonly changes: AgentChange[]`.

- [ ] **Step 1: Write the failing test**

Add to `tests/agent/agent.test.ts` (it already imports `MockLanguageModelV3`, `runAgent`, and has `toolCallStep` / `textStep` / `usage` helpers — reuse them). Add a temp-git-vault helper and a write test:

```typescript
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import git from "isomorphic-git";
import fs from "node:fs";

async function tempVaultHandle() {
  const dir = mkdtempSync(join(tmpdir(), "dome-agent-loop-write-"));
  await git.init({ fs, dir, defaultBranch: "main" });
  await mkdir(join(dir, "wiki"), { recursive: true });
  await writeFile(join(dir, "wiki", "seed.md"), "# Seed\n", "utf8");
  await git.add({ fs, dir, filepath: "wiki/seed.md" });
  await git.commit({ fs, dir, message: "seed", author: { name: "t", email: "t@t" } });
  return {
    path: dir,
    runView: async () => ({ kind: "ok", structured: { data: { matches: [] } } }),
    readDocument: async () => null,
  } as never;
}

describe("runAgent write capability", () => {
  test("with allowWrite, a create_document tool-call writes + commits and surfaces in changes", async () => {
    const vault = await tempVaultHandle();
    const model = new MockLanguageModelV3({
      doGenerate: [
        toolCallStep("create_document", { path: "wiki/made.md", content: "# Made\n" }),
        textStep("Created the page."),
      ],
    });
    const result = await runAgent({ vault, question: "make a page", model, allowWrite: true });
    expect(result.changes).toEqual([{ path: "wiki/made.md", kind: "create" }]);
    expect(await readFile(join((vault as unknown as { path: string }).path, "wiki/made.md"), "utf8")).toBe("# Made\n");
  });

  test("without allowWrite, the write tools are absent (read-only); changes is empty", async () => {
    const vault = await tempVaultHandle();
    const model = new MockLanguageModelV3({ doGenerate: [textStep("nothing to do")] });
    const result = await runAgent({ vault, question: "hi", model });
    expect(result.changes).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test ./tests/agent/agent.test.ts`
Expected: FAIL — `allowWrite` not accepted / `result.changes` undefined.

- [ ] **Step 3: Implement the threading in `agent.ts`**

In `src/agent/agent.ts`:

a) Update imports (add `AgentWriteContext`, `AgentChange`):

```typescript
import { buildAgentTools, type AgentWriteContext } from "./tools";
import type { Citation, AgentResult, AgentChange } from "./types";
```

b) Add the write-mode charter suffix below `AGENT_CHARTER`:

```typescript
const WRITE_CHARTER = [
  "You can also modify the vault. Use create_document for a new page and edit_document for a surgical, unique-substring edit to an existing page (e.g. checking off a task: '- [ ]' → '- [x]').",
  "Make the smallest change that satisfies the request, then briefly state what you changed. Never write under .dome/.",
].join(" ");
```

c) Add `allowWrite` to `AgentOptions`:

```typescript
type AgentOptions = {
  readonly vault: Vault;
  readonly question: string;
  readonly modelId?: string | undefined;
  readonly model?: LanguageModel | undefined;
  readonly maxSteps?: number | undefined;
  readonly abortSignal?: AbortSignal | undefined;
  /** Grant the author capability: provisions create_document / edit_document. */
  readonly allowWrite?: boolean | undefined;
};
```

d) Rewrite `setupAgent` to build the write context, the system prompt, and carry `changes`:

```typescript
function setupAgent(opts: AgentOptions): {
  readonly model: LanguageModel;
  readonly system: string;
  readonly prompt: string;
  readonly tools: ToolSet;
  readonly maxSteps: number;
  readonly citations: Citation[];
  readonly changes: AgentChange[];
  readonly abortSignal: AbortSignal | undefined;
} {
  const citations: Citation[] = [];
  const changes: AgentChange[] = [];
  const modelId = opts.modelId ?? DEFAULT_MODEL;
  const write: AgentWriteContext | undefined =
    opts.allowWrite === true
      ? { vaultPath: opts.vault.path, modelId, changes }
      : undefined;
  return {
    model: opts.model ?? anthropic(modelId),
    system: write !== undefined ? `${AGENT_CHARTER} ${WRITE_CHARTER}` : AGENT_CHARTER,
    prompt: opts.question,
    tools: buildAgentTools(opts.vault, citations, write),
    maxSteps: opts.maxSteps ?? 8,
    citations,
    changes,
    abortSignal: opts.abortSignal,
  };
}
```

e) In `runAgent`, destructure `changes` and include it in the returned `AgentResult`:

```typescript
export async function runAgent(opts: AgentOptions): Promise<AgentResult> {
  const { model, system, prompt, tools, maxSteps, citations, changes, abortSignal } =
    setupAgent(opts);

  const { text, steps, finishReason } = await generateText({
    model,
    system,
    prompt,
    tools,
    stopWhen: stepCountIs(maxSteps),
    ...(abortSignal !== undefined ? { abortSignal } : {}),
  });

  const stopReason = stopReasonOf(finishReason);

  const answer =
    text.trim().length > 0
      ? text
      : "I couldn't reach a complete answer within the step budget. Here's what I found: " +
        (citations.length > 0
          ? citations.map((c) => c.path).join(", ")
          : "no relevant vault pages.");

  return { answer, citations, steps: steps.length, stopReason, changes };
}
```

f) Add `changes` to the `AgentStream` type:

```typescript
export type AgentStream = {
  readonly fullStream: AsyncIterable<TextStreamPart<ToolSet>>;
  readonly citations: Citation[];
  /** Vault writes made this run; same array the tools push into — complete once `finished` resolves. */
  readonly changes: AgentChange[];
  readonly finished: Promise<{ readonly stopReason: AgentResult["stopReason"] }>;
};
```

g) In `runAgentStream`, destructure and return `changes`:

```typescript
export function runAgentStream(opts: AgentOptions): AgentStream {
  const { model, system, prompt, tools, maxSteps, citations, changes, abortSignal } =
    setupAgent(opts);

  const result = streamText({
    model,
    system,
    prompt,
    tools,
    stopWhen: stepCountIs(maxSteps),
    ...(abortSignal !== undefined ? { abortSignal } : {}),
  });

  return {
    fullStream: result.fullStream,
    citations,
    changes,
    finished: Promise.resolve(result.finishReason).then(
      (finishReason) => ({ stopReason: stopReasonOf(finishReason) }),
      () => ({ stopReason: "budget" as const }),
    ),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test ./tests/agent/agent.test.ts ./tests/agent/agent-stream.test.ts`
Expected: PASS (the new write tests green; existing read-only agent + stream tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/agent/agent.ts tests/agent/agent.test.ts
git commit -m "feat(agent): thread allowWrite + changes through the agent loop"
```

---

## Task 4: Surface `changes` on the HTTP `/agent` routes

Pass `allowWrite` into the default agent impls (gated on the `author` capability, the single source of truth), and add `changes` to the buffered JSON response and the streaming `done` event. Also fix the Phase-1 leftover: the test imports `AskStream` from the deleted `src/agent/ask`.

**Files:**
- Modify: `src/http/server.ts`
- Modify: `tests/http/server-agent-routes.test.ts`

**Interfaces:**
- Consumes: `has(granted, "author")` (already imported); `runAgent` / `runAgentStream` (now produce `changes`); `AgentStream.changes`.
- Produces: `/agent` JSON gains `changes`; the SSE `done` event gains `changes`; the stream wrapper exposes a `changes` getter.

- [ ] **Step 1: Write the failing tests**

In `tests/http/server-agent-routes.test.ts`:

First fix the stale import at the top (line 7):

```typescript
import type { AgentStream } from "../../src/agent/agent";
```

Then rename `AskStream` → `AgentStream` everywhere in the file (the `fakeStream` return annotation ~line 16, and the inline `agentStreamImpl` annotation ~line 239), and add `changes: []` to `fakeStream`'s returned object and to the buffered `agentImpl` stub in `server()` (~line 44).

Add these assertions (new tests in the existing `describe` blocks):

```typescript
test("POST /agent includes a changes array in the JSON", async () => {
  const srv = createDomeHttpServer({
    vaultPath: "/tmp/unused",
    token: TOKEN,
    agentImpl: async (q: string) => ({
      answer: `a:${q}`,
      citations: [],
      steps: 1,
      stopReason: "final" as const,
      changes: [{ path: "wiki/made.md", kind: "create" as const }],
    }),
  });
  const res = await srv.fetch(post({ question: "make it" }));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { changes: { path: string; kind: string }[] };
  expect(body.changes).toEqual([{ path: "wiki/made.md", kind: "create" }]);
});

test("the streaming done event carries changes", async () => {
  const srv = createDomeHttpServer({
    vaultPath: "/tmp/unused",
    token: TOKEN,
    agentStreamImpl: (): AgentStream => ({
      fullStream: (async function* () {
        yield { type: "text-delta", id: "t", text: "ok" } as TextStreamPart<ToolSet>;
        yield { type: "finish", finishReason: "stop" } as unknown as TextStreamPart<ToolSet>;
      })(),
      citations: [],
      changes: [{ path: "wiki/seed.md", kind: "edit" }],
      finished: Promise.resolve({ stopReason: "final" as const }),
    }),
  });
  const res = await srv.fetch(new Request("http://localhost/agent/stream", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ question: "check it off" }),
  }));
  const text = await res.text();
  const doneLine = text.split("\n\n").map((b) => b.split("\n").find((l) => l.startsWith("data:"))).filter(Boolean).map((l) => JSON.parse(l!.slice(5).trim())).find((e) => e.type === "done");
  expect(doneLine.changes).toEqual([{ path: "wiki/seed.md", kind: "edit" }]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test ./tests/http/server-agent-routes.test.ts`
Expected: FAIL — `body.changes` undefined; `done` event has no `changes`; (and the import fix makes the file load).

- [ ] **Step 3: Implement in `src/http/server.ts`**

a) In `defaultAsk` (the `runAgent` call ~line 355), pass `allowWrite` gated on the `author` capability:

```typescript
  const defaultAsk: AgentImpl = async (question, signal) => {
    const outcome = await withVaultShared(
      { path: opts.vaultPath, bundlesRoot: opts.bundlesRoot },
      (vault) =>
        runAgent({
          vault,
          question,
          abortSignal: signal,
          ...(opts.model !== undefined ? { modelId: opts.model } : {}),
          ...(has(granted, "author") ? { allowWrite: true } : {}),
        }),
    );
    if (outcome.kind === "open-failed") {
      throw new Error(`vault open failed: ${openVaultErrorKind(outcome.error)}`);
    }
    return outcome.value;
  };
```

b) In `defaultAskStream` (the `runAgentStream` call ~line 391), add the same:

```typescript
        stream = runAgentStream({
          vault,
          question,
          abortSignal: signal,
          ...(opts.model !== undefined ? { modelId: opts.model } : {}),
          ...(has(granted, "author") ? { allowWrite: true } : {}),
        });
```

c) Add a `changes` getter to the `defaultAskStream` return object (next to the `citations` getter ~line 428):

```typescript
      get citations() {
        return stream?.citations ?? [];
      },
      get changes() {
        return stream?.changes ?? [];
      },
```

d) In the buffered `POST /agent` JSON (~line 582), add `changes`:

```typescript
        return jsonResponse(200, {
          schema: SCHEMA,
          status: "ok",
          answer: result.answer,
          citations: result.citations,
          steps: result.steps,
          stopReason: result.stopReason,
          changes: result.changes,
        });
```

e) In the streaming `done` event (~line 681), add `changes`:

```typescript
              const { stopReason } = await stream.finished;
              ctrl.enqueue(
                sse({ type: "done", citations: stream.citations, changes: stream.changes, stopReason }),
              );
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test ./tests/http/server-agent-routes.test.ts ./tests/capabilities.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full SDK agent + http surface + fences**

Run: `bun test ./tests/agent ./tests/http ./tests/capabilities.test.ts ./tests/integration/no-direct-mutation-outside-boundaries.test.ts`
Expected: PASS (no regressions across the moved/renamed surface).

- [ ] **Step 6: Commit**

```bash
git add src/http/server.ts tests/http/server-agent-routes.test.ts
git commit -m "feat(http): surface agent changes on /agent JSON + streaming done; gate write on author"
```

---

## Task 5: Client surfacing — render writes + refetch the brief

The PWA stores `changes` on the assistant message, renders a subtle "✎ created/updated `<page>`" line, and (in `App.onAsk`) refetches `/tasks` + `/recents` when the `done` event reports a non-empty `changes` — so editable to-dos "just work" (ask → agent edits + commits → brief refreshes). Read-only turns refetch nothing.

**Files:**
- Modify: `pwa/src/api/types.ts`
- Modify: `pwa/src/chat/streamReducer.ts`
- Modify: `pwa/src/App.tsx`
- Modify: `pwa/src/components/ChatTranscript.tsx`
- Modify: `pwa/src/styles.css`
- Modify: `pwa/tests/stream-reducer.test.ts`
- Modify: `pwa/tests/chat-transcript.test.tsx`
- Modify: `pwa/tests/app.test.tsx`

**Interfaces:**
- Consumes: `done` events now carry `changes?: AgentChange[]`.
- Produces: `AgentChange` (pwa type); `ChatMessage.changes: AgentChange[]`.

- [ ] **Step 1: Add the types (`pwa/src/api/types.ts`)**

After the `Citation` type, add:

```typescript
export type AgentChange = {
  path: string;
  kind: "create" | "edit";
};
```

Add `changes?` to `AgentResult` (after `stopReason`):

```typescript
export type AgentResult = {
  schema: "dome.ask/v1";
  status: "ok";
  answer: string;
  citations: Citation[];
  steps: number;
  stopReason: "final" | "budget";
  changes?: AgentChange[];
};
```

Add `changes?` to the `done` `StreamEvent` variant:

```typescript
export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "done"; citations: Citation[]; stopReason: "final" | "budget"; changes?: AgentChange[] }
  | { type: "error"; message: string };
```

- [ ] **Step 2: Write the failing reducer test (`pwa/tests/stream-reducer.test.ts`)**

Add:

```typescript
test("done with changes stores them on the assistant message", () => {
  let s: ChatState = { messages: [] };
  s = chatReducer(s, { kind: "assistant-start" });
  s = chatReducer(s, { kind: "event", event: { type: "text", text: "done" } });
  s = chatReducer(s, { kind: "event", event: { type: "done", citations: [], stopReason: "final", changes: [{ path: "wiki/a.md", kind: "edit" }] } });
  expect(s.messages[0]!.changes).toEqual([{ path: "wiki/a.md", kind: "edit" }]);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd pwa && bun test tests/stream-reducer.test.ts`
Expected: FAIL — `changes` not on `ChatMessage`.

- [ ] **Step 4: Update the reducer (`pwa/src/chat/streamReducer.ts`)**

Update imports and the message type, init `changes: []`, and store on `done`:

```typescript
import type { AgentChange, Citation, StreamEvent } from "../api/types";

export type ChatMessage = { role: "user" | "assistant"; text: string; citations: Citation[]; changes: AgentChange[]; streaming: boolean };
```

In the `"user"` case add `changes: []`:

```typescript
    case "user":
      return { messages: [...state.messages, { role: "user", text: action.text, citations: [], changes: [], streaming: false }] };
```

In the `"assistant-start"` case add `changes: []`:

```typescript
    case "assistant-start":
      return { messages: [...state.messages, { role: "assistant", text: "", citations: [], changes: [], streaming: true }] };
```

In the `"event"` case, on `done`, store `changes`:

```typescript
      if (e.type === "text") msgs[msgs.length - 1] = { ...last, text: last.text + e.text };
      else if (e.type === "done") msgs[msgs.length - 1] = { ...last, citations: e.citations, changes: e.changes ?? [], streaming: false };
      else msgs[msgs.length - 1] = { ...last, text: `${last.text} [error: ${e.message}]`, streaming: false };
```

- [ ] **Step 5: Run the reducer test to verify it passes**

Run: `cd pwa && bun test tests/stream-reducer.test.ts`
Expected: PASS.

- [ ] **Step 6: Render the changes line (`pwa/src/components/ChatTranscript.tsx`)**

Add, inside the message `div`, after the `Cites` line (the `shortPath` helper already exists in this file):

```tsx
          {m.citations.length > 0 ? <Cites citations={m.citations} /> : null}
          {m.changes.length > 0 ? (
            <div className="changes">
              {m.changes.map((c, j) => (
                <span key={j} className="change">✎ {c.kind === "create" ? "created" : "updated"} {shortPath(c.path)}</span>
              ))}
            </div>
          ) : null}
```

- [ ] **Step 7: Write + run the ChatTranscript test (`pwa/tests/chat-transcript.test.tsx`)**

Add a test that renders a message with `changes` and asserts the line appears. Match the existing test style in that file (it already imports a render helper and `ChatState`); use:

```tsx
test("renders a changes line for agent writes", () => {
  const state = { messages: [{ role: "assistant" as const, text: "Done.", citations: [], changes: [{ path: "wiki/todo.md", kind: "edit" as const }], streaming: false }] };
  render(<ChatTranscript state={state} />);
  expect(screen.getByText(/updated/)).toBeTruthy();
  expect(screen.getByText(/todo\.md/)).toBeTruthy();
});
```

Run: `cd pwa && bun test tests/chat-transcript.test.tsx`
Expected: PASS.

- [ ] **Step 8: Refetch on writes (`pwa/src/App.tsx`)**

Update `onAsk` so the stream callback triggers `refresh()` when a `done` event reports writes:

```tsx
  const onAsk = (q: string): void => {
    dispatch({ kind: "user", text: q });
    dispatch({ kind: "assistant-start" });
    setBriefCollapsed(true);
    void client.agentStream(q, (e) => {
      dispatch({ kind: "event", event: e });
      if (e.type === "done" && (e.changes?.length ?? 0) > 0) refresh();
    });
  };
```

- [ ] **Step 9: Write + run the App refetch test (`pwa/tests/app.test.tsx`)**

Add a test that drives a mocked `agentStream` emitting a `done` with `changes` and asserts `tasks()`/`recents()` are called again after the initial mount. Follow the existing mocking pattern in `app.test.tsx` (it already stubs `DomeClient`). Sketch:

```tsx
test("refetches the brief after the agent reports a write", async () => {
  // arrange a DomeClient mock whose agentStream emits a done event with changes,
  // and spy on tasks()/recents(); assert they are called a second time (post-mount).
  // (Mirror the existing app.test.tsx client-mock + waitFor setup.)
});
```

Implement it concretely against the file's existing helpers, then run:

Run: `cd pwa && bun test tests/app.test.tsx`
Expected: PASS.

- [ ] **Step 10: Style the changes line (`pwa/src/styles.css`)**

After the `.cites` / `.chip` rules (~line 212), add:

```css
.changes { display: flex; flex-direction: column; gap: 2px; margin-top: 9px; }
.change { font: 500 11px var(--mono); color: var(--sage); }
```

- [ ] **Step 11: Run the full PWA suite**

Run: `cd pwa && bun test`
Expected: PASS (all PWA tests green, including the new reducer/transcript/app cases).

- [ ] **Step 12: Commit**

```bash
git add pwa/src/api/types.ts pwa/src/chat/streamReducer.ts pwa/src/App.tsx pwa/src/components/ChatTranscript.tsx pwa/src/styles.css pwa/tests/stream-reducer.test.ts pwa/tests/chat-transcript.test.tsx pwa/tests/app.test.tsx
git commit -m "feat(pwa): render agent writes (✎ updated) and refetch the brief on changes"
```

---

## Task 6: Run docs + memory note

Surface the new capability in the operator docs and update the client-model memory so the next session knows Phase 2 shipped and how to run write mode.

**Files:**
- Modify: the `dome http` run docs (locate via `grep -rln "dome http" docs` — likely `docs/wiki/specs/*` or the PWA run doc updated in Phase 1).
- Modify: `/Users/mark.toda/.claude/projects/-Users-mark-toda-dev-dome/memory/dome-client-model-and-contract-audit.md` and its `MEMORY.md` pointer line (only if the recall hook is active — this is operator memory, not repo content).

- [ ] **Step 1: Document the write switch**

In the run doc(s) for `dome http`, add one line documenting `--allow-write` / `DOME_ALLOW_WRITE=1` enabling the `author` capability (create/edit document → commit → daemon adopts), default off (read-only-safe). Keep it to the existing doc's voice and length; do not restructure.

- [ ] **Step 2: Verify the docs reference is accurate**

Run: `grep -rn "allow-write\|DOME_ALLOW_WRITE\|--allow-write" docs src/cli`
Expected: the flag is already wired in `src/cli` (Phase 1); the doc line now matches.

- [ ] **Step 3: Commit the docs**

```bash
git add docs
git commit -m "docs: document dome http --allow-write (author capability)"
```

- [ ] **Step 4: Update memory (operator note, not committed)**

Update `dome-client-model-and-contract-audit.md`: Phase 2 SHIPPED — `author` capability live; `create_document`/`edit_document` write via `commitSingleFileOnHead` (Dome-Agent trailer, daemon adopts); `done.changes` drives the PWA "✎ updated" line + brief refetch; enabled by `dome http --allow-write` / `DOME_ALLOW_WRITE=1`, default off. Keep the `SECOND_USER_GATE` (per-token scopes) deferred note.

---

## Final verification (before finishing the branch)

- [ ] Run the SDK suite scoped (the canonical gate): `bun test ./tests`
  Expected: all pass (≈2900, 0 fail), including the new `tests/agent/write.test.ts`, `tests/agent/tools.test.ts`, the agent-loop write cases, and the `/agent` change-plumbing tests.
- [ ] Run the PWA suite: `cd pwa && bun test`
  Expected: all pass.
- [ ] Confirm fences: `bun test ./tests/integration` (mutation boundary moved; bundle-deps / public-surface still green).
- [ ] Then invoke **superpowers:finishing-a-development-branch** to verify tests, present merge options, and clean up.

---

## Self-Review (completed during authoring)

**Spec coverage** — every Phase 2 line in `docs/superpowers/specs/2026-06-19-write-capable-agent-design.md §Sequencing`:
- `author` gating → Task 4 (gated on `has(granted,"author")`), Task 3 (`allowWrite`), Task 2 (presence-of-context gate). ✓
- `create_document` / `edit_document` → Tasks 1–2. ✓
- `Dome-Agent` commit → Task 1 (trailer + `commitSingleFileOnHead` reuse; kept out of `DOME_TRAILER_KEYS` so classification stays human; activity-strip read-side hygiene in Task 1 Step 6 so `dome log` parses it cleanly). ✓
- `done.changes` → Task 3 (loop) + Task 4 (wire). ✓
- client surfacing + brief refetch → Task 5. ✓
- Error handling (path escape / `.dome/` / missing-or-ambiguous `old_string` / not-found → tool-error prose, loop survives) → Task 1 validation + Task 2 catch-and-return-string. ✓
- Testing matrix (write+commit+trailer, rejected without author, path-escape/`.dome/`, ambiguous old_string, `done.changes` populated, fences) → Tasks 1,2,3,4 tests. ✓
- Fence allow-list move → Task 1 Step 5. ✓

**Placeholder scan:** Task 5 Steps 9 has a sketched App test (the file's exact mock helpers must be read at execution time) — flagged explicitly, not silently. All code steps that create production code show complete code.

**Type consistency:** `AgentChange = { path, kind: "create" | "edit" }` is identical in `src/agent/types.ts` and `pwa/src/api/types.ts`. `AgentWriteContext` (`{ vaultPath, modelId, changes }`) is consistent across `tools.ts` (defines) and `agent.ts` (constructs). `createDocument`/`editDocument` ctx is `{ vaultPath, modelId }` in `write.ts` and called with exactly those keys from `tools.ts`. `AgentStream.changes` and `AgentResult.changes` both present and read at the wire in `server.ts`.
