# Concept Consolidator (vault-janitor agent) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a weekly autonomous "vault janitor" agent (`dome.agent.consolidate`) that auto-merges duplicate/near-duplicate wiki pages and tidies within-page append-drift, navigating the vault via `index.md`/`log.md` + grep and recording progress in a cross-run ledger.

**Architecture:** A second agent definition on the existing `dome.agent` framework. Reuses the tool-use loop harness + the provider step seam; adds a `deletePage` tool, a consolidator tool set, a rich charter, and a top-level `consolidation-ledger.md` convention. The processor runs one agent loop per scheduled tick; the agent's edits accumulate in one shared `AgentRunState` (overlay reads, so successive merges/link-rewrites compose) and land as a single cumulative `PatchEffect`.

**Tech Stack:** TypeScript + Bun; the `dome.agent` bundle (`assets/extensions/dome.agent/`); tests via `bun test`.

**Spec:** `docs/superpowers/specs/2026-06-09-concept-consolidator-design.md`

**Decisions (locked):** auto-merge + commit, ask-don't-guess on ambiguity; hard-delete + link-rewrite; scope = merge dupes + within-page tidy (no reorganization); agent-driven via the vault's own map; weekly `0 4 * * 1`; `maxDailyCostUsd: 10`, `maxSteps: 50`; substring `searchVault` (defer regex grep); ledger at top-level `consolidation-ledger.md`.

---

## File Structure

- **Create `assets/extensions/dome.agent/lib/vault-tools.ts`** — shared tool library: `VaultReader` type, the read helpers (`currentContent`, `overlayPaths`, `capRead`, `objectSchema`, `STRING`), and per-tool factories (`readPageTool`, `listPagesTool`, `searchVaultTool`, `writePageTool`, `appendToPageTool`, `archiveSourceTool`, `deletePageTool`, `askOwnerTool`). Each returns an `AgentTool`. *(Extracted from the current `ingest-tools.ts` so both agents compose from one home; `deletePageTool` is the only new behavior.)*
- **Modify `assets/extensions/dome.agent/lib/ingest-tools.ts`** — `makeIngestTools` now composes the factories from `vault-tools.ts` (behavior identical; guarded by the existing ingest-tools tests).
- **Create `assets/extensions/dome.agent/lib/consolidate-tools.ts`** — `makeConsolidatorTools({reader})` composing `[readPage, listPages, searchVault, writePage, deletePage, askOwner]`.
- **Create `assets/extensions/dome.agent/lib/consolidate-charter.ts`** — `CONSOLIDATE_CHARTER` (the intelligence; bundled prompt data).
- **Create `assets/extensions/dome.agent/processors/consolidate.ts`** — the garden `kind: llm` processor: one agent loop per tick → one cumulative `PatchEffect` + questions + truncation diagnostic.
- **Modify `assets/extensions/dome.agent/manifest.yaml`** — add the `dome.agent.consolidate` processor entry.
- **Modify `src/cli/default-vault-config.ts`** — add `consolidation-ledger.md` to the `dome.agent` `read` + `patch.auto` grant.
- **Modify `src/extensions/maintenance-loops.ts`** — list `dome.agent.consolidate` in the `dome.link-concept.coherence` loop (coverage test).
- **Modify tests** — `tests/cli/commands.test.ts` (model-processor count 2 → 3) + any inventory assertion that enumerates dome.agent processors.
- **Create tests** — `tests/extensions/dome.agent/vault-tools.test.ts` (deletePage), `tests/extensions/dome.agent/consolidate.test.ts` (processor).
- **Modify `docs/wiki/specs/autonomous-agents.md`** — add a `dome.agent.consolidate` section.

---

## Task 1: Extract the shared tool library (`vault-tools.ts`) + `deletePageTool`

**Files:**
- Create: `assets/extensions/dome.agent/lib/vault-tools.ts`
- Modify: `assets/extensions/dome.agent/lib/ingest-tools.ts`
- Test: `tests/extensions/dome.agent/vault-tools.test.ts`

- [ ] **Step 1: Write the failing test.** Create `tests/extensions/dome.agent/vault-tools.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { deletePageTool, readPageTool } from "../../../assets/extensions/dome.agent/lib/vault-tools";
import type { AgentRunState } from "../../../assets/extensions/dome.agent/lib/agent-loop";

function freshState(): AgentRunState {
  return { edits: new Map(), questions: [] };
}
const reader = (files: Record<string, string>) => ({
  readFile: async (p: string) => files[p] ?? null,
  listMarkdownFiles: async () => Object.keys(files),
});

describe("deletePageTool", () => {
  test("accumulates a delete edit", async () => {
    const t = deletePageTool();
    const state = freshState();
    await t.execute({ path: "wiki/concepts/dupe.md" }, state);
    expect(state.edits.get("wiki/concepts/dupe.md")).toEqual({
      kind: "delete",
      path: "wiki/concepts/dupe.md",
    });
  });

  test("a deleted page reads back as absent within the run", async () => {
    const del = deletePageTool();
    const read = readPageTool(reader({ "wiki/concepts/dupe.md": "old" }));
    const state = freshState();
    await del.execute({ path: "wiki/concepts/dupe.md" }, state);
    const out = await read.execute({ path: "wiki/concepts/dupe.md" }, state);
    expect(out).toContain("(no file at");
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `bun test tests/extensions/dome.agent/vault-tools.test.ts`
Expected: FAIL — module `vault-tools` not found.

- [ ] **Step 3: Create `vault-tools.ts`.** Move the helpers + tools out of `ingest-tools.ts` into per-tool factories. Create `assets/extensions/dome.agent/lib/vault-tools.ts`:

```typescript
// Shared vault tool library for dome.agent agents. Each factory returns an
// AgentTool bound to an injected VaultReader (the test/snapshot seam). The
// read helpers overlay the in-run AgentRunState so successive edits compose.

import type { AgentRunState, AgentTool } from "./agent-loop";

export type VaultReader = {
  readonly readFile: (path: string) => Promise<string | null>;
  readonly listMarkdownFiles: () => Promise<ReadonlyArray<string>>;
};

const STRING = { type: "string" } as const;

export function objectSchema(
  props: Record<string, unknown>,
  required: ReadonlyArray<string>,
): Readonly<Record<string, unknown>> {
  return { type: "object", properties: props, required, additionalProperties: false };
}

// Cap a single read so one large page can't blow the context budget.
const MAX_READ_CHARS = 20_000;
export function capRead(content: string): string {
  if (content.length <= MAX_READ_CHARS) return content;
  return `${content.slice(0, MAX_READ_CHARS)}\n…[truncated ${content.length - MAX_READ_CHARS} chars — read a more specific section if needed]`;
}

export async function currentContent(
  path: string,
  state: AgentRunState,
  reader: VaultReader,
): Promise<string | null> {
  const pending = state.edits.get(path);
  if (pending?.kind === "write") return pending.content;
  if (pending?.kind === "delete") return null;
  return reader.readFile(path);
}

// snapshot paths ∪ pages written this run − pages deleted this run.
export async function overlayPaths(
  state: AgentRunState,
  reader: VaultReader,
): Promise<ReadonlyArray<string>> {
  const set = new Set(await reader.listMarkdownFiles());
  for (const [path, edit] of state.edits) {
    if (edit.kind === "write") set.add(path);
    else set.delete(path);
  }
  return [...set].sort();
}

export function readPageTool(reader: VaultReader): AgentTool {
  return {
    schema: {
      name: "readPage",
      description: "Read a vault file's current content. Returns null if absent.",
      inputSchema: objectSchema({ path: STRING }, ["path"]),
    },
    execute: async (input, state) => {
      const { path } = input as { path: string };
      const content = await currentContent(path, state, reader);
      return content === null ? `(no file at ${path})` : capRead(content);
    },
  };
}

export function listPagesTool(reader: VaultReader): AgentTool {
  return {
    schema: {
      name: "listPages",
      description: "List all readable markdown paths in the vault.",
      inputSchema: objectSchema({}, []),
    },
    execute: async (_input, state) => (await overlayPaths(state, reader)).join("\n"),
  };
}

export function searchVaultTool(reader: VaultReader): AgentTool {
  return {
    schema: {
      name: "searchVault",
      description: "Find readable markdown paths whose content contains the query (case-insensitive).",
      inputSchema: objectSchema({ query: STRING }, ["query"]),
    },
    execute: async (input, state) => {
      const { query } = input as { query: string };
      const needle = query.toLowerCase();
      const hits: string[] = [];
      for (const path of await overlayPaths(state, reader)) {
        const content = await currentContent(path, state, reader);
        if (content !== null && content.toLowerCase().includes(needle)) hits.push(path);
        if (hits.length >= 25) break;
      }
      return hits.length === 0 ? "(no matches)" : hits.join("\n");
    },
  };
}

export function writePageTool(): AgentTool {
  return {
    schema: {
      name: "writePage",
      description: "Create or fully replace a file. Read first when updating.",
      inputSchema: objectSchema({ path: STRING, content: STRING }, ["path", "content"]),
    },
    execute: async (input, state) => {
      const { path, content } = input as { path: string; content: string };
      state.edits.set(path, { kind: "write", path, content });
      return `wrote ${path}`;
    },
  };
}

export function appendToPageTool(reader: VaultReader): AgentTool {
  return {
    schema: {
      name: "appendToPage",
      description: "Append a block to the end of a file (creates it if absent).",
      inputSchema: objectSchema({ path: STRING, content: STRING }, ["path", "content"]),
    },
    execute: async (input, state) => {
      const { path, content } = input as { path: string; content: string };
      const existing = await currentContent(path, state, reader);
      const next =
        existing === null || existing.trim() === ""
          ? content
          : `${existing.replace(/\s+$/, "")}\n${content}`;
      state.edits.set(path, { kind: "write", path, content: next });
      return `appended to ${path}`;
    },
  };
}

export function archiveSourceTool(reader: VaultReader): AgentTool {
  return {
    schema: {
      name: "archiveSource",
      description: "Move a consumed inbox/raw source to inbox/processed.",
      inputSchema: objectSchema({ rawPath: STRING }, ["rawPath"]),
    },
    execute: async (input, state) => {
      const { rawPath } = input as { rawPath: string };
      const body = (await currentContent(rawPath, state, reader)) ?? "";
      const processedPath = rawPath.replace(/^inbox\/raw\//, "inbox/processed/");
      state.edits.set(processedPath, { kind: "write", path: processedPath, content: body });
      state.edits.set(rawPath, { kind: "delete", path: rawPath });
      return `archived ${rawPath} -> ${processedPath}`;
    },
  };
}

export function deletePageTool(): AgentTool {
  return {
    schema: {
      name: "deletePage",
      description: "Delete a vault file (used when merging its content into a canonical page). Rewrite inbound links first.",
      inputSchema: objectSchema({ path: STRING }, ["path"]),
    },
    execute: async (input, state) => {
      const { path } = input as { path: string };
      state.edits.set(path, { kind: "delete", path });
      return `deleted ${path}`;
    },
  };
}

export function askOwnerTool(idempotencyPrefix: string): AgentTool {
  return {
    schema: {
      name: "askOwner",
      description: "Ask the owner a question when a decision is genuinely uncertain.",
      inputSchema: objectSchema({ question: STRING }, ["question"]),
    },
    execute: async (input, state) => {
      const { question } = input as { question: string };
      state.questions.push({ question, idempotencyKey: `${idempotencyPrefix}${question}` });
      return "asked the owner";
    },
  };
}
```

- [ ] **Step 4: Refactor `ingest-tools.ts` to compose the factories.** Replace the entire body of `assets/extensions/dome.agent/lib/ingest-tools.ts` with:

```typescript
// Tool bindings for the ingest agent — composed from the shared vault-tools.
import type { AgentTool } from "./agent-loop";
import {
  appendToPageTool,
  archiveSourceTool,
  askOwnerTool,
  listPagesTool,
  readPageTool,
  searchVaultTool,
  writePageTool,
  type VaultReader,
} from "./vault-tools";

export type { VaultReader } from "./vault-tools";

export function makeIngestTools(opts: {
  readonly reader: VaultReader;
}): ReadonlyArray<AgentTool> {
  const { reader } = opts;
  return [
    readPageTool(reader),
    listPagesTool(reader),
    searchVaultTool(reader),
    writePageTool(),
    appendToPageTool(reader),
    archiveSourceTool(reader),
    askOwnerTool("dome.agent.ingest:"),
  ];
}
```

- [ ] **Step 5: Run the new test + the existing ingest-tools/ingest tests.**

Run: `bun test tests/extensions/dome.agent/`
Expected: PASS — `vault-tools` tests pass; `ingest-tools` + `ingest` tests still pass (behavior unchanged). Run `bun run typecheck` → exit 0.

- [ ] **Step 6: Commit.**

```bash
git add assets/extensions/dome.agent/lib/vault-tools.ts assets/extensions/dome.agent/lib/ingest-tools.ts tests/extensions/dome.agent/vault-tools.test.ts
git commit -m "refactor(dome.agent): extract shared vault-tools; add deletePage tool"
```

---

## Task 2: Consolidator tool set

**Files:**
- Create: `assets/extensions/dome.agent/lib/consolidate-tools.ts`
- Test: `tests/extensions/dome.agent/consolidate-tools.test.ts`

- [ ] **Step 1: Write the failing test.** Create `tests/extensions/dome.agent/consolidate-tools.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { makeConsolidatorTools } from "../../../assets/extensions/dome.agent/lib/consolidate-tools";

const reader = () => ({
  readFile: async () => null,
  listMarkdownFiles: async () => [],
});

describe("makeConsolidatorTools", () => {
  test("provides the consolidator tool set incl. deletePage, excl. inbox tools", async () => {
    const names = makeConsolidatorTools({ reader: reader() }).map((t) => t.schema.name).sort();
    expect(names).toEqual(["askOwner", "deletePage", "listPages", "readPage", "searchVault", "writePage"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `bun test tests/extensions/dome.agent/consolidate-tools.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `consolidate-tools.ts`.**

```typescript
// Tool set for the consolidator agent — composed from the shared vault-tools.
import type { AgentTool } from "./agent-loop";
import {
  askOwnerTool,
  deletePageTool,
  listPagesTool,
  readPageTool,
  searchVaultTool,
  writePageTool,
  type VaultReader,
} from "./vault-tools";

export function makeConsolidatorTools(opts: {
  readonly reader: VaultReader;
}): ReadonlyArray<AgentTool> {
  const { reader } = opts;
  return [
    readPageTool(reader),
    listPagesTool(reader),
    searchVaultTool(reader),
    writePageTool(),
    deletePageTool(),
    askOwnerTool("dome.agent.consolidate:"),
  ];
}
```

- [ ] **Step 4: Run the test + typecheck.**

Run: `bun test tests/extensions/dome.agent/consolidate-tools.test.ts && bun run typecheck`
Expected: PASS, exit 0.

- [ ] **Step 5: Commit.**

```bash
git add assets/extensions/dome.agent/lib/consolidate-tools.ts tests/extensions/dome.agent/consolidate-tools.test.ts
git commit -m "feat(dome.agent): consolidator tool set"
```

---

## Task 3: The consolidator charter

**Files:**
- Create: `assets/extensions/dome.agent/lib/consolidate-charter.ts`

- [ ] **Step 1: Create the charter** (no test — it's a constant string; exercised by Task 4).

```typescript
// The consolidator agent's charter (system prompt). The vault janitor:
// auto-merge duplicate pages + tidy within-page append-drift. Navigates via
// the vault's own map (index.md/log.md) + grep; merges losslessly; asks
// instead of guessing when ambiguous; records progress in the ledger.

export const CONSOLIDATE_CHARTER = [
  "You are Dome's vault consolidator — a weekly janitor for a markdown knowledge vault. Your job: make the vault denser and less duplicated by (1) merging duplicate / near-duplicate pages into one canonical page, and (2) tidying single pages that have grown by appending. You do NOT reorganize, split, or re-home content — only consolidate.",
  "",
  "## The map (start here, don't read everything)",
  "- `index.md` is the catalog: one line per page (path + description), grouped by type. Read it first to get the whole-vault picture cheaply.",
  "- `log.md` is the recent activity history — use it to find pages touched recently (fresh ingest is where new duplicates are born).",
  "- `consolidation-ledger.md` (top-level) is YOUR memory across runs. Read it first. Skip any pair already recorded as 'not a duplicate'; resume from the coverage cursor.",
  "- Pages live under `wiki/{entities,concepts,sources,syntheses}/`. Cross-references are full-path `[[wikilinks]]`.",
  "",
  "## How to hunt (top-down, bounded)",
  "1. Read index.md + log.md + the ledger. Cross-check index.md against `listPages()` — a file missing from index.md is an orphan to note.",
  "2. Scan for SUSPECT clusters by judgment: similar titles/slugs, near-identical descriptions, same topic.",
  "3. Confirm with `searchVault` — a distinctive phrase from a suspect page, or its inbound links `[[wiki/<type>/<slug>]]`.",
  "4. `readPage` ONLY the 2–4 finalist pages in a cluster. Don't read the whole vault.",
  "5. Prioritize recently-changed pages first, then one un-swept region. Stop when you have done a solid batch (you have a step budget) and record where you stopped.",
  "",
  "## Merging duplicate pages (operation 1)",
  "When you are CONFIDENT two+ pages are the same thing:",
  "- Pick the canonical page (better slug, more inbound links, richer history).",
  "- Write the canonical page as a LOSSLESS fusion: keep every source-grounded fact and every `[[wikilink]]` from all the pages, union their `sources:` frontmatter, dedupe only redundant prose. Never drop a fact to look tidy.",
  "- `deletePage` each absorbed page.",
  "- Rewrite EVERY inbound link: `searchVault` for `[[wiki/<type>/<absorbed-slug>]]`, then for each page found, `readPage` it and `writePage` it back with the link repointed to the canonical page. Leave no dangling link.",
  "- Update `index.md` (remove the absorbed entries; refresh the canonical description) and append a `log.md` entry.",
  "",
  "## The ambiguity rule (critical)",
  "If you are NOT confident two pages are the same thing — they look related but might be genuinely distinct concepts — do NOT merge. Call `askOwner` (\"Merge `X` ← `Y`? they look related but may be distinct because …\") and move on. A wrong merge silently destroys a distinct concept. When in doubt, ask; never guess-merge.",
  "",
  "## Within-page tidy (operation 2)",
  "When a single page has append-drift (repeated headings, `## Update`/`## More notes` sections, duplicated facts), rewrite it into ONE coherent, de-duplicated page — preserving every fact, every `[[wikilink]]`, the frontmatter, and a `## See Also` section. Update its `updated:` date.",
  "",
  "## Record your work in the ledger",
  "After your batch, update `consolidation-ledger.md`: append the merges you performed, the pairs you judged NOT duplicates (so future runs skip them), and the coverage cursor (where to resume). Use this format under the relevant section; create the file if absent with a `# Consolidation ledger` heading.",
  "",
  "## Tools",
  "- readPage(path), listPages(), searchVault(query) — navigate/read.",
  "- writePage(path, content) — create/replace (the canonical merge, a link rewrite, index/log/ledger updates).",
  "- deletePage(path) — delete an absorbed page (rewrite its inbound links FIRST).",
  "- askOwner(question) — for ambiguous merges only.",
  "",
  "Be decisive on clear duplicates, conservative on ambiguous ones, and lossless always. When your batch is done and the ledger is updated, reply with a one-line summary and no tool call.",
].join("\n");
```

- [ ] **Step 2: Commit.**

```bash
git add assets/extensions/dome.agent/lib/consolidate-charter.ts
git commit -m "feat(dome.agent): consolidator charter"
```

---

## Task 4: The consolidator processor

**Files:**
- Create: `assets/extensions/dome.agent/processors/consolidate.ts`
- Test: `tests/extensions/dome.agent/consolidate.test.ts`

- [ ] **Step 1: Write the failing test.** Create `tests/extensions/dome.agent/consolidate.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import consolidate from "../../../assets/extensions/dome.agent/processors/consolidate";
import type { ProcessorContext, ModelStepResult } from "../../../src/core/processor";
import type { PatchEffect, QuestionEffect } from "../../../src/core/effect";

function makeCtx(opts: {
  files: Record<string, string>;
  stepFn?: (input: {
    readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
  }) => Promise<ModelStepResult>;
}): ProcessorContext {
  const modelInvoke =
    opts.stepFn === undefined
      ? undefined
      : (Object.assign(async () => "", {
          structured: async () => ({}) as never,
          step: opts.stepFn,
        }) as never);
  return {
    snapshot: {
      commit: "c" as never,
      tree: "t" as never,
      readFile: async (p: string) => opts.files[p] ?? null,
      listMarkdownFiles: async () => Object.keys(opts.files),
      getFileInfo: async () => null,
    },
    changedPaths: [],
    proposal: null,
    runId: "run1",
    input: { kind: "schedule" },
    now: () => new Date("2026-06-09T04:00:00Z"),
    signal: new AbortController().signal,
    capabilities: {} as never,
    extensionConfig: {},
    ...(modelInvoke !== undefined ? { modelInvoke } : {}),
    sourceRef: (path: string) => ({ path }) as never,
  } as ProcessorContext;
}

describe("dome.agent.consolidate", () => {
  test("no-op when no model step is wired", async () => {
    expect(await consolidate.run(makeCtx({ files: { "index.md": "x" } }))).toEqual([]);
  });

  test("merges a duplicate into one PatchEffect: canonical write + absorbed delete + link rewrite", async () => {
    const files = {
      "index.md": "## Concepts\n- [[wiki/concepts/a]] — A\n- [[wiki/concepts/b]] — B (dup)\n",
      "wiki/concepts/a.md": "# A\nfact-A",
      "wiki/concepts/b.md": "# B\nfact-B",
      "wiki/concepts/refs-b.md": "see [[wiki/concepts/b]]",
    };
    const stepFn = async ({
      messages,
    }: {
      readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
    }): Promise<ModelStepResult> => {
      const turns = messages.filter((m) => m.role === "assistant").length;
      // 0: write canonical A (fused) → 1: delete B → 2: rewrite the inbound link → 3: done
      if (turns === 0)
        return { toolCalls: [{ id: "1", name: "writePage", input: { path: "wiki/concepts/a.md", content: "# A\nfact-A\nfact-B" } }] };
      if (turns === 1)
        return { toolCalls: [{ id: "2", name: "deletePage", input: { path: "wiki/concepts/b.md" } }] };
      if (turns === 2)
        return { toolCalls: [{ id: "3", name: "writePage", input: { path: "wiki/concepts/refs-b.md", content: "see [[wiki/concepts/a]]" } }] };
      return { text: "merged b into a" };
    };
    const effects = await consolidate.run(makeCtx({ files, stepFn }));
    const patches = effects.filter((e) => e.kind === "patch") as PatchEffect[];
    expect(patches.length).toBe(1);
    const byPath = new Map(patches[0]!.changes.map((c) => [String(c.path), c]));
    expect(byPath.get("wiki/concepts/a.md")?.kind).toBe("write");
    expect(byPath.get("wiki/concepts/b.md")?.kind).toBe("delete");
    expect(byPath.get("wiki/concepts/refs-b.md")?.kind).toBe("write");
    expect(patches[0]!.sourceRefs.length).toBeGreaterThan(0);
  });

  test("ambiguous case asks instead of merging", async () => {
    const stepFn = async ({
      messages,
    }: {
      readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
    }): Promise<ModelStepResult> => {
      const turns = messages.filter((m) => m.role === "assistant").length;
      if (turns === 0)
        return { toolCalls: [{ id: "1", name: "askOwner", input: { question: "Merge X ← Y? may be distinct" } }] };
      return { text: "asked" };
    };
    const effects = await consolidate.run(makeCtx({ files: { "index.md": "x" }, stepFn }));
    expect(effects.find((e) => e.kind === "patch")).toBeUndefined();
    const q = effects.find((e) => e.kind === "question") as QuestionEffect;
    expect(q.question).toContain("Merge X");
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `bun test tests/extensions/dome.agent/consolidate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `consolidate.ts`.**

```typescript
// dome.agent.consolidate — weekly vault-janitor agent: merge duplicate pages
// + tidy within-page append-drift. One agent loop per scheduled tick; its
// edits accumulate in one AgentRunState (overlay reads compose successive
// merges + link rewrites) and land as a single cumulative PatchEffect.

import {
  diagnosticEffect,
  patchEffect,
  questionEffect,
  type Effect,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";
import { runAgentLoop, type AgentRunState } from "../lib/agent-loop";
import { makeConsolidatorTools } from "../lib/consolidate-tools";
import { CONSOLIDATE_CHARTER } from "../lib/consolidate-charter";

const MAX_STEPS = 50;
const LEDGER_PATH = "consolidation-ledger.md";

const consolidate = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const step = ctx.modelInvoke?.step;
    if (step === undefined) return Object.freeze([]); // clean no-op without a model

    const tools = makeConsolidatorTools({
      reader: {
        readFile: (p) => ctx.snapshot.readFile(p),
        listMarkdownFiles: () => ctx.snapshot.listMarkdownFiles(),
      },
    });

    const state: AgentRunState = { edits: new Map(), questions: [] };
    const effects: Effect[] = [];
    let truncated = false;
    try {
      const result = await runAgentLoop({
        charter: CONSOLIDATE_CHARTER,
        task: taskTurn(ctx.now()),
        tools,
        step,
        maxSteps: MAX_STEPS,
        state,
      });
      if (result.stopReason === "budget") truncated = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      effects.push(
        diagnosticEffect({
          severity: "warning",
          code: "dome.agent.consolidate-failed",
          message: `dome.agent.consolidate failed (${message}); no edits applied.`,
          sourceRefs: [ctx.sourceRef(LEDGER_PATH)],
        }),
      );
    }

    const sourceRefs = [ctx.sourceRef(LEDGER_PATH)];
    const changes = [...state.edits.values()].map((e) =>
      e.kind === "write"
        ? ({ kind: "write", path: e.path, content: e.content } as const)
        : ({ kind: "delete", path: e.path } as const),
    );
    if (changes.length > 0) {
      effects.push(
        patchEffect({
          mode: "auto",
          changes,
          reason: "dome.agent: consolidate vault",
          sourceRefs,
        }),
      );
    }
    for (const q of state.questions) {
      effects.push(
        questionEffect({ question: q.question, idempotencyKey: q.idempotencyKey, sourceRefs }),
      );
    }
    if (truncated) {
      effects.push(
        diagnosticEffect({
          severity: "warning",
          code: "dome.agent.truncated",
          message: `dome.agent.consolidate hit the ${MAX_STEPS}-step budget; partial cleanup applied, resume next run.`,
          sourceRefs,
        }),
      );
    }
    return Object.freeze(effects);
  },
});

export default consolidate;

function taskTurn(now: Date): string {
  const today = now.toISOString().slice(0, 10);
  return [
    `Today is ${today}. Consolidate the vault per your charter.`,
    "Start by reading index.md, log.md, and consolidation-ledger.md.",
    "Do a bounded batch of merges + within-page tidies, then update the ledger.",
  ].join("\n");
}
```

> Note: `ctx.sourceRef(LEDGER_PATH)` requires `consolidation-ledger.md` to be in the processor's effective `read` grant — added in Task 6. The single PatchEffect needs ≥1 SourceRef; the ledger path is always readable and always relevant, so it's the natural anchor.

- [ ] **Step 4: Run the test + typecheck.**

Run: `bun test tests/extensions/dome.agent/consolidate.test.ts && bun run typecheck`
Expected: PASS (3 tests), exit 0.

- [ ] **Step 5: Commit.**

```bash
git add assets/extensions/dome.agent/processors/consolidate.ts tests/extensions/dome.agent/consolidate.test.ts
git commit -m "feat(dome.agent): consolidate processor (one loop -> cumulative PatchEffect + questions)"
```

---

## Task 5: Manifest entry

**Files:**
- Modify: `assets/extensions/dome.agent/manifest.yaml`

- [ ] **Step 1: Add the processor.** Append to the `processors:` list in `assets/extensions/dome.agent/manifest.yaml` (after `dome.agent.inbox-stale-check`):

```yaml
  - id: dome.agent.consolidate
    version: 0.1.0
    phase: garden
    triggers:
      - kind: schedule
        cron: "0 4 * * 1"
    capabilities:
      - kind: read
        paths:
          - "wiki/**/*.md"
          - "index.md"
          - "log.md"
          - "consolidation-ledger.md"
      - kind: patch.auto
        paths:
          - "wiki/**/*.md"
          - "index.md"
          - "log.md"
          - "consolidation-ledger.md"
      - kind: model.invoke
        maxDailyCostUsd: 10
      - kind: question.ask
    execution:
      class: llm
      timeoutMs: 1800000
      modelCallTimeoutMs: 180000
    module: processors/consolidate.ts
```

- [ ] **Step 2: Verify the bundle loads.**

Run:
```bash
bun -e 'const { loadBundles } = await import("./src/extensions/loader.ts"); const r = await loadBundles({ bundlesRoot: "./assets/extensions" }); if(!r.ok){console.log("FAIL",JSON.stringify(r.error));process.exit(1);} const a=r.value.find(b=>b.id==="dome.agent"); console.log(a.processors.map(p=>p.id).join(", "));'
```
Expected: prints `dome.agent.ingest, dome.agent.inbox-stale-check, dome.agent.consolidate`.

- [ ] **Step 3: Commit.**

```bash
git add assets/extensions/dome.agent/manifest.yaml
git commit -m "feat(dome.agent): manifest entry for dome.agent.consolidate (weekly schedule)"
```

---

## Task 6: Default-config grant — add the ledger path

**Files:**
- Modify: `src/cli/default-vault-config.ts`

- [ ] **Step 1: Add `consolidation-ledger.md` to the `dome.agent` grant.** In `src/cli/default-vault-config.ts`, find the `extension("dome.agent", false, { ... })` entry. Add `"consolidation-ledger.md"` to both the `read` array and the `"patch.auto"` array (alongside `index.md`/`log.md`). The grant should read:

```typescript
    extension("dome.agent", false, {
      read: [
        "wiki/**/*.md",
        "notes/**/*.md",
        "inbox/**/*.md",
        "index.md",
        "log.md",
        "consolidation-ledger.md",
      ],
      "patch.auto": [
        "wiki/**/*.md",
        "notes/**/*.md",
        "index.md",
        "log.md",
        "consolidation-ledger.md",
        "inbox/processed/*.md",
        "inbox/raw/*.md",
      ],
      "model.invoke": Object.freeze({ maxDailyCostUsd: 5 }),
      "question.ask": true,
    }),
```

> Note: the *grant* `maxDailyCostUsd` (vault-side, default 5) stays as the conservative default; the consolidate processor's *manifest* declares 10. The effective cap is `min(declared, granted)` — so a vault that wants the full $10 for the consolidator raises this grant. Leaving the default at 5 keeps new vaults conservative (and the ingest agent shares this grant). This is intentional; do not change it.

- [ ] **Step 2: Typecheck + run the config tests.**

Run: `bun run typecheck && bun test tests/cli/commands.test.ts`
Expected: typecheck exit 0. `commands.test.ts` may now fail on (a) the default-config YAML assertion (it now includes `consolidation-ledger.md`) and (b) the model-processor count — both fixed in Task 8. If the config-YAML lockstep assertion fails here, note it; it's resolved in Task 8.

- [ ] **Step 3: Commit.**

```bash
git add src/cli/default-vault-config.ts
git commit -m "feat(config): grant dome.agent read/write on consolidation-ledger.md"
```

---

## Task 7: Maintenance-loop coverage

**Files:**
- Modify: `src/extensions/maintenance-loops.ts`

- [ ] **Step 1: List the new processor in a loop.** The test `cover every shipped first-party maintenance processor` requires every shipped processor appear in a loop's `processors`/`optionalProcessors` (or `EXEMPT_FIRST_PARTY_PROCESSORS`). Add `dome.agent.consolidate` to the `dome.link-concept.coherence` loop — its goal ("Links and concepts are navigable…") fits vault consolidation. Find that loop's `processors: [...]` array and add the entry:

```typescript
        "dome.agent.consolidate",
```

(Place it with the other concept/link processors in that loop. Do not add a new loop — the "five V1 loop design units" test pins exactly five loop IDs.)

- [ ] **Step 2: Run the maintenance-loops tests.**

Run: `bun test tests/extensions/maintenance-loops.test.ts`
Expected: PASS — five-loop id test still green; coverage test green (consolidate now covered).

- [ ] **Step 3: Commit.**

```bash
git add src/extensions/maintenance-loops.ts
git commit -m "feat(loops): cover dome.agent.consolidate in link-concept coherence loop"
```

---

## Task 8: Update inventory tests + full suite green

**Files:**
- Modify: `tests/cli/commands.test.ts` (and any other test that enumerates dome.agent processors / model-processor counts)

- [ ] **Step 1: Run the full suite and read the failures.**

Run: `bun test 2>&1 | grep -nE "\(fail\)|expect" | head -40`
Expected failures are inventory/lockstep assertions: the **model-processor count** (garden `model.invoke` processors were 2 — `dome.agent.ingest`, `dome.warden.integrity` — now **3** with `dome.agent.consolidate`), the **default-config YAML** snapshot (now includes `consolidation-ledger.md`), and possibly a **bundle/processor inventory** list for `dome.agent`.

- [ ] **Step 2: Update each failing assertion to the new reality.** For the model-processor count, change the expected number to 3. For the default-config YAML lockstep, add the `consolidation-ledger.md` lines to the expected text (mirroring Task 6). For any processor-list assertion, add `dome.agent.consolidate`. Do not weaken assertions — update expected values to the facts.

- [ ] **Step 3: Confirm the invariant test passes unchanged.**

Run: `bun test tests/invariants/model-processors-emit-no-durable-facts.test.ts`
Expected: PASS — `dome.agent.consolidate` declares `model.invoke` + `patch.auto` + `question.ask`, **not** `graph.write`.

- [ ] **Step 4: Full suite + typecheck.**

Run: `bun test && bun run typecheck`
Expected: 0 fail; typecheck exit 0.

- [ ] **Step 5: Commit.**

```bash
git add tests
git commit -m "test: update shipped-bundle inventory for dome.agent.consolidate"
```

---

## Task 9: Spec doc

**Files:**
- Modify: `docs/wiki/specs/autonomous-agents.md`

- [ ] **Step 1: Add a `dome.agent.consolidate` section** after the ingest section. Cover: it's the second agent on the framework; weekly `schedule` trigger (garden phase — no `command` trigger because commands are view/read-only); auto-merge + ask-on-ambiguity; hard-delete + link-rewrite; navigates via `index.md`/`log.md` + `searchVault`; the `consolidation-ledger.md` cross-run memory; one cumulative `PatchEffect`; grant (`read`/`patch.auto` over `wiki/**`+`index.md`+`log.md`+`consolidation-ledger.md`, `model.invoke`, `question.ask`, no `graph.write`). Link it from the `## Related` list. Keep the prose consistent with the ingest section's style.

- [ ] **Step 2: Confirm docs lockstep tests pass.**

Run: `bun test 2>&1 | tail -3`
Expected: 0 fail (the substrate/matrix lockstep tests accept the new prose; if a matrix enumerates shipped processors, add `dome.agent.consolidate` there too).

- [ ] **Step 3: Commit.**

```bash
git add docs/wiki/specs/autonomous-agents.md
git commit -m "docs: autonomous-agents spec — add dome.agent.consolidate"
```

---

## Self-Review

**1. Spec coverage** (design §-by-§):
- §2 posture (auto + ambiguity-ask) → charter (Task 3) + ambiguity test (Task 4). ✓
- §2 mechanic (delete + link-rewrite) → `deletePage` (Task 1) + charter link-rewrite recipe + merge test (Task 4). ✓
- §2 scope (1)+(2) → charter covers merge + within-page tidy. ✓ (within-page tidy is charter-driven via writePage; no separate code path needed — correct, it's the same write tool.)
- §3 architecture (agent navigates via index/log + grep) → charter (Task 3); no bespoke tools. ✓
- §4 tools (+deletePage) → Tasks 1–2. ✓
- §6 ledger → charter (Task 3) writes it; grant (Task 6) + ledger as SourceRef anchor (Task 4). ✓
- §7 shared accumulator + one PatchEffect + bounded action → processor (Task 4) uses shared state + MAX_STEPS=50 + truncation diagnostic. ✓
- §8 trigger/grant/bundle → manifest (Task 5) + grant (Task 6). **Correction applied:** schedule-only (command trigger dropped — invalid for garden phase); documented in Task 9.
- §10 error handling → per-run try/catch + truncation diagnostic (Task 4); dangling-link backstop is the existing `dome.markdown.validate-wikilinks`. ✓
- §11 testing → Tasks 1,2,4 tests (deletePage, tool set, merge mechanic, ambiguity, no-op). *Gap noted:* a dedicated "ledger-skip" and "shared-accumulator-across-clusters" test from §11 — the merge test already exercises sequential tool edits accumulating into one patch (covers the accumulator); ledger-skip is charter behavior (non-deterministic) so it's validated by manual run, not unit-tested. Acceptable.

**2. Placeholder scan:** No TBD/TODO. Test code + implementation code are complete. Inventory-count updates (Task 8) reference the real current value (2 → 3) and instruct verifying against the suite output rather than guessing.

**3. Type consistency:** `AgentRunState`, `AgentTool`, `VaultReader`, `runAgentLoop({state})`, `makeConsolidatorTools({reader})`, `CONSOLIDATE_CHARTER`, `deletePageTool()` are defined in Tasks 1–3 and used consistently in Task 4. Effect constructors (`patchEffect`/`questionEffect`/`diagnosticEffect`) match the signatures used in the shipped ingest processor. The `ingest-tools.ts` refactor (Task 1) preserves `makeIngestTools`'s exported name + shape, so `ingest.ts` and the ingest tests are unaffected.

> One scope note surfaced by review: the design's §8 "command trigger" is **not implementable** for a garden processor (command triggers are view-phase/read-only). v1 is schedule-only; on-demand garden invocation is future work. Flagged in Tasks 5 + 9.
