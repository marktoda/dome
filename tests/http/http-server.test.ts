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
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runInit } from "../../src/cli/commands/init";
import { runSync } from "../../src/cli/commands/sync";
import { resolveBundleRoots } from "../../src/cli/commands/sync-shared";
import { questionEffect } from "../../src/core/effect";
import { commitOid, sourceRef } from "../../src/core/source-ref";
import { openVaultRuntime } from "../../src/engine/host/vault-runtime";
import { log } from "../../src/git";
import { createDomeHttpServer } from "../../src/http/server";
import { insertQuestion, queryQuestionRecords } from "../../src/projections/questions";

const TEST_TIMEOUT_MS = 120_000;
const TOKEN = "test-relay-token";

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

// ----- Auth ------------------------------------------------------------------------

describe("auth", () => {
  test(
    "every route requires the bearer token",
    async () => {
      expect((await get("/status", null)).status).toBe(401);
      expect((await get("/status", "wrong-token")).status).toBe(401);
      expect((await post("/capture", { text: "x" }, null)).status).toBe(401);
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
    expect(html).toContain('http-equiv="refresh"');
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
    expect(await res.text()).toContain('content="30"');
  }, TEST_TIMEOUT_MS);

  test("absent or garbage ?refresh= falls back to 15 seconds", async () => {
    const f = await fixture();
    const absent = await fetch(`${f.baseUrl}/today?token=${TOKEN}`);
    expect(await absent.text()).toContain('content="15"');

    const garbage = await fetch(`${f.baseUrl}/today?token=${TOKEN}&refresh=banana`);
    expect(await garbage.text()).toContain('content="15"');
  }, TEST_TIMEOUT_MS);
});
