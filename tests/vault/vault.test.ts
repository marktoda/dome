// Public Vault wrapper — `openVault(path)` per docs/wiki/specs/sdk-surface.md
// §"The four concepts" / §"Vault surface".
//
// These tests are hermetic and end-to-end by design (the same posture as
// tests/mcp/mcp-server.test.ts): a real temp vault (runInit), real commits,
// a real adoption pass with the shipped bundles, no protocol or engine
// mocking. The suite reads like one scripted SDK session against one vault:
// open → status → sync → recall → views → decisions → close.
//
// What the wrapper is NOT (asserted implicitly by the API surface): there is
// no write method, no submitProposal, no direct mutation path. Writes happen
// here the sanctioned way — ordinary git commits — and `vault.sync()` adopts
// them (PROPOSALS_ARE_THE_ONLY_WRITE_PATH).

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runInit } from "../../src/cli/commands/init";
import { questionEffect } from "../../src/core/effect";
import { commitOid, sourceRef } from "../../src/core/source-ref";
import { openVaultRuntime } from "../../src/engine/vault-runtime";
import { resolveBundleRoots } from "../../src/cli/commands/sync-shared";
import { add, commit } from "../../src/git";
import { insertQuestion } from "../../src/projections/questions";
import { openVault, type Vault } from "../../src/vault";
import { openVault as openVaultFromIndex } from "../../src/index";

const TEST_TIMEOUT_MS = 120_000;

// ----- Console capture (runInit prints; tests stay quiet) ---------------------

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

function localDateString(date: Date = new Date()): string {
  const yyyy = String(date.getFullYear()).padStart(4, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

const TODAY = localDateString();
const DAILY_PATH = `wiki/dailies/${TODAY}.md`;

// ----- Shared fixture ---------------------------------------------------------
//
// One vault, opened once, threaded through the suite in declaration order.
// The heavy setup (init + seed commit) runs lazily inside the first test's
// timeout; `vault.sync()` itself is under test, so the fixture does NOT
// pre-adopt.

type Fixture = {
  readonly vaultPath: string;
  readonly vault: Vault;
};

let fixturePromise: Promise<Fixture> | null = null;
let fixtureForCleanup: Fixture | null = null;
const tempDirs: string[] = [];

function fixture(): Promise<Fixture> {
  fixturePromise ??= buildFixture();
  return fixturePromise;
}

async function buildFixture(): Promise<Fixture> {
  const vaultPath = mkdtempSync(join(tmpdir(), "dome-vault-api-"));
  tempDirs.push(vaultPath);
  expect(await runInit({ path: vaultPath })).toBe(0);

  await mkdir(join(vaultPath, "wiki", "dailies"), { recursive: true });
  await writeFile(
    join(vaultPath, "wiki", "project-omega.md"),
    "---\ntype: project\n---\n# Project Omega\n\n" +
      "Roadmap notes for the omega launch and ownership model.\n",
    "utf8",
  );
  await writeFile(
    join(vaultPath, DAILY_PATH),
    `# ${TODAY}\n\n## Tasks\n\n- [ ] ship the vault wrapper\n`,
    "utf8",
  );
  await add(vaultPath, "wiki/project-omega.md");
  await add(vaultPath, DAILY_PATH);
  await commit({ path: vaultPath, message: "seed searchable content" });

  const opened = await openVault({ path: vaultPath });
  if (!opened.ok) {
    throw new Error(`openVault failed: ${JSON.stringify(opened.error)}`);
  }
  const built: Fixture = { vaultPath, vault: opened.value };
  fixtureForCleanup = built;
  return built;
}

afterAll(async () => {
  if (fixtureForCleanup !== null) {
    await fixtureForCleanup.vault.close();
  }
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

// ----- openVault boundary -------------------------------------------------------

describe("openVault", () => {
  test("returns not-a-vault for a directory that is not a git repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dome-not-a-vault-"));
    tempDirs.push(dir);

    const result = await openVault({ path: dir });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("not-a-vault");
    }
  });

  test("returns not-a-vault for a git repo without a .dome directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dome-bare-repo-"));
    tempDirs.push(dir);
    // A git repo without `.dome/` is not a Dome vault. (A `.dome/` without
    // `config.yaml` IS one — the config-less compat mode the runtime
    // documents for test/dev vaults.)
    const { initRepo } = await import("../../src/git");
    await initRepo(dir);

    const result = await openVault({ path: dir });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("not-a-vault");
    }
  });

  test(
    "opens an initialized vault and lists the shipped extensions",
    async () => {
      const { vault, vaultPath } = await fixture();

      expect(vault.path).toBe(vaultPath);
      expect(vault.extensions.length).toBeGreaterThan(0);
      expect(vault.extensions.map((e) => e.name)).toContain("dome.search");
    },
    TEST_TIMEOUT_MS,
  );

  test("is exported from the package root", () => {
    expect(openVaultFromIndex).toBe(openVault);
  });
});

// ----- Engine control: status + sync ---------------------------------------------

describe("adoption status and sync", () => {
  test(
    "reports drift before the first sync, then adopts and reports in-sync",
    async () => {
      const { vault } = await fixture();

      const before = await vault.getAdoptionStatus();
      expect(before.branch).not.toBeNull();
      expect(before.head).not.toBeNull();
      expect(before.syncNeeded).toBe(true);
      expect(before.diverged).toBe(false);

      const tick = await vault.sync();
      expect(tick.kind).toBe("adopted");

      const after = await vault.getAdoptionStatus();
      expect(after.syncNeeded).toBe(false);
      expect(after.adopted).toBe(after.head);
      expect(after.pendingCommits).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "counts pending commits after a new human commit, then adopts it",
    async () => {
      const { vault, vaultPath } = await fixture();

      await writeFile(
        join(vaultPath, "wiki", "pending-note.md"),
        "---\ntype: concept\n---\n# Pending Note\n\nA second commit.\n",
        "utf8",
      );
      await add(vaultPath, "wiki/pending-note.md");
      await commit({ path: vaultPath, message: "add pending note" });

      const status = await vault.getAdoptionStatus();
      expect(status.syncNeeded).toBe(true);
      expect(status.pendingCommits).toBe(1);

      const tick = await vault.sync();
      expect(tick.kind).toBe("adopted");
      expect((await vault.getAdoptionStatus()).syncNeeded).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});

// ----- Engine control: rebuild ----------------------------------------------------

describe("rebuild", () => {
  test(
    "wipes and rebuilds the projection from the adopted commit",
    async () => {
      const { vault } = await fixture();

      const before = await vault.getAdoptionStatus();
      const outcome = await vault.rebuild();

      expect(outcome.kind).toBe("ok");
      if (outcome.kind === "ok") {
        expect(outcome.adopted).toBe(before.adopted as string);
        expect(outcome.files).toBeGreaterThan(0);
        expect(outcome.processors).toBeGreaterThan(0);
      }

      // The rebuilt projection still serves Recall.
      const result = await vault.query({ text: "omega launch" });
      expect(result.matches.map((m) => m.path)).toContain(
        "wiki/project-omega.md",
      );
    },
    TEST_TIMEOUT_MS,
  );
});

// ----- Recall: query + readDocument ----------------------------------------------

describe("recall", () => {
  test(
    "query finds adopted pages by full-text match",
    async () => {
      const { vault } = await fixture();

      const result = await vault.query({ text: "omega launch" });

      expect(result.matches.length).toBeGreaterThan(0);
      expect(result.matches.map((m) => m.path)).toContain(
        "wiki/project-omega.md",
      );
      // Include flags default to false: the auxiliary arrays stay empty.
      expect(result.facts).toEqual([]);
      expect(result.diagnostics).toEqual([]);
      expect(result.questions).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "readDocument returns the adopted content for a page",
    async () => {
      const { vault } = await fixture();

      const doc = await vault.readDocument("wiki/project-omega.md");

      expect(doc).not.toBeNull();
      expect(doc?.path).toBe("wiki/project-omega.md");
      expect(doc?.content).toContain("Project Omega");
      expect(doc?.commit.length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "readDocument returns null for a path absent from adopted state",
    async () => {
      const { vault } = await fixture();

      expect(await vault.readDocument("wiki/does-not-exist.md")).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );
});

// ----- Views: the generic command surface ------------------------------------------

describe("runView", () => {
  test(
    "dispatches a command-triggered view processor and returns the structured view",
    async () => {
      const { vault } = await fixture();

      const result = await vault.runView("today");

      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.structured).not.toBeNull();
        expect(result.structured?.name).toBe("dome.daily.today");
        expect(result.structured?.schema).toBe("dome.daily.today/v1");
        expect(result.structured?.data).toBeTruthy();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "returns not-found for an unregistered command",
    async () => {
      const { vault } = await fixture();

      const result = await vault.runView("no-such-command");

      expect(result.kind).toBe("not-found");
    },
    TEST_TIMEOUT_MS,
  );
});

// ----- Decisions: listQuestions + resolve ------------------------------------------

describe("decisions", () => {
  test(
    "lists an open question and resolves it through the durable answer path",
    async () => {
      const { vault, vaultPath } = await fixture();

      // Seed a durable question row the way a garden processor would have —
      // directly into the projection, via an engine-internal runtime handle.
      const adopted = (await vault.getAdoptionStatus()).adopted;
      expect(adopted).not.toBeNull();
      const runtimeResult = await openVaultRuntime({
        vaultPath,
        ...resolveBundleRoots({ vaultPath }),
      });
      expect(runtimeResult.ok).toBe(true);
      if (!runtimeResult.ok) return;
      const effect = questionEffect({
        question: "Should the wrapper suite keep this fixture question?",
        options: ["keep", "drop"],
        idempotencyKey: "vault-api-test-question",
        sourceRefs: [
          sourceRef({
            path: "wiki/project-omega.md",
            commit: commitOid(adopted as string),
          }),
        ],
      });
      insertQuestion(runtimeResult.value.projectionDb, {
        effect,
        processorId: "dome.test.fixture",
        runId: "run-vault-api-test",
        adoptedCommit: commitOid(adopted as string),
      });
      await runtimeResult.value.close();

      const open = await vault.listQuestions({ resolved: false });
      const seeded = open.find(
        (q) => q.effect.idempotencyKey === "vault-api-test-question",
      );
      expect(seeded).toBeDefined();
      if (seeded === undefined) return;

      const rejected = await vault.resolve(seeded.id, "neither");
      expect(rejected.kind).toBe("invalid-option");

      const resolved = await vault.resolve(seeded.id, "keep");
      expect(resolved.kind).toBe("answered");
      if (resolved.kind === "answered") {
        expect(resolved.record.answer).toBe("keep");
      }

      const after = await vault.getQuestion(seeded.id);
      expect(after?.answeredAt).not.toBeNull();

      const again = await vault.resolve(seeded.id, "keep");
      expect(again.kind).toBe("already-answered");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "resolve returns not-found for an unknown question id",
    async () => {
      const { vault } = await fixture();

      expect((await vault.resolve(999_999, "x")).kind).toBe("not-found");
    },
    TEST_TIMEOUT_MS,
  );
});
