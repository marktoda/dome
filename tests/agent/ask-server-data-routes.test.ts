// The ask-server's PWA data routes (`dome ask-server`) — POST /capture,
// GET /tasks, POST /resolve. These reuse the SAME shared `src/surface/`
// collectors `dome http` uses, under the ask-server's existing single mutex,
// so the PWA gets identical request/response contracts whichever server it
// hits. End-to-end and hermetic, mirroring tests/http/http-server.test.ts: a
// real temp vault (runInit), real commits, a real adoption pass, and real HTTP
// over a loopback Bun.serve on an ephemeral port. The ask routes are exercised
// elsewhere (tests/agent/server.test.ts) and are untouched here.

import { afterAll, beforeEach, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
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
import { createAskServer } from "../../src/agent/server";
import { insertQuestion, queryQuestionRecords } from "../../src/projections/questions";

const TEST_TIMEOUT_MS = 120_000;
const TOKEN = "test-ask-token";

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
  const vault = mkdtempSync(join(tmpdir(), "dome-ask-vault-"));
  expect(await runInit({ path: vault })).toBe(0);

  await mkdir(join(vault, "wiki", "dailies"), { recursive: true });
  await writeFile(
    join(vault, DAILY_PATH),
    `# ${TODAY}\n\n## Tasks\n\n- [ ] ship the ask data routes\n`,
    "utf8",
  );
  const { add, commit } = await import("../../src/git");
  await add(vault, DAILY_PATH);
  await commit({ path: vault, message: "seed daily tasks" });
  expect(await runSync({ vault, quiet: true })).toBe(0);

  const handler = createAskServer({
    vaultPath: vault,
    token: TOKEN,
    // Use a passthrough ask impl so the server never needs a model; the data
    // routes under test don't touch it.
    askImpl: async () => ({ answer: "", citations: [], steps: 0, stopReason: "final" }),
    askStreamImpl: () => {
      throw new Error("askStream not used in data-route tests");
    },
  });
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

function rawInboxFiles(vault: string): string[] {
  const dir = join(vault, "inbox", "raw");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

// ----- POST /capture (the remote-capture seam) -----------------------------------

describe("POST /capture", () => {
  test(
    "captures with source http, commits, and lands under inbox/raw/",
    async () => {
      const f = await fixture();
      const { status, json } = await post("/capture", {
        text: "Remember: wire the ask-server data routes.",
        title: "ask routes capture",
      });

      expect(status).toBe(200);
      expect(json.schema).toBe("dome.capture/v1");
      expect(json.status).toBe("captured");
      expect(json.source).toBe("http");
      expect(String(json.path).startsWith("inbox/raw/")).toBe(true);
      expect(typeof json.commit).toBe("string");

      // The file actually landed under inbox/raw/.
      const landed = rawInboxFiles(f.vault);
      expect(landed.length).toBeGreaterThan(0);

      const entries = await log({ path: f.vault, depth: 1 });
      expect(entries[0]?.commit.message).toContain("capture: ask routes capture");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "rejects a body without text with 400",
    async () => {
      const { status, json } = await post("/capture", { title: "no text" });
      expect(status).toBe(400);
      // Must match dome http's errorResponse shape exactly: { status, error, message }
      // NO schema field (in particular, NOT schema: "dome.ask/v1").
      expect(json.status).toBe("error");
      expect(json.error).toBe("capture-usage");
      expect(typeof json.message).toBe("string");
      expect(Object.prototype.hasOwnProperty.call(json, "schema")).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "requires the bearer token",
    async () => {
      expect((await post("/capture", { text: "x" }, null)).status).toBe(401);
    },
    TEST_TIMEOUT_MS,
  );
});

// ----- GET /tasks ----------------------------------------------------------------

describe("GET /tasks", () => {
  test(
    "returns the dome.daily.today/v1 view",
    async () => {
      const { status, json } = await get(`/tasks?date=${TODAY}`);
      expect(status).toBe(200);
      expect(json.schema).toBe("dome.daily.today/v1");
      const openTasks = json.openTasks as Array<Record<string, unknown>>;
      expect(
        openTasks.some((task) => String(task.text).includes("ship the ask data routes")),
      ).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "requires the bearer token",
    async () => {
      expect((await get("/tasks", null)).status).toBe(401);
    },
    TEST_TIMEOUT_MS,
  );
});

// ----- POST /resolve -------------------------------------------------------------

describe("POST /resolve", () => {
  test(
    "resolves a seeded question through the durable answer path",
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
            question: "Adopt the ask data routes?",
            options: ["yes", "no"],
            idempotencyKey: "test.ask:resolve-roundtrip",
            sourceRefs: [
              sourceRef({
                commit: commitOid(adopted ?? ""),
                path: ".dome/config.yaml",
              }),
            ],
          }),
          processorId: "test.ask.resolve",
          runId: "run-test-ask",
          adoptedCommit: commitOid(adopted ?? ""),
        });
        questionId =
          queryQuestionRecords(runtimeResult.value.projectionDb, {
            resolved: false,
          }).find((row) => row.effect.question === "Adopt the ask data routes?")
            ?.id ?? 0;
      } finally {
        await runtimeResult.value.close();
      }
      expect(questionId).toBeGreaterThan(0);

      // Bad input: empty value → 400.
      // Must match dome http's errorResponse shape: { status, error, message } — NO schema field.
      const badInput = await post("/resolve", { id: questionId, value: "" });
      expect(badInput.status).toBe(400);
      expect(badInput.json.status).toBe("error");
      expect(badInput.json.error).toBe("resolve-usage");
      expect(typeof badInput.json.message).toBe("string");
      expect(Object.prototype.hasOwnProperty.call(badInput.json, "schema")).toBe(false);

      // Invalid option → 400 with the answer envelope.
      const badOption = await post("/resolve", { id: questionId, value: "maybe" });
      expect(badOption.status).toBe(400);
      expect(badOption.json.status).toBe("invalid-option");

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
      // dome http's POST /resolve not-found uses the ANSWER_SCHEMA envelope
      // (schema: "dome.answer/v1") — this is the ONE resolve error path that
      // DOES carry a schema, and it matches http exactly (not dome.ask/v1).
      expect(json.schema).toBe("dome.answer/v1");
      expect(json.status).toBe("error");
      expect(json.error).toBe("question-not-found");
      expect(typeof json.message).toBe("string");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "requires the bearer token",
    async () => {
      expect((await post("/resolve", { id: 1, value: "x" }, null)).status).toBe(401);
    },
    TEST_TIMEOUT_MS,
  );
});
