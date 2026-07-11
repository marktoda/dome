import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import git from "isomorphic-git";
import fs from "node:fs";
import { buildAgentTools, type AgentActionContext } from "../../src/assistant/tools";
import type { Citation, AgentChange } from "../../src/assistant/types";
import { grantedCapabilities, type Capability } from "../../src/capabilities";
import { runInit } from "../../src/cli/commands/init";
import { commitSingleFileOnHead, readBlob, resolveRef } from "../../src/git";

// Real VaultViewResult shape: {kind: "ok", structured: {name, schema, data}, views, brokerDiagnostics}
// Real query structured.data shape (dome.search.query/v1):
//   {matches: [{path, title, snippet, sourceRefs: [{path, commit, ...}], ...}]}
// Note: sourceRefs is an array (plural), NOT a single sourceRef object.

function fakeVault(over: Partial<{ runView: unknown; readDocument: unknown }> = {}) {
  return {
    listViews: () => [
      { command: "query", processorId: "dome.search.query", processorVersion: "1", extensionId: "dome.search" },
      { command: "today", processorId: "dome.daily.today", processorVersion: "1", extensionId: "dome.daily" },
    ],
    runView:
      over.runView ??
      (async (_cmd: string, _args: unknown) => ({
        kind: "ok",
        views: [
          {
            kind: "view",
            name: "dome.search.query",
            content: {
              kind: "structured",
              schema: "dome.search.query/v1",
              data: { matches: [{ path: "wiki/entities/robinhood-chain.md" }] },
            },
            scope: [{ path: "wiki/entities/robinhood-chain.md", commit: "abc123" }],
          },
        ],
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
  test("run_view invokes an installed plugin view and records its scope", async () => {
    const citations: Citation[] = [];
    const tools = buildAgentTools(fakeVault(), citations);
    const out = await tools.run_view!.execute!(
      { command: "query", input: { text: "robinhood" } },
      callOpts,
    );
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

  test("run_view rejects commands not contributed by installed plugins", async () => {
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
    const out = await tools.run_view!.execute!({ command: "missing" }, callOpts);
    expect(out).toContain("view-not-found");
    expect(out).toContain("query");
    expect(citations).toHaveLength(0);
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
  return { path, listViews: () => [], runView: async () => ({ kind: "ok", views: [], brokerDiagnostics: [], structured: null }), readDocument: async () => null } as never;
}

/** Action-context helper: the same shape AgentRuntime passes to the built-in tools. */
function actionCtx(
  vaultPath: string,
  caps: readonly Capability[],
  changes: AgentChange[] = [],
): AgentActionContext {
  return { vaultPath, modelId: "m", changes, capabilities: new Set<Capability>(caps) };
}

describe("buildAgentTools write provisioning", () => {
  test("omits write tools when no action context is given", () => {
    const tools = buildAgentTools(vaultAt("/tmp/x"), []);
    expect(Object.keys(tools)).not.toContain("create_document");
    expect(Object.keys(tools)).not.toContain("edit_document");
  });

  test("includes write tools when the author capability is granted", () => {
    const tools = buildAgentTools(vaultAt("/tmp/x"), [], actionCtx("/tmp/x", ["author"]));
    expect(Object.keys(tools)).toContain("create_document");
    expect(Object.keys(tools)).toContain("edit_document");
  });

  test("create_document writes, commits, and records the change", async () => {
    const vault = await tempVault();
    const changes: AgentChange[] = [];
    const tools = buildAgentTools(vaultAt(vault), [], actionCtx(vault, ["author"], changes));
    const out = await (tools["create_document"] as { execute: (i: unknown) => Promise<string> }).execute({ path: "wiki/n.md", content: "# N\n" });
    expect(out).toContain("created wiki/n.md");
    expect(changes).toEqual([{ path: "wiki/n.md", kind: "create" }]);
    expect(await readFile(join(vault, "wiki/n.md"), "utf8")).toBe("# N\n");
  });

  test("create_document returns an error string (does not throw) on a bad path", async () => {
    const vault = await tempVault();
    const changes: AgentChange[] = [];
    const tools = buildAgentTools(vaultAt(vault), [], actionCtx(vault, ["author"], changes));
    const out = await (tools["create_document"] as { execute: (i: unknown) => Promise<string> }).execute({ path: ".dome/x.md", content: "y" });
    expect(out).toStartWith("error:");
    expect(changes).toHaveLength(0);
  });
});

// ----- contract-tool provisioning (mirrors ROUTE_CAPABILITY in src/http/server.ts) -----

const CONTRACT_MUTATION_TOOLS = [
  "settle_task",
  "resolve_question",
  "complete_agent_work",
  "apply_proposal",
  "reject_proposal",
] as const;

describe("buildAgentTools contract-tool provisioning", () => {
  test("default grants (read+capture+resolve+converse): contract tools present, author tools absent", () => {
    const tools = buildAgentTools(
      vaultAt("/tmp/x"),
      [],
      { vaultPath: "/tmp/x", modelId: "m", changes: [], capabilities: grantedCapabilities({}) },
    );
    const names = Object.keys(tools);
    expect(names).toContain("capture_note");
    expect(names).toContain("list_proposals");
    expect(names).toContain("list_agent_work");
    for (const name of CONTRACT_MUTATION_TOOLS) expect(names).toContain(name);
    expect(names).not.toContain("create_document");
    expect(names).not.toContain("edit_document");
  });

  test("with resolve withheld: settle/resolve/apply/reject absent, capture + list_proposals remain", () => {
    const tools = buildAgentTools(
      vaultAt("/tmp/x"),
      [],
      actionCtx("/tmp/x", ["read", "capture", "converse"]),
    );
    const names = Object.keys(tools);
    for (const name of CONTRACT_MUTATION_TOOLS) expect(names).not.toContain(name);
    expect(names).toContain("capture_note");
    expect(names).toContain("list_proposals"); // needs only `read`
    expect(names).toContain("list_agent_work");
  });

  test("with no action context, no contract tools are provisioned (read tools only)", () => {
    const names = Object.keys(buildAgentTools(vaultAt("/tmp/x"), []));
    expect(names.sort()).toEqual(["read_document", "run_view"]);
  });

  test("author alone provisions the write tools but no contract tools", () => {
    const names = Object.keys(buildAgentTools(vaultAt("/tmp/x"), [], actionCtx("/tmp/x", ["author"])));
    expect(names).toContain("create_document");
    expect(names).not.toContain("capture_note");
    expect(names).not.toContain("list_proposals");
    expect(names).not.toContain("list_agent_work");
    for (const name of CONTRACT_MUTATION_TOOLS) expect(names).not.toContain(name);
  });
});

// ----- contract-tool invocation against real vault fixtures ------------------
//
// Fixture pattern follows tests/surface/settle.test.ts: a real temp vault
// scaffolded by runInit, seeded through real git commits, never mocks.

let tempDirs: string[] = [];
const origLog = console.log;
const origErr = console.error;

beforeEach(() => {
  console.log = () => {};
  console.error = () => {};
});

afterEach(async () => {
  console.log = origLog;
  console.error = origErr;
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
  tempDirs = [];
});

async function initVault(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "dome-assistant-contract-"));
  tempDirs.push(dir);
  expect(await runInit({ path: dir })).toBe(0);
  return dir;
}

async function commitFile(vault: string, relPath: string, content: string): Promise<void> {
  await mkdir(dirname(join(vault, relPath)), { recursive: true });
  await writeFile(join(vault, relPath), content, "utf8");
  await commitSingleFileOnHead({
    path: vault,
    filepath: relPath,
    content,
    message: `fixture: ${relPath}`,
    author: { name: "fixture", email: "fixture@local" },
  });
}

async function readAtHead(vault: string, relPath: string): Promise<string> {
  const head = await resolveRef({ path: vault, ref: "HEAD" });
  const content = await readBlob({ path: vault, commit: head, filepath: relPath });
  if (content === null) throw new Error(`no blob at ${relPath}`);
  return content;
}

const exec = (tools: Record<string, unknown>, name: string, input: unknown): Promise<string> =>
  (tools[name] as { execute: (i: unknown, o: unknown) => Promise<string> }).execute(input, callOpts);

describe("assistant contract tools (invocation)", () => {
  test("capture_note captures through performCapture and appends a change", async () => {
    const vault = await initVault();
    const changes: AgentChange[] = [];
    const tools = buildAgentTools(vaultAt(vault), [], actionCtx(vault, ["capture"], changes));
    const out = await exec(tools, "capture_note", { text: "remember the milk" });
    const doc = JSON.parse(out) as { schema: string; status: string; path: string; source: string };
    expect(doc.schema).toBe("dome.capture/v1");
    expect(doc.status).toBe("captured");
    expect(doc.path).toStartWith("inbox/raw/");
    expect(doc.source).toBe("assistant");
    expect(changes).toEqual([{ path: doc.path, kind: "capture" }]);
    expect(await readAtHead(vault, doc.path)).toContain("remember the milk");
  });

  test("settle_task settles a seeded anchored task through performSettle", async () => {
    const vault = await initVault();
    const anchor = "tassistant0001";
    const origin = "wiki/projects/alpha.md";
    await commitFile(
      vault,
      origin,
      ["# Alpha", "", `- [ ] #task ship the widget ^${anchor}`, ""].join("\n"),
    );
    const changes: AgentChange[] = [];
    const tools = buildAgentTools(vaultAt(vault), [], actionCtx(vault, ["resolve"], changes));
    const out = await exec(tools, "settle_task", { blockId: anchor, disposition: "close" });
    const doc = JSON.parse(out) as { schema: string; status: string; commit: string | null };
    expect(doc.schema).toBe("dome.settle/v1");
    expect(doc.status).toBe("settled");
    expect(doc.commit).not.toBeNull();
    expect(await readAtHead(vault, origin)).toContain(`- [x] #task ship the widget ^${anchor}`);
    expect(changes).toEqual([{ path: `^${anchor}`, kind: "settle" }]);
  });

  test("settle_task on an unknown anchor reports not-found and appends no change", async () => {
    const vault = await initVault();
    const changes: AgentChange[] = [];
    const tools = buildAgentTools(vaultAt(vault), [], actionCtx(vault, ["resolve"], changes));
    const out = await exec(tools, "settle_task", { blockId: "tmissing000000", disposition: "close" });
    const doc = JSON.parse(out) as { status: string };
    expect(doc.status).toBe("not-found");
    expect(changes).toHaveLength(0);
  });

  test("list_proposals returns the dome.proposals/v1 document (empty on a fresh vault)", async () => {
    const vault = await initVault();
    const changes: AgentChange[] = [];
    const tools = buildAgentTools(vaultAt(vault), [], actionCtx(vault, ["read"], changes));
    const doc = JSON.parse(await exec(tools, "list_proposals", {})) as {
      schema: string;
      proposals: unknown[];
    };
    expect(doc.schema).toBe("dome.proposals/v1");
    expect(doc.proposals).toEqual([]);
    expect(changes).toHaveLength(0); // read tool: never a change entry
  });

  test("complete_agent_work submits only evidence actually read during the turn", async () => {
    const record = {
      id: 7,
      effect: { question: "Track it?", options: ["track", "ignore"], idempotencyKey: "k", sourceRefs: [] },
      processorId: "p",
      runId: "r",
      adoptedCommit: "c1",
      askedAt: "2026-07-06T00:00:00Z",
      answeredAt: "2026-07-06T00:00:01Z",
      answer: "track",
      answeredBy: "agent",
    };
    const completions: Array<{ evidence: ReadonlyArray<{ path: string; commit: string }> }> = [];
    const vault = {
      ...(fakeVault() as Record<string, unknown>),
      path: "/tmp/x",
      completeAgentWork: async (input: { evidence: ReadonlyArray<{ path: string; commit: string }> }) => {
        completions.push(input);
        return { kind: "completed", record, handlers: null };
      },
    } as never;
    const changes: AgentChange[] = [];
    const citations: Citation[] = [];
    const tools = buildAgentTools(vault, citations, actionCtx("/tmp/x", ["resolve"], changes));
    await exec(tools, "read_document", { path: "wiki/x.md" });
    const doc = JSON.parse(await exec(tools, "complete_agent_work", {
      questionId: 7,
      expectedRevision: "c1:r",
      answer: "track",
      reason: "The inspected page supports it.",
    })) as { status: string };
    expect(doc.status).toBe("completed");
    expect(completions[0]?.evidence).toEqual([
      expect.objectContaining({ path: "wiki/x.md", commit: "abc123" }),
    ]);
    expect(changes).toEqual([{ path: "question:7", kind: "resolve" }]);
  });

  test("apply_proposal / reject_proposal on unknown ids report not-found, no change entries", async () => {
    const vault = await initVault();
    const changes: AgentChange[] = [];
    const tools = buildAgentTools(vaultAt(vault), [], actionCtx(vault, ["resolve"], changes));
    const applied = JSON.parse(await exec(tools, "apply_proposal", { id: 999 })) as { status: string };
    expect(applied.status).toBe("not-found");
    const rejected = JSON.parse(await exec(tools, "reject_proposal", { id: 999 })) as { status: string };
    expect(rejected.status).toBe("not-found");
    expect(changes).toHaveLength(0);
  });

  test("resolve_question resolves through vault.resolve and appends a change", async () => {
    const record = {
      id: 7,
      effect: { question: "Which option?", options: ["a", "b"], idempotencyKey: "k", sourceRefs: [] },
      processorId: "p",
      runId: "r",
      adoptedCommit: "c",
      askedAt: "2026-07-06T00:00:00Z",
      answeredAt: "2026-07-06T00:00:01Z",
      answer: "a",
      answeredBy: "human",
    };
    const resolveCalls: Array<{ id: number; value: string }> = [];
    const vault = {
      ...(vaultAt("/tmp/x") as Record<string, unknown>),
      resolve: async (id: number, value: string) => {
        resolveCalls.push({ id, value });
        return { kind: "answered", record, handlers: null };
      },
    } as never;
    const changes: AgentChange[] = [];
    const tools = buildAgentTools(vault, [], actionCtx("/tmp/x", ["resolve"], changes));
    const doc = JSON.parse(await exec(tools, "resolve_question", { id: 7, value: "a" })) as {
      schema: string;
      status: string;
    };
    expect(resolveCalls).toEqual([{ id: 7, value: "a" }]);
    expect(doc.schema).toBe("dome.answer/v1");
    expect(doc.status).toBe("answered");
    expect(changes).toEqual([{ path: "question:7", kind: "resolve" }]);
  });

  test("resolve_question not-found appends no change", async () => {
    const vault = {
      ...(vaultAt("/tmp/x") as Record<string, unknown>),
      resolve: async () => ({ kind: "not-found" }),
    } as never;
    const changes: AgentChange[] = [];
    const tools = buildAgentTools(vault, [], actionCtx("/tmp/x", ["resolve"], changes));
    const doc = JSON.parse(await exec(tools, "resolve_question", { id: 99, value: "x" })) as {
      status: string;
    };
    expect(doc.status).toBe("error");
    expect(changes).toHaveLength(0);
  });
});
