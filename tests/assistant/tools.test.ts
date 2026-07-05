import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import git from "isomorphic-git";
import fs from "node:fs";
import { buildAgentTools, type AgentWriteContext } from "../../src/assistant/tools";
import type { Citation, AgentChange } from "../../src/assistant/types";

// Real VaultViewResult shape: {kind: "ok", structured: {name, schema, data}, views, brokerDiagnostics}
// Real query structured.data shape (dome.search.query/v1):
//   {matches: [{path, title, snippet, sourceRefs: [{path, commit, ...}], ...}]}
// Note: sourceRefs is an array (plural), NOT a single sourceRef object.

function fakeVault(over: Partial<{ runView: unknown; readDocument: unknown }> = {}) {
  return {
    runView:
      over.runView ??
      (async (_cmd: string, _args: unknown) => ({
        kind: "ok",
        views: [],
        brokerDiagnostics: [],
        structured: {
          name: "dome.search.query",
          schema: "dome.search.query/v1",
          data: {
            schema: "dome.search.query/v1",
            query: "robinhood",
            matches: [
              {
                path: "wiki/entities/robinhood-chain.md",
                title: "Robinhood Chain",
                snippet: "launches ~early July 2026",
                category: "wiki",
                type: null,
                sectionId: null,
                breadcrumb: null,
                rank: 1,
                sourceRefs: [
                  { path: "wiki/entities/robinhood-chain.md", commit: "abc123" },
                ],
                facts: [],
                diagnostics: [],
                questions: [],
              },
            ],
          },
        },
      })),
    readDocument:
      over.readDocument ??
      (async (path: string) => ({ path, commit: "abc123", content: "# Hello" })),
  } as never;
}

// The AI SDK passes parsed input to execute(); the second arg is ToolCallOptions.
// Our tools ignore it, so a minimal cast suffices for unit-testing execute.
const callOpts = {} as never;

describe("buildAgentTools", () => {
  test("search_vault returns matches and records citations", async () => {
    const citations: Citation[] = [];
    const tools = buildAgentTools(fakeVault(), citations);
    const out = await tools.search_vault!.execute!({ text: "robinhood" }, callOpts);
    expect(out).toContain("wiki/entities/robinhood-chain.md");
    expect(citations).toHaveLength(1);
    expect(citations[0]?.path).toBe("wiki/entities/robinhood-chain.md");
  });

  test("read_document returns content and records a citation", async () => {
    const citations: Citation[] = [];
    const tools = buildAgentTools(fakeVault(), citations);
    const out = await tools.read_document!.execute!({ path: "wiki/x.md" }, callOpts);
    expect(out).toContain("# Hello");
    expect(citations.map((c) => c.path)).toContain("wiki/x.md");
  });

  test("todays_brief returns task text and records citation", async () => {
    const todayVault = fakeVault({
      runView: async (_cmd: string, _args: unknown) => ({
        kind: "ok",
        views: [],
        brokerDiagnostics: [],
        structured: {
          name: "dome.daily.today",
          schema: "dome.daily.today/v1",
          // A realistic dome.daily.today/v1 payload — the real producer always
          // emits date + counts (now validated by the shared contract).
          data: {
            date: "2026-06-22",
            counts: { openTasks: 1, followups: 0, questions: 0 },
            openTasks: [
              {
                text: "Reply to vendor",
                path: "inbox/raw/x.md",
                sourceRefs: [{ path: "inbox/raw/x.md", commit: "c1" }],
              },
            ],
            followups: [],
            questions: [],
            brief: null,
            calendar: null,
            hero: null,
          },
        },
      }),
    });
    const citations: Citation[] = [];
    const tools = buildAgentTools(todayVault, citations);
    const out = await tools.todays_brief!.execute!({}, callOpts);
    expect(out).toContain("Reply to vendor");
    expect(citations.map((c) => c.path)).toContain("inbox/raw/x.md");
  });

  test("read_document on a missing path returns a not-found message, no citation", async () => {
    const citations: Citation[] = [];
    const tools = buildAgentTools(fakeVault({ readDocument: async () => null }), citations);
    const out = await tools.read_document!.execute!({ path: "missing.md" }, callOpts);
    expect(String(out).toLowerCase()).toContain("not found");
    expect(citations).toHaveLength(0);
  });
});

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
