// Wedge Phase 5 — tests for the Dome MCP server (`dome mcp`).
//
// Per docs/wiki/specs/mcp-surface.md, the MCP server is a thin protocol
// adapter over the public `openVault` wrapper plus the CLI's data-returning
// collectors, and tool results are the same `dome.<verb>/v1` JSON documents
// the CLI emits under `--json`.
// These tests are hermetic and end-to-end by design: a real temp vault
// (runInit), real commits, a real `dome sync` adoption pass with the shipped
// bundles, and the MCP SDK's in-memory linked transport pair — no protocol
// mocking. A final smoke test runs the real `bin/dome mcp` subprocess over
// stdio.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { getAdoptedRef, getCurrentBranch } from "../../src/adopted-ref";
import { runInit } from "../../src/cli/commands/init";
import { runSync } from "../../src/cli/commands/sync";
import { resolveBundleRoots } from "../../src/cli/commands/sync-shared";
import { fileChange, questionEffect, type FileChange } from "../../src/core/effect";
import { commitOid, sourceRef } from "../../src/core/source-ref";
import { openVaultRuntime } from "../../src/engine/host/vault-runtime";
import { add, commit, log, readBlob } from "../../src/git";
import { createDomeMcpServer } from "../../src/mcp/server";
import {
  insertQuestion,
  queryQuestionRecords,
} from "../../src/projections/questions";
import { openProposalsDb } from "../../src/proposals/db";
import { enqueuePendingProposal } from "../../src/proposals/pending-proposals";

const REPO_ROOT = join(import.meta.dir, "..", "..");

const EXPECTED_TOOLS = [
  "agent_work",
  "apply_proposal",
  "attention",
  "brief",
  "capture",
  "check",
  "complete_agent_work",
  "explain",
  "export_context",
  "proposals",
  "query",
  "reject_proposal",
  "report_miss",
  "resolve",
  "run_view",
  "settle",
  "status",
  "tasks",
  "views",
];

const TEST_TIMEOUT_MS = 120_000;

// ----- Console capture (handlers print; tests stay quiet) --------------------

const origLog = console.log;
const origErr = console.error;

beforeEach(() => {
  console.log = () => {};
  console.error = () => {};
});

afterEach(() => {
  console.log = origLog;
  console.error = origErr;
});

// ----- Shared fixture ---------------------------------------------------------
//
// One vault + one connected in-memory client, built lazily by the first test
// so the heavy setup (init + commit + shipped-bundle sync) runs inside a
// test timeout. Subsequent tests reuse it; the suite reads like one scripted
// MCP session against one vault, mirroring how a harness uses the server.

function localDateString(date: Date = new Date()): string {
  const yyyy = String(date.getFullYear()).padStart(4, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

const TODAY = localDateString();
const DAILY_PATH = `wiki/dailies/${TODAY}.md`;

type Fixture = {
  readonly vault: string;
  readonly client: Client;
  readonly server: McpServer;
};

let fixturePromise: Promise<Fixture> | null = null;
let fixtureForCleanup: Fixture | null = null;

function fixture(): Promise<Fixture> {
  fixturePromise ??= buildFixture();
  return fixturePromise;
}

async function buildFixture(): Promise<Fixture> {
  const vault = mkdtempSync(join(tmpdir(), "dome-mcp-vault-"));
  expect(await runInit({ path: vault })).toBe(0);

  // Seed adopted content: a searchable wiki page and today's daily note
  // with an open task, committed as one ordinary human commit.
  await mkdir(join(vault, "wiki", "dailies"), { recursive: true });
  await writeFile(
    join(vault, "wiki", "project-omega.md"),
    "---\ntype: project\n---\n# Project Omega\n\n" +
      "Roadmap notes for the omega launch and ownership model.\n",
    "utf8",
  );
  await writeFile(
    join(vault, DAILY_PATH),
    `# ${TODAY}\n\nMorning wedgebrief marker line.\n\n## Tasks\n\n` +
      "- [ ] ship the wedge phase five\n",
    "utf8",
  );
  await add(vault, "wiki/project-omega.md");
  await add(vault, DAILY_PATH);
  await commit({ path: vault, message: "seed searchable content" });

  // Adopt with the shipped bundles — the same pass `dome sync` runs.
  expect(await runSync({ vault, quiet: true })).toBe(0);

  const server = createDomeMcpServer({ vaultPath: vault });
  const client = new Client({ name: "dome-mcp-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  const built: Fixture = { vault, client, server };
  fixtureForCleanup = built;
  return built;
}

afterAll(async () => {
  if (fixtureForCleanup !== null) {
    await fixtureForCleanup.client.close();
    await fixtureForCleanup.server.close();
    await rm(fixtureForCleanup.vault, { recursive: true, force: true });
  }
});

// ----- Tool-call helpers --------------------------------------------------------

type ToolCall = {
  readonly isError: boolean;
  readonly text: string;
  readonly json: Record<string, unknown>;
};

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolCall> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }>;
  expect(Array.isArray(content)).toBe(true);
  expect(content.length).toBe(1);
  const first = content[0];
  expect(first?.type).toBe("text");
  const text = first?.text ?? "";
  return Object.freeze({
    isError: result.isError === true,
    text,
    json: JSON.parse(text) as Record<string, unknown>,
  });
}

/**
 * Enqueue a pending proposal row directly through the Task 1 store API
 * (the engine sink is out of scope here) — mirrors
 * tests/cli/commands/proposals.test.ts's `enqueueProposal` fixture.
 */
async function enqueueProposal(
  vault: string,
  overrides: {
    readonly processorId?: string;
    readonly reason?: string;
    readonly changes: ReadonlyArray<FileChange>;
    readonly baseContents: Readonly<Record<string, string | null>>;
  },
): Promise<number> {
  const opened = await openProposalsDb({
    path: join(vault, ".dome", "state", "proposals.db"),
  });
  expect(opened.ok).toBe(true);
  if (!opened.ok) throw new Error("open failed");
  try {
    const result = enqueuePendingProposal(opened.value.db, {
      processorId: overrides.processorId ?? "dome.test.garden",
      extensionId: "test",
      runId: "run_1",
      reason: overrides.reason ?? "tidy up the note",
      changes: overrides.changes,
      sourceRefs: [sourceRef({ commit: commitOid("a".repeat(40)), path: "wiki/note.md" })],
      baseCommit: "b".repeat(40),
      baseContents: overrides.baseContents,
      createdAt: "2026-07-06T00:00:00.000Z",
    });
    expect(result.inserted).toBe(true);
    if (result.id === null) throw new Error("expected id");
    return result.id;
  } finally {
    opened.value.db.close();
  }
}

// ----- The in-memory MCP session ------------------------------------------------

describe("dome mcp server (in-memory transport)", () => {
  test("initialize + tools/list expose the shipped tools", async () => {
    const { client } = await fixture();
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    expect(names).toEqual(EXPECTED_TOOLS);
  }, TEST_TIMEOUT_MS);

  test("capture writes inbox/raw/, commits exactly that file, and returns dome.capture/v1", async () => {
    const { client, vault } = await fixture();
    const call = await callTool(client, "capture", {
      text: "Remember: demo the MCP capture loop tomorrow.",
      title: "MCP capture demo",
    });

    expect(call.isError).toBe(false);
    expect(call.json.schema).toBe("dome.capture/v1");
    expect(call.json.status).toBe("captured");
    expect(call.json.source).toBe("cli");
    const path = call.json.path as string;
    expect(path.startsWith("inbox/raw/")).toBe(true);
    expect(path.endsWith("mcp-capture-demo.md")).toBe(true);
    expect(existsSync(join(vault, path))).toBe(true);

    // Ordinary human commit, no Dome-* trailers, exactly this capture.
    const entries = await log({ path: vault, depth: 1 });
    const head = entries[0];
    expect(head?.commit.message).toContain("capture: MCP capture demo");
    expect(head?.commit.message).not.toContain("Dome-Run");

    // The CLI payload reports compile state for the caller.
    expect(call.json.compile_pending).toBe(true);
    expect(call.json.serve_status).toBe("off");
  }, TEST_TIMEOUT_MS);

  test("query returns FTS hits with source refs after a sync", async () => {
    const { client, vault } = await fixture();
    // Adopt the capture from the previous test too, then recall.
    expect(await runSync({ vault, quiet: true })).toBe(0);

    const call = await callTool(client, "query", { text: "omega launch" });
    expect(call.isError).toBe(false);
    expect(call.json.query).toBe("omega launch");
    const matches = call.json.matches as Array<Record<string, unknown>>;
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.map((m) => m.path)).toContain("wiki/project-omega.md");
    const sourceRefs = matches[0]?.sourceRefs as Array<Record<string, unknown>>;
    expect(sourceRefs.length).toBeGreaterThan(0);
    expect(typeof sourceRefs[0]?.commit).toBe("string");
  }, TEST_TIMEOUT_MS);

  test("views discovers plugins and run_view invokes one without a named adapter", async () => {
    const { client } = await fixture();
    const discovered = await callTool(client, "views");
    expect(discovered.isError).toBe(false);
    expect(discovered.json.schema).toBe("dome.views/v1");
    expect(
      (discovered.json.views as Array<Record<string, unknown>>)
        .some((view) => view.command === "query"),
    ).toBe(true);

    const run = await callTool(client, "run_view", {
      command: "query",
      input: { text: "omega", limit: 3 },
    });
    expect(run.isError).toBe(false);
    expect(run.json).toMatchObject({
      schema: "dome.view-run/v1",
      status: "ok",
      command: "query",
    });
  }, TEST_TIMEOUT_MS);

  test("run_view reports an absent plugin command as a tool error", async () => {
    const { client } = await fixture();
    const run = await callTool(client, "run_view", { command: "not-installed" });
    expect(run.isError).toBe(true);
    expect(run.json).toMatchObject({
      schema: "dome.view-run/v1",
      status: "error",
      error: "view-not-found",
    });
  }, TEST_TIMEOUT_MS);

  test("export_context returns the dome.search.export-context/v1 packet", async () => {
    const { client } = await fixture();
    const call = await callTool(client, "export_context", { topic: "omega" });
    expect(call.isError).toBe(false);
    expect(typeof call.json.markdown).toBe("string");
    expect(call.json.markdown as string).toContain("omega");
  }, TEST_TIMEOUT_MS);

  test("status mirrors the dome status --json snapshot shape", async () => {
    const { client, vault } = await fixture();
    const call = await callTool(client, "status");
    expect(call.isError).toBe(false);
    expect(call.json.vault).toBe(vault);
    expect(typeof call.json.branch).toBe("string");
    expect(typeof call.json.attention_required).toBe("boolean");
    expect(Array.isArray(call.json.attention)).toBe(true);
    expect(Array.isArray(call.json.next_actions)).toBe(true);
    expect(call.json.serve_status).toBe("off");
    expect(typeof call.json.inbox_raw_pages).toBe("number");
  }, TEST_TIMEOUT_MS);

  test("attention returns the canonical derived owner queue", async () => {
    const { client } = await fixture();
    const call = await callTool(client, "attention");
    expect(call.isError).toBe(false);
    expect(call.json.schema).toBe("dome.attention/v1");
    expect(Array.isArray(call.json.primary)).toBe(true);
    expect(Array.isArray(call.json.backlog)).toBe(true);
    expect(typeof call.json.agentWorkCount).toBe("number");
  }, TEST_TIMEOUT_MS);

  test("check returns the dome.check/v1 report", async () => {
    const { client } = await fixture();
    const call = await callTool(client, "check");
    expect(call.isError).toBe(false);
    expect(call.json.schema).toBe("dome.check/v1");
    expect(call.json.status === "ok" || call.json.status === "attention").toBe(
      true,
    );
    expect(call.json.scopes).toEqual({
      engine: true,
      content: true,
      decisions: true,
    });
  }, TEST_TIMEOUT_MS);

  test("explain returns the dome.explain/v1 provenance chain for an adopted page", async () => {
    const { client } = await fixture();
    const call = await callTool(client, "explain", {
      target: "wiki/project-omega.md",
    });
    expect(call.isError).toBe(false);
    expect(call.json.schema).toBe("dome.explain/v1");
    expect(call.json.path).toBe("wiki/project-omega.md");
    expect(call.json.anchor).toBeNull();
    expect(call.json.claim).toBeNull();
    // A page with no facts still explains (graceful degrade); the deep
    // claim/fact/run assertions live in tests/cli/commands/explain.test.ts.
    expect(Array.isArray(call.json.facts)).toBe(true);
    expect(Array.isArray(call.json.runs)).toBe(true);
    const commits = call.json.commits as Array<Record<string, unknown>>;
    expect(commits.length).toBeGreaterThan(0);
    expect(typeof commits[0]?.sha).toBe("string");
  }, TEST_TIMEOUT_MS);

  test("explain of a path absent from adopted state is a command error", async () => {
    const { client } = await fixture();
    const call = await callTool(client, "explain", {
      target: "wiki/does-not-exist.md",
    });
    expect(call.isError).toBe(true);
    expect(call.json.schema).toBe("dome.command-error/v1");
    expect(call.json.command).toBe("explain");
    expect(call.json.error).toBe("unknown-path");
  }, TEST_TIMEOUT_MS);

  test("tasks returns the dome.daily.today/v1 open-loop view", async () => {
    const { client } = await fixture();
    const call = await callTool(client, "tasks", { date: TODAY });
    expect(call.isError).toBe(false);
    expect(call.json.schema).toBe("dome.daily.today/v1");
    expect(call.json.date).toBe(TODAY);
    const counts = call.json.counts as Record<string, number>;
    expect(counts.openTasks).toBeGreaterThan(0);
    const openTasks = call.json.openTasks as Array<Record<string, unknown>>;
    expect(
      openTasks.some((task) =>
        String(task.text).includes("ship the wedge phase five")
      ),
    ).toBe(true);
  }, TEST_TIMEOUT_MS);

  test("brief returns today's daily note content at the adopted commit", async () => {
    const { client } = await fixture();
    const call = await callTool(client, "brief", { date: TODAY });
    expect(call.isError).toBe(false);
    expect(call.json.schema).toBe("dome.mcp.brief/v1");
    expect(call.json.date).toBe(TODAY);
    expect(call.json.path).toBe(DAILY_PATH);
    expect(call.json.exists).toBe(true);
    expect(call.json.content as string).toContain("wedgebrief marker line");
    expect(call.json.content as string).toContain("ship the wedge phase five");
  }, TEST_TIMEOUT_MS);

  test("brief reports a missing daily note instead of failing", async () => {
    const { client } = await fixture();
    const call = await callTool(client, "brief", { date: "1999-01-01" });
    expect(call.isError).toBe(false);
    expect(call.json.exists).toBe(false);
    expect(call.json.content).toBeNull();
  }, TEST_TIMEOUT_MS);

  test("resolve reads and answers a question through the answers.db path", async () => {
    const { client, vault } = await fixture();

    // Seed a durable question the way a processor would have left it.
    const branch = await getCurrentBranch(vault);
    expect(branch).not.toBeNull();
    const adopted = await getAdoptedRef(vault, branch ?? "main");
    expect(adopted).not.toBeNull();
    const runtimeResult = await openVaultRuntime({
      vaultPath: vault,
      ...resolveBundleRoots({ vaultPath: vault }),
    });
    expect(runtimeResult.ok).toBe(true);
    if (!runtimeResult.ok) throw new Error("openVaultRuntime failed");
    const runtime = runtimeResult.value;
    let questionId: number;
    try {
      insertQuestion(runtime.projectionDb, {
        effect: questionEffect({
          question: "Adopt the MCP wedge surface?",
          options: ["yes", "no"],
          sourceRefs: [
            sourceRef({
              commit: commitOid(adopted ?? ""),
              path: ".dome/config.yaml",
            }),
          ],
          idempotencyKey: "test.mcp:resolve-roundtrip",
        }),
        processorId: "test.mcp.ask",
        runId: "run-test-mcp",
        adoptedCommit: commitOid(adopted ?? ""),
      });
      const record = queryQuestionRecords(runtime.projectionDb, {
        resolved: false,
      }).find((row) => row.effect.question === "Adopt the MCP wedge surface?");
      expect(record).toBeDefined();
      questionId = record?.id ?? 0;
    } finally {
      await runtime.close();
    }

    // Read it (no value) — dome.answer/v1, status open.
    const read = await callTool(client, "resolve", { id: questionId });
    expect(read.isError).toBe(false);
    expect(read.json.schema).toBe("dome.answer/v1");
    expect(read.json.status).toBe("open");

    // Answer it — recorded durably, same as `dome resolve <id> yes`.
    const answered = await callTool(client, "resolve", {
      id: questionId,
      value: "yes",
    });
    expect(answered.isError).toBe(false);
    expect(answered.json.schema).toBe("dome.answer/v1");
    expect(answered.json.status).toBe("answered");
    const question = answered.json.question as Record<string, unknown>;
    expect(question.answer).toBe("yes");
  }, TEST_TIMEOUT_MS);

  test("agent_work compiles and completes a source-backed packet", async () => {
    const { client, vault } = await fixture();
    const branch = await getCurrentBranch(vault);
    const adopted = branch === null ? null : await getAdoptedRef(vault, branch);
    expect(adopted).not.toBeNull();
    if (adopted === null) return;
    const evidence = sourceRef({
      commit: commitOid(adopted),
      path: "wiki/project-omega.md",
    });
    const runtimeResult = await openVaultRuntime({
      vaultPath: vault,
      ...resolveBundleRoots({ vaultPath: vault }),
    });
    expect(runtimeResult.ok).toBe(true);
    if (!runtimeResult.ok) return;
    insertQuestion(runtimeResult.value.projectionDb, {
      effect: questionEffect({
        question: "Track the MCP evidence-backed follow-up?",
        options: ["track", "ignore"],
        sourceRefs: [evidence],
        idempotencyKey: "test.mcp:agent-work",
        metadata: {
          resolutionMode: "dispatch",
          automationPolicy: "agent-safe",
          risk: "low",
        },
      }),
      processorId: "test.mcp.agent-work",
      runId: "run-test-mcp-agent-work",
      adoptedCommit: commitOid(adopted),
    });
    await runtimeResult.value.close();

    const listed = await callTool(client, "agent_work");
    expect(listed.isError).toBe(false);
    expect(listed.json.schema).toBe("dome.agent-work/v1");
    const item = (listed.json.items as Array<Record<string, unknown>>).find(
      (row) => row.question === "Track the MCP evidence-backed follow-up?",
    );
    expect(item).toBeDefined();
    if (item === undefined) return;

    const completed = await callTool(client, "complete_agent_work", {
      questionId: item.questionId,
      expectedRevision: item.revision,
      answer: "track",
      reason: "The adopted project page contains the relevant follow-up context.",
      evidence: [evidence],
    });
    expect(completed.isError).toBe(false);
    expect(completed.json.status).toBe("completed");
    expect((completed.json.question as Record<string, unknown>).answered_by).toBe("agent");
  }, TEST_TIMEOUT_MS);

  test("tool errors surface the CLI's JSON error payload with isError", async () => {
    const { client } = await fixture();
    const call = await callTool(client, "resolve", { id: 999_999 });
    expect(call.isError).toBe(true);
    expect(call.json.schema).toBe("dome.answer/v1");
    expect(call.json.status).toBe("error");
    expect(call.json.error).toBe("question-not-found");
  }, TEST_TIMEOUT_MS);

  test("settle closes a task line by block-anchor and commits exactly that file", async () => {
    const { client, vault } = await fixture();
    const anchor = "tmcpsettle1";
    const taskPath = "wiki/projects/mcp-settle.md";
    const content = `# MCP settle fixture\n\n- [ ] #task ship the mcp settle tool ^${anchor}\n`;
    await mkdir(join(vault, "wiki", "projects"), { recursive: true });
    await writeFile(join(vault, taskPath), content, "utf8");
    await add(vault, taskPath);
    await commit({ path: vault, message: "fixture: mcp-settle task" });

    const call = await callTool(client, "settle", {
      blockId: anchor,
      disposition: "close",
    });
    expect(call.isError).toBe(false);
    expect(call.json.schema).toBe("dome.settle/v1");
    expect(call.json.status).toBe("settled");
    expect(call.json.block_id).toBe(anchor);
    expect(call.json.disposition).toBe("close");
    expect(typeof call.json.commit).toBe("string");

    const entries = await log({ path: vault, depth: 1 });
    expect(entries[0]?.commit.message).toContain("settle(close):");
  }, TEST_TIMEOUT_MS);

  test("settle keep settles without a commit", async () => {
    const { client, vault } = await fixture();
    const anchor = "tmcpsettle2";
    const taskPath = "wiki/projects/mcp-settle-keep.md";
    const content = `- [ ] #task keep me ^${anchor}\n`;
    await mkdir(join(vault, "wiki", "projects"), { recursive: true });
    await writeFile(join(vault, taskPath), content, "utf8");
    await add(vault, taskPath);
    await commit({ path: vault, message: "fixture: mcp-settle keep task" });
    const before = await log({ path: vault, depth: 1 });

    const call = await callTool(client, "settle", {
      blockId: anchor,
      disposition: "keep",
    });
    expect(call.isError).toBe(false);
    expect(call.json.status).toBe("settled");
    expect(call.json.commit).toBeNull();

    const after = await log({ path: vault, depth: 1 });
    expect(after[0]?.oid).toBe(before[0]?.oid);
  }, TEST_TIMEOUT_MS);

  test("settle of an unknown blockId is a tool error with dome.settle/v1 not-found", async () => {
    const { client } = await fixture();
    const call = await callTool(client, "settle", {
      blockId: "tnosuchanchor",
      disposition: "close",
    });
    expect(call.isError).toBe(true);
    expect(call.json.schema).toBe("dome.settle/v1");
    expect(call.json.status).toBe("not-found");
  }, TEST_TIMEOUT_MS);

  test("proposals lists a pending row as dome.proposals/v1", async () => {
    const { client, vault } = await fixture();
    await mkdir(join(vault, "wiki"), { recursive: true });
    await writeFile(join(vault, "wiki/mcp-proposal.md"), "line1\n", "utf8");
    await add(vault, "wiki/mcp-proposal.md");
    await commit({ path: vault, message: "fixture: mcp-proposal note" });
    const id = await enqueueProposal(vault, {
      changes: [fileChange({ kind: "write", path: "wiki/mcp-proposal.md", content: "line1\nline2\n" })],
      baseContents: { "wiki/mcp-proposal.md": "line1\n" },
    });

    const call = await callTool(client, "proposals");
    expect(call.isError).toBe(false);
    expect(call.json.schema).toBe("dome.proposals/v1");
    const proposals = call.json.proposals as Array<Record<string, unknown>>;
    expect(proposals.some((p) => p.id === id && p.status === "pending")).toBe(true);
  }, TEST_TIMEOUT_MS);

  test("proposals all=true includes decided rows; default is pending-only", async () => {
    const { client, vault } = await fixture();
    await mkdir(join(vault, "wiki"), { recursive: true });
    await writeFile(join(vault, "wiki/mcp-proposal2.md"), "line1\n", "utf8");
    await add(vault, "wiki/mcp-proposal2.md");
    await commit({ path: vault, message: "fixture: mcp-proposal2 note" });
    const id = await enqueueProposal(vault, {
      changes: [fileChange({ kind: "write", path: "wiki/mcp-proposal2.md", content: "line1\nline2\n" })],
      baseContents: { "wiki/mcp-proposal2.md": "line1\n" },
    });
    const rejected = await callTool(client, "reject_proposal", { id });
    expect(rejected.isError).toBe(false);

    const pendingOnly = await callTool(client, "proposals");
    expect((pendingOnly.json.proposals as unknown[]).some((p) => (p as { id: number }).id === id)).toBe(false);

    const all = await callTool(client, "proposals", { all: true });
    const rows = all.json.proposals as Array<Record<string, unknown>>;
    expect(rows.some((p) => p.id === id && p.status === "rejected")).toBe(true);
  }, TEST_TIMEOUT_MS);

  test("apply_proposal applies a pending proposal, writes the file, and commits", async () => {
    const { client, vault } = await fixture();
    await mkdir(join(vault, "wiki"), { recursive: true });
    await writeFile(join(vault, "wiki/mcp-apply.md"), "line1\n", "utf8");
    await add(vault, "wiki/mcp-apply.md");
    await commit({ path: vault, message: "fixture: mcp-apply note" });
    const id = await enqueueProposal(vault, {
      changes: [fileChange({ kind: "write", path: "wiki/mcp-apply.md", content: "line1\nline2\n" })],
      baseContents: { "wiki/mcp-apply.md": "line1\n" },
    });

    const call = await callTool(client, "apply_proposal", { id });
    expect(call.isError).toBe(false);
    expect(call.json.schema).toBe("dome.apply/v1");
    expect(call.json.status).toBe("applied");
    expect(call.json.id).toBe(id);

    const entries = await log({ path: vault, depth: 1 });
    expect(entries[0]?.commit.message).toContain(`apply(P${id}):`);
  }, TEST_TIMEOUT_MS);

  test("apply_proposal of an unknown id is a tool error with dome.apply/v1 not-found", async () => {
    const { client } = await fixture();
    const call = await callTool(client, "apply_proposal", { id: 999_999 });
    expect(call.isError).toBe(true);
    expect(call.json.schema).toBe("dome.apply/v1");
    expect(call.json.status).toBe("not-found");
  }, TEST_TIMEOUT_MS);

  test("apply_proposal of a stale proposal is a tool error with dome.apply/v1 stale", async () => {
    const { client, vault } = await fixture();
    await mkdir(join(vault, "wiki"), { recursive: true });
    await writeFile(join(vault, "wiki/mcp-apply-stale.md"), "line1\n", "utf8");
    await add(vault, "wiki/mcp-apply-stale.md");
    await commit({ path: vault, message: "fixture: mcp-apply-stale note" });
    const id = await enqueueProposal(vault, {
      changes: [fileChange({ kind: "write", path: "wiki/mcp-apply-stale.md", content: "line1\nline2\n" })],
      baseContents: { "wiki/mcp-apply-stale.md": "line1\n" },
    });
    await writeFile(join(vault, "wiki/mcp-apply-stale.md"), "drifted\n", "utf8");

    const call = await callTool(client, "apply_proposal", { id });
    expect(call.isError).toBe(true);
    expect(call.json.schema).toBe("dome.apply/v1");
    expect(call.json.status).toBe("stale");
  }, TEST_TIMEOUT_MS);

  test("reject_proposal rejects a pending proposal and lands no commit", async () => {
    const { client, vault } = await fixture();
    await mkdir(join(vault, "wiki"), { recursive: true });
    await writeFile(join(vault, "wiki/mcp-reject.md"), "line1\n", "utf8");
    await add(vault, "wiki/mcp-reject.md");
    await commit({ path: vault, message: "fixture: mcp-reject note" });
    const id = await enqueueProposal(vault, {
      changes: [fileChange({ kind: "write", path: "wiki/mcp-reject.md", content: "line1\nline2\n" })],
      baseContents: { "wiki/mcp-reject.md": "line1\n" },
    });
    const before = await log({ path: vault, depth: 1 });

    const call = await callTool(client, "reject_proposal", { id, note: "not needed" });
    expect(call.isError).toBe(false);
    expect(call.json.schema).toBe("dome.reject/v1");
    expect(call.json.status).toBe("rejected");
    expect(call.json.id).toBe(id);

    const after = await log({ path: vault, depth: 1 });
    expect(after[0]?.oid).toBe(before[0]?.oid);
  }, TEST_TIMEOUT_MS);

  test("reject_proposal twice on the same id is a tool error with dome.reject/v1 not-pending", async () => {
    const { client, vault } = await fixture();
    await mkdir(join(vault, "wiki"), { recursive: true });
    await writeFile(join(vault, "wiki/mcp-double-reject.md"), "line1\n", "utf8");
    await add(vault, "wiki/mcp-double-reject.md");
    await commit({ path: vault, message: "fixture: mcp-double-reject note" });
    const id = await enqueueProposal(vault, {
      changes: [fileChange({ kind: "write", path: "wiki/mcp-double-reject.md", content: "line1\nline2\n" })],
      baseContents: { "wiki/mcp-double-reject.md": "line1\n" },
    });
    expect((await callTool(client, "reject_proposal", { id })).isError).toBe(false);

    const call = await callTool(client, "reject_proposal", { id });
    expect(call.isError).toBe(true);
    expect(call.json.schema).toBe("dome.reject/v1");
    expect(call.json.status).toBe("not-pending");
  }, TEST_TIMEOUT_MS);

  test("report_miss appends a grammar-exact entry to meta/retrieval-misses.md and commits", async () => {
    const { client, vault } = await fixture();

    const call = await callTool(client, "report_miss", {
      query: "mcp report_miss fixture query",
      note: "the tool test note",
    });
    expect(call.isError).toBe(false);
    expect(call.json.schema).toBe("dome.report-miss/v1");
    expect(call.json.status).toBe("recorded");
    expect(typeof call.json.commit).toBe("string");

    const entries = await log({ path: vault, depth: 1 });
    expect(entries[0]?.oid).toBe(call.json.commit as string);
    expect(entries[0]?.commit.message).toContain(
      "miss: mcp report_miss fixture query",
    );

    const misses = await readBlob({
      path: vault,
      commit: entries[0]!.oid,
      filepath: "meta/retrieval-misses.md",
    });
    expect(misses).not.toBeNull();
    expect(misses).toMatch(
      /^- \d{4}-\d{2}-\d{2} — "mcp report_miss fixture query" — the tool test note$/m,
    );
  }, TEST_TIMEOUT_MS);

  test("report_miss note defaults to 'no note' when omitted", async () => {
    const { client, vault } = await fixture();

    const call = await callTool(client, "report_miss", {
      query: "mcp report_miss no-note fixture",
    });
    expect(call.isError).toBe(false);
    expect(call.json.status).toBe("recorded");

    const head = await log({ path: vault, depth: 1 });
    const misses = await readBlob({
      path: vault,
      commit: head[0]!.oid,
      filepath: "meta/retrieval-misses.md",
    });
    expect(misses).toContain(
      '"mcp report_miss no-note fixture" — no note',
    );
  }, TEST_TIMEOUT_MS);

  test("overlapping tool calls serialize through the mutex; both results parse cleanly", async () => {
    // The MCP SDK does NOT serialize tool calls; the tool mutex is the fence
    // keeping at most one VaultRuntime open against the vault's SQLite files
    // at a time. Fire two calls without awaiting the first and assert both
    // produce clean, well-formed JSON payloads (callTool JSON.parses each).
    const { client } = await fixture();
    const [status, query] = await Promise.all([
      callTool(client, "status"),
      callTool(client, "query", { text: "omega launch" }),
    ]);
    expect(status.isError).toBe(false);
    expect(typeof status.json.branch).toBe("string");
    expect(query.isError).toBe(false);
    expect(query.json.query).toBe("omega launch");
    const matches = query.json.matches as Array<Record<string, unknown>>;
    expect(matches.map((m) => m.path)).toContain("wiki/project-omega.md");
  }, TEST_TIMEOUT_MS);

  test("query against a vault with no adopted ref returns a graceful JSON error, not a crash", async () => {
    // A vault straight out of `dome init` (no sync) has no adopted ref and
    // an empty projection index. The tool must return the CLI's structured
    // error payload — never a thrown protocol error.
    const vault = mkdtempSync(join(tmpdir(), "dome-mcp-empty-vault-"));
    const server = createDomeMcpServer({ vaultPath: vault });
    const client = new Client({ name: "dome-mcp-empty-test", version: "0.0.0" });
    try {
      expect(await runInit({ path: vault })).toBe(0);
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await Promise.all([
        client.connect(clientTransport),
        server.connect(serverTransport),
      ]);
      const call = await callTool(client, "query", { text: "anything" });
      expect(call.isError).toBe(true);
      expect(call.json.status).toBe("error");
      expect(String(call.json.message)).toContain("no adopted ref");
    } finally {
      await client.close();
      await server.close();
      await rm(vault, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);
});

describe("policy-open failures", () => {
  test("status preserves actionable content-scope policy detail", async () => {
    const vault = mkdtempSync(join(tmpdir(), "dome-mcp-policy-error-"));
    const server = createDomeMcpServer({ vaultPath: vault });
    const client = new Client({ name: "dome-mcp-policy-test", version: "0.0.0" });
    try {
      expect(await runInit({ path: vault })).toBe(0);
      const secret = "mcp-vault-secret-b8a1";
      await writeFile(
        join(vault, ".dome", "config.yaml"),
        `${secret}: [\n\u0001`,
        "utf8",
      );
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await Promise.all([
        client.connect(clientTransport),
        server.connect(serverTransport),
      ]);
      const call = await callTool(client, "status");
      expect(call.isError).toBe(true);
      expect(call.json.error).toBe("capability-policy-load-failed");
      expect(String(call.json.message)).toContain(".dome/config.yaml is invalid");
      expect(String(call.json.message)).toContain(
        "Repair `.dome/config.yaml` and `.dome/content-scope.yaml`, then retry.",
      );
      expect(String(call.json.message)).not.toContain(vault);
      expect(String(call.json.message)).not.toContain(secret);
      expect(String(call.json.message)).not.toMatch(/[\r\n\u0000-\u001f\u007f]/);
    } finally {
      await client.close();
      await server.close();
      await rm(vault, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);
});

// ----- The stdio smoke session ----------------------------------------------------
//
// A scripted real-process session: spawn `bin/dome mcp --vault <vault>`,
// initialize, list tools, call one tool — proving the Commander wiring, the
// dynamic import, and stdout protocol discipline (handler JSON must arrive
// as a tool result, not as protocol-corrupting stray output).

describe("dome mcp server (stdio transport)", () => {
  test("bin/dome mcp serves initialize → tools/list → tools/call over stdio", async () => {
    const { vault } = await fixture();
    const transport = new StdioClientTransport({
      command: "bun",
      args: [join(REPO_ROOT, "bin", "dome"), "mcp", "--vault", vault],
    });
    const client = new Client({ name: "dome-mcp-stdio-test", version: "0.0.0" });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual(
        EXPECTED_TOOLS,
      );

      const call = await callTool(client, "status");
      expect(call.isError).toBe(false);
      expect(call.json.vault).toBe(vault);
    } finally {
      await client.close();
    }
  }, TEST_TIMEOUT_MS);

  test("dome mcp exits cleanly when the client disconnects immediately (no shutdown hang)", async () => {
    // The onclose handler must be registered BEFORE connect: an instant
    // disconnect (stdin EOF during/right after the handshake) would
    // otherwise fire onclose before the handler exists and hang forever.
    const { vault } = await fixture();
    const proc = Bun.spawn(
      ["bun", join(REPO_ROOT, "bin", "dome"), "mcp", "--vault", vault],
      { stdout: "pipe", stderr: "pipe", stdin: "pipe" },
    );
    proc.stdin.end(); // immediate EOF — no handshake at all
    const exited = await Promise.race([
      proc.exited,
      new Promise<"hang">((done) => setTimeout(() => done("hang"), 30_000)),
    ]);
    if (exited === "hang") proc.kill();
    expect(exited).toBe(0);
  }, TEST_TIMEOUT_MS);

  test("dome mcp refuses an uninitialized vault", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dome-mcp-not-a-vault-"));
    try {
      const proc = Bun.spawn(
        ["bun", join(REPO_ROOT, "bin", "dome"), "mcp", "--vault", dir],
        { stdout: "pipe", stderr: "pipe", stdin: "pipe" },
      );
      const exitCode = await proc.exited;
      const stderr = await new Response(proc.stderr).text();
      expect(exitCode).toBe(64);
      expect(stderr).toContain("not an initialized Dome vault");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);
});
