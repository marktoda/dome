// The Dome HTTP surface (`dome http`) — the read+capture protocol adapter
// over the public `openVault` wrapper, per docs/wiki/specs/http-surface.md.
//
// Hermetic and end-to-end by design (same posture as tests/mcp): a real temp
// vault (runInit), real commits, a real adoption pass with the shipped
// bundles, and real HTTP over a loopback Bun.serve on an ephemeral port.
// Every route requires the bearer token; results are the same JSON documents
// the CLI emits under --json (plus two http-minted envelopes for documents
// and question lists).

import { afterAll, beforeEach, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runInit } from "../../src/cli/commands/init";
import { runSync } from "../../src/cli/commands/sync";
import { resolveBundleRoots } from "../../src/cli/commands/sync-shared";
import { fileChange, questionEffect, type FileChange } from "../../src/core/effect";
import { commitOid, sourceRef } from "../../src/core/source-ref";
import { openVaultRuntime } from "../../src/engine/host/vault-runtime";
import { commitSingleFileOnHead, log } from "../../src/git";
import { createDomeHttpServer } from "../../src/http/server";
import { insertQuestion, queryQuestionRecords } from "../../src/projections/questions";
import { openProposalsDb } from "../../src/proposals/db";
import { enqueuePendingProposal } from "../../src/proposals/pending-proposals";

const TEST_TIMEOUT_MS = 120_000;
const TOKEN = "test-relay-token";

describe("closed PWA static root", () => {
  test("serves only GenerateSW output with explicit cache policy", async () => {
    const staticDir = mkdtempSync(join(tmpdir(), "dome-http-static-"));
    try {
      await mkdir(join(staticDir, "assets"), { recursive: true });
      await Promise.all([
        writeFile(join(staticDir, "index.html"), "<main>Dome</main>"),
        writeFile(join(staticDir, "manifest.webmanifest"), "{}"),
        writeFile(join(staticDir, "sw.js"), "self.addEventListener('fetch',()=>{})"),
        writeFile(join(staticDir, "workbox-1234abcd.js"), "workbox"),
        writeFile(join(staticDir, "assets", "index-AbCd1234.js"), "app"),
        writeFile(join(staticDir, "assets", "plain.js"), "not public"),
        writeFile(join(staticDir, "assets", "image-AbCd1234.png"), "not a generated extension"),
        writeFile(join(staticDir, "robots.txt"), "not public"),
      ]);
      await symlink("index-AbCd1234.js", join(staticDir, "assets", "linked-AbCd1234.js"));
      const handler = createDomeHttpServer({ vaultPath: "/unused", token: TOKEN, staticDir });
      for (const path of ["/", "/index.html", "/manifest.webmanifest", "/sw.js"]) {
        const response = await handler.fetch(new Request(`http://localhost${path}`));
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-cache");
      }
      const worker = await handler.fetch(new Request("http://localhost/sw.js"));
      expect(worker.headers.get("service-worker-allowed")).toBe("/");
      for (const path of ["/workbox-1234abcd.js", "/assets/index-AbCd1234.js"]) {
        const response = await handler.fetch(new Request(`http://localhost${path}`));
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      }
      for (const path of ["/robots.txt", "/assets/plain.js", "/assets/image-AbCd1234.png", "/assets/nested/index-AbCd1234.js", "/readyz"]) {
        const response = await handler.fetch(new Request(`http://localhost${path}`));
        expect(response.status).toBe(401);
        expect(response.headers.get("cache-control")).toBeNull();
      }
      expect((await handler.fetch(new Request("http://localhost/assets/missing-AbCd1234.js"))).status).toBe(404);
      expect((await handler.fetch(new Request("http://localhost/assets/linked-AbCd1234.js"))).status).toBe(404);
      await handler.close();
    } finally {
      await rm(staticDir, { recursive: true, force: true });
    }
  });
});

// ----- Console capture (runInit/runSync print; tests stay quiet) ---------------

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

// ----- Shared fixture -----------------------------------------------------------

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
  readonly baseUrl: string;
  readonly server: ReturnType<typeof Bun.serve>;
};

let fixturePromise: Promise<Fixture> | null = null;
let fixtureForCleanup: Fixture | null = null;

function fixture(): Promise<Fixture> {
  fixturePromise ??= buildFixture();
  return fixturePromise;
}

async function buildFixture(): Promise<Fixture> {
  const vault = mkdtempSync(join(tmpdir(), "dome-http-vault-"));
  expect(await runInit({ path: vault })).toBe(0);

  await mkdir(join(vault, "wiki", "dailies"), { recursive: true });
  await writeFile(
    join(vault, "wiki", "project-omega.md"),
    "---\ntype: project\n---\n# Project Omega\n\n" +
      "Roadmap notes for the omega launch and ownership model.\n",
    "utf8",
  );
  await writeFile(
    join(vault, DAILY_PATH),
    `# ${TODAY}\n\n## Tasks\n\n- [ ] ship the http surface\n`,
    "utf8",
  );
  const { add, commit } = await import("../../src/git");
  await add(vault, "wiki/project-omega.md");
  await add(vault, DAILY_PATH);
  await commit({ path: vault, message: "seed searchable content" });
  expect(await runSync({ vault, quiet: true })).toBe(0);

  const handler = createDomeHttpServer({ vaultPath: vault, token: TOKEN });
  const server = Bun.serve({ port: 0, fetch: handler.fetch });
  const built: Fixture = {
    vault,
    baseUrl: `http://127.0.0.1:${server.port}`,
    server,
  };
  fixtureForCleanup = built;
  return built;
}

afterAll(async () => {
  if (fixtureForCleanup !== null) {
    fixtureForCleanup.server.stop(true);
    await rm(fixtureForCleanup.vault, { recursive: true, force: true });
  }
});

// ----- Request helpers ------------------------------------------------------------

async function get(path: string, token: string | null = TOKEN) {
  const f = await fixture();
  const res = await fetch(`${f.baseUrl}${path}`, {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
  return { status: res.status, json: await jsonOf(res) };
}

async function post(path: string, body: unknown, token: string | null = TOKEN) {
  const f = await fixture();
  const res = await fetch(`${f.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await jsonOf(res) };
}

async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  return JSON.parse(text) as Record<string, unknown>;
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

// ----- Auth ------------------------------------------------------------------------

describe("auth", () => {
  test(
    "every route requires the bearer token",
    async () => {
      expect((await get("/status", null)).status).toBe(401);
      expect((await get("/status", "wrong-token")).status).toBe(401);
      expect((await post("/capture", { text: "x" }, null)).status).toBe(401);
      expect(
        (await post("/settle", { blockId: "x", disposition: "close" }, null)).status,
      ).toBe(401);
      expect((await get("/proposals", null)).status).toBe(401);
      expect((await get("/attention", null)).status).toBe(401);
      expect((await get("/agent-work", null)).status).toBe(401);
      expect((await post("/agent-work/complete", {}, null)).status).toBe(401);
      expect((await post("/agent-work/drain", {}, null)).status).toBe(401);
      expect((await post("/apply", { id: 1 }, null)).status).toBe(401);
      expect((await post("/reject", { id: 1 }, null)).status).toBe(401);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the root route answers an authed identity document",
    async () => {
      const { status, json } = await get("/");
      expect(status).toBe(200);
      expect(json.schema).toBe("dome.http/v1");
      expect(typeof json.vault).toBe("string");
    },
    TEST_TIMEOUT_MS,
  );
});

// ----- Capture (the remote-capture seam) ---------------------------------------------

describe("POST /capture", () => {
  test(
    "captures with source http and commits exactly that file",
    async () => {
      const f = await fixture();
      const { status, json } = await post("/capture", {
        text: "Remember: demo the phone capture loop.",
        title: "phone capture demo",
      });

      expect(status).toBe(200);
      expect(json.schema).toBe("dome.capture/v1");
      expect(json.status).toBe("captured");
      expect(json.source).toBe("http");
      expect(String(json.path).startsWith("inbox/raw/")).toBe(true);

      const entries = await log({ path: f.vault, depth: 1 });
      expect(entries[0]?.commit.message).toContain("capture: phone capture demo");
      expect(entries[0]?.commit.message).not.toContain("Dome-Run");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a retry with the same captureId answers duplicate",
    async () => {
      const first = await post("/capture", {
        text: "mumbled at 11pm",
        captureId: "ios-shortcut-42",
      });
      expect(first.status).toBe(200);
      expect(first.json.status).toBe("captured");

      const retry = await post("/capture", {
        text: "mumbled at 11pm",
        captureId: "ios-shortcut-42",
      });
      expect(retry.status).toBe(200);
      expect(retry.json.status).toBe("duplicate");
      expect(retry.json.path).toBe(first.json.path);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "rejects a body without text",
    async () => {
      const { status, json } = await post("/capture", { title: "no text" });
      expect(status).toBe(400);
      expect(json.status).toBe("error");
    },
    TEST_TIMEOUT_MS,
  );
});

// ----- Settle (the second commit-or-nothing seam) -------------------------------------
//
// performSettle reads/writes the working tree + HEAD directly (no adoption
// pass), so these commits never touch the adopted ref the read routes query
// — safe to run in any order relative to the read-route describe blocks
// below.

describe("POST /settle", () => {
  const ANCHOR = "thttpsettle1";
  const TASK_PATH = "wiki/projects/http-settle.md";
  const TASK_LINE = `- [ ] #task ship the http settle route ^${ANCHOR}`;

  test(
    "closes a task line by block-anchor and lands one commit",
    async () => {
      const f = await fixture();
      const content = ["# HTTP settle fixture", "", TASK_LINE, ""].join("\n");
      await mkdir(join(f.vault, "wiki", "projects"), { recursive: true });
      await writeFile(join(f.vault, TASK_PATH), content, "utf8");
      await commitSingleFileOnHead({
        path: f.vault,
        filepath: TASK_PATH,
        content,
        message: "fixture: http-settle task",
        author: { name: "fixture", email: "fixture@local" },
      });

      const { status, json } = await post("/settle", {
        blockId: ANCHOR,
        disposition: "close",
      });
      expect(status).toBe(200);
      expect(json.schema).toBe("dome.settle/v1");
      expect(json.status).toBe("settled");
      expect(json.block_id).toBe(ANCHOR);
      expect(json.disposition).toBe("close");
      expect(typeof json.commit).toBe("string");

      const entries = await log({ path: f.vault, depth: 1 });
      expect(entries[0]?.commit.message).toContain("settle(close):");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "keep settles without a commit",
    async () => {
      const f = await fixture();
      const keepAnchor = "thttpsettle2";
      const keepPath = "wiki/projects/http-settle-keep.md";
      const keepContent = `- [ ] #task keep me ^${keepAnchor}\n`;
      await mkdir(join(f.vault, "wiki", "projects"), { recursive: true });
      await writeFile(join(f.vault, keepPath), keepContent, "utf8");
      await commitSingleFileOnHead({
        path: f.vault,
        filepath: keepPath,
        content: keepContent,
        message: "fixture: http-settle keep task",
        author: { name: "fixture", email: "fixture@local" },
      });
      const before = await log({ path: f.vault, depth: 1 });

      const { status, json } = await post("/settle", {
        blockId: keepAnchor,
        disposition: "keep",
      });
      expect(status).toBe(200);
      expect(json.status).toBe("settled");
      expect(json.commit).toBe(null);

      const after = await log({ path: f.vault, depth: 1 });
      expect(after[0]?.oid).toBe(before[0]?.oid);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "unknown blockId is a 404 with the settle error envelope",
    async () => {
      const { status, json } = await post("/settle", {
        blockId: "tnosuchanchor",
        disposition: "close",
      });
      expect(status).toBe(404);
      expect(json.schema).toBe("dome.settle/v1");
      expect(json.status).toBe("not-found");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "defer without deferUntil is a 400 invalid",
    async () => {
      const { status, json } = await post("/settle", {
        blockId: ANCHOR,
        disposition: "defer",
      });
      expect(status).toBe(400);
      expect(json.status).toBe("invalid");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "rejects a body without blockId or disposition",
    async () => {
      const { status, json } = await post("/settle", { blockId: "" });
      expect(status).toBe(400);
      expect(json.status).toBe("error");
    },
    TEST_TIMEOUT_MS,
  );
});

// ----- Proposals (the third commit-or-nothing seam) -----------------------------------
//
// performApply/performReject/collectProposals are runtime-free (they open
// proposals.db directly, never the VaultRuntime) — no enqueue/withVault
// needed, same as POST /capture and POST /settle above. Proposals are
// enqueued directly through the Task 1 store API since the engine sink is
// out of scope here (mirrors tests/cli/commands/proposals.test.ts).

describe("GET /proposals", () => {
  test(
    "lists a pending proposal as dome.proposals/v1",
    async () => {
      const f = await fixture();
      await writeFile(join(f.vault, "wiki/note.md"), "line1\n", "utf8");
      await commitSingleFileOnHead({
        path: f.vault,
        filepath: "wiki/note.md",
        content: "line1\n",
        message: "fixture: http-proposals note",
        author: { name: "fixture", email: "fixture@local" },
      });
      const id = await enqueueProposal(f.vault, {
        changes: [fileChange({ kind: "write", path: "wiki/note.md", content: "line1\nline2\n" })],
        baseContents: { "wiki/note.md": "line1\n" },
      });

      const { status, json } = await get("/proposals");
      expect(status).toBe(200);
      expect(json.schema).toBe("dome.proposals/v1");
      const proposals = json.proposals as Array<Record<string, unknown>>;
      expect(proposals.some((p) => p.id === id && p.status === "pending")).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "all=1 includes decided rows; default is pending-only",
    async () => {
      const f = await fixture();
      await writeFile(join(f.vault, "wiki/note2.md"), "line1\n", "utf8");
      await commitSingleFileOnHead({
        path: f.vault,
        filepath: "wiki/note2.md",
        content: "line1\n",
        message: "fixture: http-proposals note2",
        author: { name: "fixture", email: "fixture@local" },
      });
      const id = await enqueueProposal(f.vault, {
        changes: [fileChange({ kind: "write", path: "wiki/note2.md", content: "line1\nline2\n" })],
        baseContents: { "wiki/note2.md": "line1\n" },
      });
      expect((await post("/reject", { id })).status).toBe(200);

      const defaultView = await get("/proposals");
      expect((defaultView.json.proposals as unknown[]).some((p) => (p as { id: number }).id === id)).toBe(false);

      const allView = await get("/proposals?all=1");
      const rows = allView.json.proposals as Array<Record<string, unknown>>;
      expect(rows.some((p) => p.id === id && p.status === "rejected")).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("GET /attention", () => {
  test("returns the canonical owner-attention document", async () => {
    const { status, json } = await get("/attention");
    expect(status).toBe(200);
    expect(json.schema).toBe("dome.attention/v1");
    expect(Array.isArray(json.primary)).toBe(true);
    expect(Array.isArray(json.backlog)).toBe(true);
  }, TEST_TIMEOUT_MS);
});

describe("agent work", () => {
  test("lists and completes a revisioned source-backed packet", async () => {
    const f = await fixture();
    const { getAdoptedRef, getCurrentBranch } = await import(
      "../../src/adopted-ref"
    );
    const branch = await getCurrentBranch(f.vault);
    const adopted = await getAdoptedRef(f.vault, branch ?? "main");
    expect(adopted).not.toBeNull();
    if (adopted === null) return;
    const evidence = sourceRef({
      commit: commitOid(adopted),
      path: "wiki/project-omega.md",
    });
    const runtimeResult = await openVaultRuntime({
      vaultPath: f.vault,
      ...resolveBundleRoots({ vaultPath: f.vault }),
    });
    expect(runtimeResult.ok).toBe(true);
    if (!runtimeResult.ok) return;
    insertQuestion(runtimeResult.value.projectionDb, {
      effect: questionEffect({
        question: "Track the HTTP evidence-backed follow-up?",
        options: ["track", "ignore"],
        idempotencyKey: "test.http:agent-work",
        sourceRefs: [evidence],
        metadata: {
          resolutionMode: "dispatch",
          automationPolicy: "agent-safe",
          risk: "low",
        },
      }),
      processorId: "test.http.agent-work",
      runId: "run-test-http-agent-work",
      adoptedCommit: commitOid(adopted),
    });
    await runtimeResult.value.close();

    const listed = await get("/agent-work");
    expect(listed.status).toBe(200);
    expect(listed.json.schema).toBe("dome.agent-work/v1");
    const item = (listed.json.items as Array<Record<string, unknown>>).find(
      (row) => row.question === "Track the HTTP evidence-backed follow-up?",
    );
    expect(item).toBeDefined();
    if (item === undefined) return;

    const completed = await post("/agent-work/complete", {
      questionId: item.questionId,
      expectedRevision: item.revision,
      answer: "track",
      reason: "The adopted project page contains the follow-up context.",
      evidence: [evidence],
    });
    expect(completed.status).toBe(200);
    expect(completed.json.status).toBe("completed");
    expect(
      (completed.json.question as Record<string, unknown>).answered_by,
    ).toBe("agent");
  }, TEST_TIMEOUT_MS);

  test("drains ready work through a replaceable hosted-agent adapter", async () => {
    const f = await fixture();
    const { getAdoptedRef, getCurrentBranch } = await import(
      "../../src/adopted-ref"
    );
    const branch = await getCurrentBranch(f.vault);
    const adopted = await getAdoptedRef(f.vault, branch ?? "main");
    expect(adopted).not.toBeNull();
    if (adopted === null) return;
    const evidence = sourceRef({
      commit: commitOid(adopted),
      path: "wiki/project-omega.md",
    });
    const runtimeResult = await openVaultRuntime({
      vaultPath: f.vault,
      ...resolveBundleRoots({ vaultPath: f.vault }),
    });
    expect(runtimeResult.ok).toBe(true);
    if (!runtimeResult.ok) return;
    insertQuestion(runtimeResult.value.projectionDb, {
      effect: questionEffect({
        question: "Drain the hosted agent-work fixture?",
        options: ["yes", "no"],
        idempotencyKey: "test.http:agent-work-drain",
        sourceRefs: [evidence],
        metadata: {
          resolutionMode: "dispatch",
          automationPolicy: "agent-safe",
          risk: "low",
        },
      }),
      processorId: "test.http.agent-work-drain",
      runId: "run-test-http-agent-work-drain",
      adoptedCommit: commitOid(adopted),
    });
    await runtimeResult.value.close();

    const handler = createDomeHttpServer({
      vaultPath: f.vault,
      token: TOKEN,
      agentWorkAgent: () => async (item) => ({
        kind: "answer",
        answer: "yes",
        reason: "The injected hosted agent inspected the required source.",
        evidence: item.sourceRefs,
      }),
    });
    const response = await handler.fetch(new Request(
      "http://dome.test/agent-work/drain",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ limit: 1 }),
      },
    ));
    expect(response.status).toBe(200);
    const json = await jsonOf(response);
    expect(json.schema).toBe("dome.agent-work-drain/v1");
    expect(json.attempted).toBe(1);
    expect(
      (json.results as Array<Record<string, unknown>>)[0]?.kind,
    ).toBe("completed");
  }, TEST_TIMEOUT_MS);
});

describe("POST /apply", () => {
  test(
    "applies a pending proposal, writes the file, and lands one commit",
    async () => {
      const f = await fixture();
      await writeFile(join(f.vault, "wiki/apply-me.md"), "line1\n", "utf8");
      await commitSingleFileOnHead({
        path: f.vault,
        filepath: "wiki/apply-me.md",
        content: "line1\n",
        message: "fixture: http-apply note",
        author: { name: "fixture", email: "fixture@local" },
      });
      const id = await enqueueProposal(f.vault, {
        changes: [fileChange({ kind: "write", path: "wiki/apply-me.md", content: "line1\nline2\n" })],
        baseContents: { "wiki/apply-me.md": "line1\n" },
      });

      const { status, json } = await post("/apply", { id });
      expect(status).toBe(200);
      expect(json.schema).toBe("dome.apply/v1");
      expect(json.status).toBe("applied");
      expect(json.id).toBe(id);
      expect(typeof json.commit).toBe("string");

      const entries = await log({ path: f.vault, depth: 1 });
      expect(entries[0]?.commit.message).toContain(`apply(P${id}):`);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "unknown id is a 404 with the apply error envelope",
    async () => {
      const { status, json } = await post("/apply", { id: 999_999 });
      expect(status).toBe(404);
      expect(json.schema).toBe("dome.apply/v1");
      expect(json.status).toBe("not-found");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a stale proposal is a 409 conflict",
    async () => {
      const f = await fixture();
      await writeFile(join(f.vault, "wiki/stale-me.md"), "line1\n", "utf8");
      await commitSingleFileOnHead({
        path: f.vault,
        filepath: "wiki/stale-me.md",
        content: "line1\n",
        message: "fixture: http-apply stale note",
        author: { name: "fixture", email: "fixture@local" },
      });
      const id = await enqueueProposal(f.vault, {
        changes: [fileChange({ kind: "write", path: "wiki/stale-me.md", content: "line1\nline2\n" })],
        baseContents: { "wiki/stale-me.md": "line1\n" },
      });
      await writeFile(join(f.vault, "wiki/stale-me.md"), "someone edited this already\n", "utf8");

      const { status, json } = await post("/apply", { id });
      expect(status).toBe(409);
      expect(json.schema).toBe("dome.apply/v1");
      expect(json.status).toBe("stale");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "rejects a body without a positive integer id",
    async () => {
      const { status, json } = await post("/apply", { id: "not-a-number" });
      expect(status).toBe(400);
      expect(json.status).toBe("error");
    },
    TEST_TIMEOUT_MS,
  );
});

describe("POST /reject", () => {
  test(
    "rejects a pending proposal and lands no commit",
    async () => {
      const f = await fixture();
      await writeFile(join(f.vault, "wiki/reject-me.md"), "line1\n", "utf8");
      await commitSingleFileOnHead({
        path: f.vault,
        filepath: "wiki/reject-me.md",
        content: "line1\n",
        message: "fixture: http-reject note",
        author: { name: "fixture", email: "fixture@local" },
      });
      const id = await enqueueProposal(f.vault, {
        changes: [fileChange({ kind: "write", path: "wiki/reject-me.md", content: "line1\nline2\n" })],
        baseContents: { "wiki/reject-me.md": "line1\n" },
      });
      const before = await log({ path: f.vault, depth: 1 });

      const { status, json } = await post("/reject", { id, note: "not needed" });
      expect(status).toBe(200);
      expect(json.schema).toBe("dome.reject/v1");
      expect(json.status).toBe("rejected");
      expect(json.id).toBe(id);

      const after = await log({ path: f.vault, depth: 1 });
      expect(after[0]?.oid).toBe(before[0]?.oid);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "unknown id is a 404 with the reject error envelope",
    async () => {
      const { status, json } = await post("/reject", { id: 999_999 });
      expect(status).toBe(404);
      expect(json.schema).toBe("dome.reject/v1");
      expect(json.status).toBe("not-found");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a second reject on the same id is a 409 conflict",
    async () => {
      const f = await fixture();
      await writeFile(join(f.vault, "wiki/double-reject.md"), "line1\n", "utf8");
      await commitSingleFileOnHead({
        path: f.vault,
        filepath: "wiki/double-reject.md",
        content: "line1\n",
        message: "fixture: http-reject double note",
        author: { name: "fixture", email: "fixture@local" },
      });
      const id = await enqueueProposal(f.vault, {
        changes: [fileChange({ kind: "write", path: "wiki/double-reject.md", content: "line1\nline2\n" })],
        baseContents: { "wiki/double-reject.md": "line1\n" },
      });
      expect((await post("/reject", { id })).status).toBe(200);

      const { status, json } = await post("/reject", { id });
      expect(status).toBe(409);
      expect(json.schema).toBe("dome.reject/v1");
      expect(json.status).toBe("not-pending");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "rejects a body without a positive integer id",
    async () => {
      const { status, json } = await post("/reject", { id: "not-a-number" });
      expect(status).toBe(400);
      expect(json.status).toBe("error");
    },
    TEST_TIMEOUT_MS,
  );
});

// ----- Read routes -----------------------------------------------------------------

describe("read routes", () => {
  test(
    "GET /status mirrors the dome status --json snapshot",
    async () => {
      const f = await fixture();
      const { status, json } = await get("/status");
      expect(status).toBe(200);
      expect(json.vault).toBe(f.vault);
      expect(typeof json.attention_required).toBe("boolean");
      expect(Array.isArray(json.next_actions)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "GET /query returns the dome.search.query/v1 document",
    async () => {
      const { status, json } = await get("/query?text=omega%20launch");
      expect(status).toBe(200);
      expect(json.query).toBe("omega launch");
      const matches = json.matches as Array<Record<string, unknown>>;
      expect(matches.map((m) => m.path)).toContain("wiki/project-omega.md");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "GET /views discovers installed plugin views",
    async () => {
      const res = await get("/views");
      expect(res.status).toBe(200);
      expect(res.json.schema).toBe("dome.views/v1");
      const views = res.json.views as Array<Record<string, unknown>>;
      expect(views.some((view) =>
        view.command === "today" && view.processorId === "dome.daily.today"
      )).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "POST /views/:command invokes an installed plugin view through the generic seam",
    async () => {
      const res = await post("/views/query", { text: "omega", limit: 3 });
      expect(res.status).toBe(200);
      expect(res.json.schema).toBe("dome.view-run/v1");
      expect(res.json.status).toBe("ok");
      expect(res.json.command).toBe("query");
      expect((res.json.views as Array<Record<string, unknown>>)[0]).toMatchObject({
        name: "dome.search.query",
        kind: "structured",
      });
    },
    TEST_TIMEOUT_MS,
  );

  test("POST /views/:command returns a discoverable 404 for an absent view", async () => {
    const res = await post("/views/not-installed", {});
    expect(res.status).toBe(404);
    expect(res.json).toMatchObject({
      schema: "dome.view-run/v1",
      status: "error",
      error: "view-not-found",
    });
    expect(Array.isArray(res.json.installed)).toBe(true);
  });

  test(
    "GET /query without text is a 400",
    async () => {
      expect((await get("/query")).status).toBe(400);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "GET /tasks returns the dome.daily.today/v1 view",
    async () => {
      const { status, json } = await get(`/tasks?date=${TODAY}`);
      expect(status).toBe(200);
      expect(json.schema).toBe("dome.daily.today/v1");
      const openTasks = json.openTasks as Array<Record<string, unknown>>;
      expect(
        openTasks.some((task) => String(task.text).includes("ship the http surface")),
      ).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "GET /doc returns adopted content; missing paths are 404",
    async () => {
      const ok = await get("/doc?path=wiki/project-omega.md");
      expect(ok.status).toBe(200);
      expect(ok.json.schema).toBe("dome.http.document/v1");
      expect(String(ok.json.content)).toContain("Project Omega");
      expect(typeof ok.json.commit).toBe("string");

      expect((await get("/doc?path=wiki/missing.md")).status).toBe(404);
    },
    TEST_TIMEOUT_MS,
  );
});

// ----- Decisions ---------------------------------------------------------------------

describe("questions and resolve", () => {
  test(
    "lists open questions and resolves through the durable answer path",
    async () => {
      const f = await fixture();

      // Seed a durable question the way a processor would have left it.
      const runtimeResult = await openVaultRuntime({
        vaultPath: f.vault,
        ...resolveBundleRoots({ vaultPath: f.vault }),
      });
      expect(runtimeResult.ok).toBe(true);
      if (!runtimeResult.ok) return;
      let questionId = 0;
      try {
        const { getAdoptedRef, getCurrentBranch } = await import(
          "../../src/adopted-ref"
        );
        const branch = await getCurrentBranch(f.vault);
        const adopted = await getAdoptedRef(f.vault, branch ?? "main");
        insertQuestion(runtimeResult.value.projectionDb, {
          effect: questionEffect({
            question: "Adopt the http wedge surface?",
            options: ["yes", "no"],
            idempotencyKey: "test.http:resolve-roundtrip",
            sourceRefs: [
              sourceRef({
                commit: commitOid(adopted ?? ""),
                path: ".dome/config.yaml",
              }),
            ],
          }),
          processorId: "test.http.ask",
          runId: "run-test-http",
          adoptedCommit: commitOid(adopted ?? ""),
        });
        questionId =
          queryQuestionRecords(runtimeResult.value.projectionDb, {
            resolved: false,
          }).find((row) => row.effect.question === "Adopt the http wedge surface?")
            ?.id ?? 0;
      } finally {
        await runtimeResult.value.close();
      }
      expect(questionId).toBeGreaterThan(0);

      const open = await get("/questions");
      expect(open.status).toBe(200);
      expect(open.json.schema).toBe("dome.http.questions/v1");
      const rows = open.json.questions as Array<Record<string, unknown>>;
      expect(rows.some((q) => q.id === questionId)).toBe(true);

      const bad = await post("/resolve", { id: questionId, value: "maybe" });
      expect(bad.status).toBe(400);
      expect(bad.json.status).toBe("invalid-option");

      const answered = await post("/resolve", { id: questionId, value: "yes" });
      expect(answered.status).toBe(200);
      expect(answered.json.schema).toBe("dome.answer/v1");
      expect(answered.json.status).toBe("answered");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "resolve of an unknown id is a 404 with the answer error envelope",
    async () => {
      const { status, json } = await post("/resolve", { id: 999_999, value: "x" });
      expect(status).toBe(404);
      expect(json.schema).toBe("dome.answer/v1");
      expect(json.error).toBe("question-not-found");
    },
    TEST_TIMEOUT_MS,
  );
});

// ----- Request-body size cap -----------------------------------------------------------

function rawInboxFiles(vault: string): string[] {
  const dir = join(vault, "inbox", "raw");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

describe("request-body size cap", () => {
  test(
    "an oversized fixed-length capture POST is 413 and writes nothing",
    async () => {
      const f = await fixture();
      const headBefore = (await log({ path: f.vault, depth: 1 }))[0]?.oid;
      const filesBefore = rawInboxFiles(f.vault);

      // Default cap is 1 MiB; send a body comfortably over it. The test
      // fixture's Bun.serve does NOT set maxRequestBodySize, so this
      // exercises the handler's own content-length gate end to end.
      const { status, json } = await post("/capture", {
        text: "x".repeat(1_200_000),
        title: "way too big",
      });
      expect(status).toBe(413);
      expect(json.status).toBe("error");
      expect(json.error).toBe("payload-too-large");

      const headAfter = (await log({ path: f.vault, depth: 1 }))[0]?.oid;
      expect(headAfter).toBe(headBefore);
      expect(rawInboxFiles(f.vault)).toEqual(filesBefore);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a chunked body with no content-length is capped by the stream byte budget",
    async () => {
      const f = await fixture();
      // Direct handler call with a small cap: a streamed Request carries no
      // content-length header, so only the bounded read can stop it (Bun's
      // maxRequestBodySize does not enforce on chunked bodies — verified
      // against Bun 1.2.x).
      const handler = createDomeHttpServer({
        vaultPath: f.vault,
        token: TOKEN,
        maxBodyBytes: 64,
      });
      const filesBefore = rawInboxFiles(f.vault);
      const payload = JSON.stringify({ text: "y".repeat(500) });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const bytes = new TextEncoder().encode(payload);
          for (let i = 0; i < bytes.length; i += 50) {
            controller.enqueue(bytes.slice(i, i + 50));
          }
          controller.close();
        },
      });
      const res = await handler.fetch(
        new Request("http://dome.test/capture", {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}` },
          body: stream,
        }),
      );
      expect(res.status).toBe(413);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.error).toBe("payload-too-large");
      expect(rawInboxFiles(f.vault)).toEqual(filesBefore);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a small body under a custom cap flows through unaffected",
    async () => {
      const f = await fixture();
      const handler = createDomeHttpServer({
        vaultPath: f.vault,
        token: TOKEN,
        maxBodyBytes: 64,
      });
      // 25 bytes < 64: the cap must not interfere — this reaches the
      // ordinary resolve path (unknown id → 404 answer envelope).
      const res = await handler.fetch(
        new Request("http://dome.test/resolve", {
          method: "POST",
          headers: {
            authorization: `Bearer ${TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ id: 999_999, value: "x" }),
        }),
      );
      expect(res.status).toBe(404);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.error).toBe("question-not-found");
    },
    TEST_TIMEOUT_MS,
  );
});

// ----- Mutex concurrency ---------------------------------------------------------------

describe("mutex concurrency", () => {
  test(
    "8 parallel mixed requests all succeed and the capture lands exactly once",
    async () => {
      const f = await fixture();
      const captureSlug = "parallel-mutex-probe";
      const captureMessage = "capture: parallel mutex capture";

      // Fire everything at once: reads that open the vault runtime, the
      // status snapshot, and TWO captures sharing one captureId. The mutex
      // must serialize them: every request succeeds, and the second capture
      // sees the first's file through the dedup scan (`duplicate`) instead
      // of racing it past the scan and double-filing.
      const captureBody = {
        text: "parallel mutex capture",
        captureId: captureSlug,
      };
      const results = await Promise.all([
        get("/query?text=omega"),
        get("/query?text=launch%20roadmap"),
        get(`/tasks?date=${TODAY}`),
        get("/tasks"),
        get("/status"),
        get("/doc?path=wiki/project-omega.md"),
        post("/capture", captureBody),
        post("/capture", captureBody),
      ]);

      for (const r of results) expect(r.status).toBe(200);
      const captureStatuses = [results[6].json.status, results[7].json.status];
      expect(captureStatuses.sort()).toEqual(["captured", "duplicate"]);

      // No interleaving corruption: exactly one capture file for the id,
      // and both responses point at it.
      const landed = rawInboxFiles(f.vault).filter((name) =>
        name.endsWith(`-${captureSlug}.md`),
      );
      expect(landed.length).toBe(1);
      expect(results[6].json.path).toBe(`inbox/raw/${landed[0]}`);
      expect(results[7].json.path).toBe(`inbox/raw/${landed[0]}`);

      // …and exactly one capture commit, sitting on an intact history.
      const entries = await log({ path: f.vault, depth: 50 });
      const captureCommits = entries.filter((e) =>
        e.commit.message.startsWith(captureMessage),
      );
      expect(captureCommits.length).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );
});

// ----- Fallthrough -------------------------------------------------------------------

describe("fallthrough", () => {
  test(
    "unknown routes are 404 JSON",
    async () => {
      const { status, json } = await get("/no-such-route");
      expect(status).toBe(404);
      expect(json.status).toBe("error");
    },
    TEST_TIMEOUT_MS,
  );
});

// ----- The HTML cockpit ----------------------------------------------------------------

describe("GET /today", () => {
  test("renders the HTML cockpit with bearer header", async () => {
    const f = await fixture();
    const res = await fetch(`${f.baseUrl}/today`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain("ship the http surface");
    // CB-T3: the page now JS-polls; there is no <meta http-equiv="refresh">
    expect(html).not.toContain('http-equiv="refresh"');
    expect(html).toContain("POLL_MS");
    expect(html).toContain("setInterval(poll,");
  }, TEST_TIMEOUT_MS);

  test("accepts ?token= on /today only", async () => {
    const f = await fixture();
    const ok = await fetch(`${f.baseUrl}/today?token=${TOKEN}`);
    expect(ok.status).toBe(200);

    const wrong = await fetch(`${f.baseUrl}/today?token=nope`);
    expect(wrong.status).toBe(401);

    // Query-param token must NOT authorize other routes.
    const other = await fetch(`${f.baseUrl}/tasks?token=${TOKEN}`);
    expect(other.status).toBe(401);

    // ...and must NOT authorize other methods on /today (GET-only scoping).
    const wrongMethod = await fetch(`${f.baseUrl}/today?token=${TOKEN}`, {
      method: "POST",
    });
    expect(wrongMethod.status).toBe(401);
  }, TEST_TIMEOUT_MS);

  test("honors ?refresh= seconds", async () => {
    const f = await fixture();
    const res = await fetch(`${f.baseUrl}/today?token=${TOKEN}&refresh=30`);
    // CB-T3: JS polling — ?refresh= controls POLL_MS (refreshSeconds * 1000)
    expect(await res.text()).toContain("POLL_MS = 30000");
  }, TEST_TIMEOUT_MS);

  test("absent or garbage ?refresh= falls back to 15 seconds", async () => {
    const f = await fixture();
    // CB-T3: JS polling — default POLL_MS = 15 * 1000 = 15000
    const absent = await fetch(`${f.baseUrl}/today?token=${TOKEN}`);
    expect(await absent.text()).toContain("POLL_MS = 15000");

    const garbage = await fetch(`${f.baseUrl}/today?token=${TOKEN}&refresh=banana`);
    expect(await garbage.text()).toContain("POLL_MS = 15000");
  }, TEST_TIMEOUT_MS);
});

// ----- Cacheable font routes (CB-T7) ------------------------------------------

describe("GET /today/fonts/*.woff2", () => {
  test("GET /today/fonts/basel-book.woff2 returns the font with an immutable long cache", async () => {
    const f = await fixture();
    const res = await fetch(`${f.baseUrl}/today/fonts/basel-book.woff2`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("font/woff2");
    expect(res.headers.get("cache-control")).toMatch(/immutable|max-age=\d{6,}/);
  }, TEST_TIMEOUT_MS);

  test("/today HTML references font routes, not megabytes of base64", async () => {
    const f = await fixture();
    const res = await fetch(`${f.baseUrl}/today?token=${TOKEN}`);
    const html = await res.text();
    expect(html).toContain("/today/fonts/basel-book.woff2");
    expect(html).not.toContain("data:font/woff2;base64,");
    expect(html.length).toBeLessThan(60000); // ~25KB, not ~270KB
  }, TEST_TIMEOUT_MS);

  test("font route is served without authentication", async () => {
    const f = await fixture();
    // No Authorization header — a browser loading url() from CSS sends none.
    const res = await fetch(`${f.baseUrl}/today/fonts/basel-medium.woff2`);
    expect(res.status).toBe(200);
  }, TEST_TIMEOUT_MS);
});
