// Wedge Phase 5 — tests for the Dome MCP server (`dome mcp`).
//
// Per docs/wiki/specs/mcp-surface.md, the MCP server is a thin protocol
// adapter over the same CLI command handlers the verbs use, and tool results
// are the same `dome.<verb>/v1` JSON documents the CLI emits under `--json`.
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
import { questionEffect } from "../../src/core/effect";
import { commitOid, sourceRef } from "../../src/core/source-ref";
import { openVaultRuntime } from "../../src/engine/vault-runtime";
import { add, commit, log } from "../../src/git";
import { createDomeMcpServer } from "../../src/mcp/server";
import {
  insertQuestion,
  queryQuestionRecords,
} from "../../src/projections/questions";

const REPO_ROOT = join(import.meta.dir, "..", "..");

const EXPECTED_TOOLS = [
  "brief",
  "capture",
  "check",
  "export_context",
  "query",
  "resolve",
  "status",
  "tasks",
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

// ----- The in-memory MCP session ------------------------------------------------

describe("dome mcp server (in-memory transport)", () => {
  test("initialize + tools/list expose the eight wedge tools", async () => {
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

  test("tool errors surface the CLI's JSON error payload with isError", async () => {
    const { client } = await fixture();
    const call = await callTool(client, "resolve", { id: 999_999 });
    expect(call.isError).toBe(true);
    expect(call.json.schema).toBe("dome.answer/v1");
    expect(call.json.status).toBe("error");
    expect(call.json.error).toBe("question-not-found");
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
