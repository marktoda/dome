// Phase 9 — end-to-end tests for the four CLI commands.
//
// Each describe block sets up a fresh tmpdir vault (a real git repo
// with two commits), invokes the relevant `run<Command>` function, and
// asserts on the returned exit code + the side effects on disk / DBs.
//
// Phase 11f: the CLI commands default `--bundles-root` to the SDK's
// shipped `assets/extensions/`. Tests no longer need to copy bundles
// into the tmpdir vault — they just rely on the default resolver. The
// fixture is correspondingly thinner.
//
// Tests run the command handlers directly — they don't spawn `bun`
// subprocesses. That keeps the suite fast and lets us assert on
// internal state (filesystem layout, DB rows) without parsing stdout.
//
// Console output is captured to keep test logs quiet; the assertions
// don't depend on the captured strings (handlers' return codes are the
// load-bearing surface).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import { runInit } from "../../src/cli/commands/init";
import { runAnswer } from "../../src/cli/commands/answer";
import { runDoctor } from "../../src/cli/commands/doctor";
import { runInspect } from "../../src/cli/commands/inspect";
import { runStatus } from "../../src/cli/commands/status";
import { runSync } from "../../src/cli/commands/sync";
import { resolveShippedBundlesRoot } from "../../src/cli/commands/sync-shared";
import { defaultConfigRecord } from "../../src/cli/default-vault-config";
import { loadBundles } from "../../src/extensions/loader";

import {
  diagnosticEffect,
  externalActionEffect,
  questionEffect,
} from "../../src/core/effect";
import { commitOid, sourceRef } from "../../src/core/source-ref";
import { commit, currentSha, initRepo, readBlob } from "../../src/git";
import {
  createServeHeartbeatHandle,
  serveHeartbeatPath,
  writeServeHeartbeat,
} from "../../src/engine/compiler-host-heartbeat";
import { openQuarantineStore } from "../../src/engine/quarantine-store";
import { openLedgerDb } from "../../src/ledger/db";
import {
  insertQueued,
  markFailed as markRunFailed,
  markRunning,
  markSucceeded,
  newRunId,
} from "../../src/ledger/runs";
import { openOutboxDb } from "../../src/outbox/db";
import {
  insertPending,
  markFailed as markOutboxFailed,
  queryOutbox,
} from "../../src/outbox/dispatch";
import { openProjectionDb } from "../../src/projections/db";
import {
  insertDiagnostic,
  queryDiagnostics,
} from "../../src/projections/diagnostics";
import {
  insertQuestion,
  queryQuestionRecords,
} from "../../src/projections/questions";

const STATUS_JSON_KEYS = Object.freeze([
  "vault",
  "branch",
  "head",
  "adopted",
  "sync_needed",
  "pending_commits",
  "adopted_diverged",
  "attention_required",
  "attention",
  "dirty_modified",
  "dirty_untracked",
  "content_pages",
  "wiki_pages",
  "notes_pages",
  "inbox_pages",
  "wikilinks",
  "raw_files",
  "raw_bytes",
  "last_sync",
  "pending_runs",
  "failed_runs",
  "recent_processor_runs",
  "serve_status",
  "serve_pid",
  "serve_branch",
  "serve_updated_at",
  "diagnostics",
  "questions",
  "outbox_pending",
  "outbox_failed",
  "quarantined",
]);

// ----- Console capture ------------------------------------------------------
//
// Each test silences console.log / console.error so the suite output stays
// quiet. The captured strings are exposed via the `captured` object in
// case a test wants to inspect them.

type Captured = {
  out: string[];
  err: string[];
};

let captured: Captured;
let origLog: typeof console.log;
let origErr: typeof console.error;

beforeEach(() => {
  captured = { out: [], err: [] };
  origLog = console.log;
  origErr = console.error;
  console.log = (...parts: unknown[]) => {
    captured.out.push(parts.map((p) => String(p)).join(" "));
  };
  console.error = (...parts: unknown[]) => {
    captured.err.push(parts.map((p) => String(p)).join(" "));
  };
});

afterEach(() => {
  console.log = origLog;
  console.error = origErr;
});

// ----- Fixture helpers -------------------------------------------------------

type Fixture = {
  vaultPath: string;
  baseSha: string;
  headSha: string;
  cleanup: () => Promise<void>;
};

/**
 * Build a fresh tmpdir vault with two commits. The two commits give
 * submit something to propose (base = first commit, head = second
 * commit). Phase 11f: no bundle copy — the CLI defaults `bundlesRoot`
 * to the SDK's shipped first-party bundles via
 * `resolveShippedBundlesRoot`. The vault path is a fresh tmpdir; the
 * cleanup removes it after the test.
 */
async function makeFixture(): Promise<Fixture> {
  const vaultPath = mkdtempSync(join(tmpdir(), "cli-commands-"));
  await initRepo(vaultPath);
  await mkdir(join(vaultPath, "wiki"), { recursive: true });

  await writeFile(join(vaultPath, "wiki/seed.md"), "seed\n");
  const baseSha = await commit({
    path: vaultPath,
    message: "init\n",
    files: ["wiki/seed.md"],
  });

  await writeFile(join(vaultPath, "wiki/new.md"), "new page\n");
  const headSha = await commit({
    path: vaultPath,
    message: "add wiki/new.md\n",
    files: ["wiki/new.md"],
  });

  // `.dome/state/` is where the engine writes sqlite handles; the runtime
  // creates it on open, but pre-creating mirrors what `dome init` does
  // and keeps the test's setup explicit.
  await mkdir(join(vaultPath, ".dome", "state"), { recursive: true });

  return {
    vaultPath,
    baseSha,
    headSha,
    cleanup: async () => {
      await rm(vaultPath, { recursive: true, force: true });
    },
  };
}

const fixtures: Fixture[] = [];
afterEach(async () => {
  while (fixtures.length > 0) {
    const f = fixtures.pop();
    if (f !== undefined) await f.cleanup();
  }
});

async function seedUnhealthyOperationalState(f: Fixture): Promise<void> {
  const adoptedCommit = commitOid(f.headSha);
  const ref = sourceRef({
    commit: adoptedCommit,
    path: "wiki/seed.md",
  });

  const outbox = await openOutboxDb({
    path: join(f.vaultPath, ".dome", "state", "outbox.db"),
  });
  if (!outbox.ok) {
    throw new Error(`outbox open failed: ${outbox.error.kind}`);
  }
  try {
    insertPending(outbox.value.db, {
      effect: externalActionEffect({
        capability: "calendar.write",
        idempotencyKey: "doctor-failed",
        payload: { event: "failed" },
        sourceRefs: [ref],
      }),
      runId: "run-doctor-outbox",
    });
    markOutboxFailed(outbox.value.db, "doctor-failed", "terminal failure");
  } finally {
    outbox.value.db.close();
  }

  const ledger = await openLedgerDb({
    path: join(f.vaultPath, ".dome", "state", "runs.db"),
  });
  if (!ledger.ok) {
    throw new Error(`ledger open failed: ${ledger.error.kind}`);
  }
  try {
    const runId = newRunId(new Date(0), () => "doctor");
    insertQueued(ledger.value.db, {
      id: runId,
      proposalId: null,
      processorId: "test.doctor",
      processorVersion: "0.0.1",
      phase: "garden",
      inputCommit: adoptedCommit,
      triggerKind: "schedule",
      triggerPayload: { test: true },
      startedAt: new Date(0),
    });
    markRunning(ledger.value.db, runId, new Date(1));
  } finally {
    ledger.value.db.close();
  }

  const quarantine = openQuarantineStore({
    path: join(f.vaultPath, ".dome", "state", "quarantined.json"),
    quarantineThreshold: 2,
  });
  if (!quarantine.ok) {
    throw new Error(`quarantine open failed: ${quarantine.error.kind}`);
  }
  const key = Object.freeze({
    phase: "garden" as const,
    processorId: "test.doctor",
    processorVersion: "0.0.1",
    triggerHash: "doctor-trigger",
  });
  quarantine.value.recordRetryableTerminalFailure(key, "first");
  quarantine.value.recordRetryableTerminalFailure(key, "second");
}

// ----- runInit --------------------------------------------------------------

describe("runInit", () => {
  test("fresh dir → scaffold: dirs, config, orientation files, git+HEAD (no bundle copy)", async () => {
    // Fresh tmpdir — no git repo, no .dome/, no AGENTS.md / CLAUDE.md.
    const target = mkdtempSync(join(tmpdir(), "cli-init-"));
    try {
      const code = await runInit({ path: target });
      expect(code).toBe(0);

      // Scaffold dirs. `.dome/extensions/` is NOT created — the shipped
      // first-party bundles live with the SDK, not in the vault.
      expect(existsSync(join(target, "wiki"))).toBe(true);
      expect(existsSync(join(target, "notes"))).toBe(true);
      expect(existsSync(join(target, "inbox", "raw"))).toBe(true);
      expect(existsSync(join(target, "inbox", "processed"))).toBe(true);
      expect(existsSync(join(target, ".dome", "state"))).toBe(true);
      expect(existsSync(join(target, ".dome", "extensions"))).toBe(false);

      // No bundle directories under .dome/extensions/.
      expect(
        existsSync(join(target, ".dome", "extensions", "dome.lint")),
      ).toBe(false);
      expect(
        existsSync(join(target, ".dome", "extensions", "dome.markdown")),
      ).toBe(false);

      // config.yaml + orientation files present with expected anchors.
      const configPath = join(target, ".dome", "config.yaml");
      expect(existsSync(configPath)).toBe(true);
      const configBody = await readFile(configPath, "utf8");
      expect(configBody).toContain("dome.graph");
      expect(configBody).toContain("dome.lint");
      expect(configBody).toContain("dome.markdown");
      expect(configBody).toContain("max_iterations");
      expect(parseYaml(configBody)).toEqual(defaultConfigRecord());

      const agentsPath = join(target, "AGENTS.md");
      expect(existsSync(agentsPath)).toBe(true);
      const agentsBody = await readFile(agentsPath, "utf8");
      expect(agentsBody).toContain("This is a Dome vault");
      expect(agentsBody).toContain("## Daily loop");
      expect(agentsBody).toContain("Commit each coherent unit of work");
      expect(agentsBody).toContain("Dome works at the git commit boundary");
      expect(agentsBody).toContain("dome today");
      expect(agentsBody).toContain("dome prep");
      expect(agentsBody).toContain("dome export-context <topic>");
      expect(agentsBody).toContain("dome lint");
      expect(agentsBody).toContain("dome inspect questions");
      expect(agentsBody).toContain("dome answer <id> <value>");
      expect(agentsBody).toContain("dome rebuild");
      expect(agentsBody).toContain("inbox/raw/");
      expect(agentsBody).toContain("dome.intake");
      expect(agentsBody).toContain("Do not edit or commit it");
      expect(agentsBody).toContain("<!-- BEGIN user-prose -->");
      expect(agentsBody).toContain("<!-- END user-prose -->");
      expect(agentsBody).not.toContain("git worktree add");

      const claudePath = join(target, "CLAUDE.md");
      expect(existsSync(claudePath)).toBe(true);
      const claudeBody = await readFile(claudePath, "utf8");
      expect(claudeBody.startsWith("@AGENTS.md")).toBe(true);
      expect(claudeBody).toContain("dome status");
      expect(claudeBody).toContain("dome sync");
      expect(claudeBody).toContain("dome today");
      expect(claudeBody).toContain("dome prep");
      expect(claudeBody).toContain("dome query");
      expect(claudeBody).toContain("dome export-context");
      expect(claudeBody).toContain("dome inspect <subject>");
      expect(claudeBody).not.toContain("only use `dome status`");
      expect(captured.out.join("\n")).toContain("CLAUDE.md:");
      expect(captured.out.join("\n")).toContain("inbox/raw/:");

      // Git initialized + HEAD resolves (the initial scaffold commit landed).
      expect(existsSync(join(target, ".git"))).toBe(true);
      const head = await currentSha(target);
      expect(head).not.toBeNull();
      if (head !== null) {
        expect(
          await readBlob({ path: target, commit: head, filepath: "AGENTS.md" }),
        ).toBe(agentsBody);
        expect(
          await readBlob({ path: target, commit: head, filepath: "CLAUDE.md" }),
        ).toBe(claudeBody);
      }

      // The SDK-shipped bundles are still loadable from the resolved
      // shipped-bundles root. This is the load-bearing assertion that
      // replaces the dropped per-file bundle-copy checks above.
      const bundlesRoot = resolveShippedBundlesRoot();
      const loaded = await loadBundles({ bundlesRoot });
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        const ids = loaded.value.map((b) => b.id);
        expect(ids).toContain("dome.graph");
        expect(ids).toContain("dome.intake");
        expect(ids).toContain("dome.lint");
        expect(ids).toContain("dome.markdown");
      }
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  test("is idempotent — re-run leaves orientation files byte-identical + no errors", async () => {
    const target = mkdtempSync(join(tmpdir(), "cli-init-idem-"));
    try {
      expect(await runInit({ path: target })).toBe(0);

      const agentsPath = join(target, "AGENTS.md");
      const claudePath = join(target, "CLAUDE.md");
      const configPath = join(target, ".dome", "config.yaml");
      const firstAgents = await readFile(agentsPath, "utf8");
      const firstClaude = await readFile(claudePath, "utf8");
      const firstConfig = await readFile(configPath, "utf8");
      const firstHead = await currentSha(target);

      // Mutate the user-prose region and Claude-specific shim notes to
      // confirm `dome init` doesn't clobber post-init edits.
      const mutatedAgents = firstAgents.replace(
        "<!-- BEGIN user-prose -->",
        "<!-- BEGIN user-prose -->\n\nMy private vault notes.",
      );
      const mutatedClaude = `${firstClaude}\nPersonal Claude Code reminder.\n`;
      await writeFile(agentsPath, mutatedAgents, "utf8");
      await writeFile(claudePath, mutatedClaude, "utf8");

      expect(await runInit({ path: target })).toBe(0);

      const secondAgents = await readFile(agentsPath, "utf8");
      const secondClaude = await readFile(claudePath, "utf8");
      const secondConfig = await readFile(configPath, "utf8");
      const secondHead = await currentSha(target);

      // Orientation mutations survive re-init; config untouched; HEAD
      // didn't advance (no second commit landed).
      expect(secondAgents).toBe(mutatedAgents);
      expect(secondClaude).toBe(mutatedClaude);
      expect(secondConfig).toBe(firstConfig);
      expect(secondHead).toBe(firstHead);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  test("--refresh-config adds missing first-party bundles and fills default grant keys", async () => {
    const target = mkdtempSync(join(tmpdir(), "cli-init-refresh-"));
    try {
      await mkdir(join(target, ".dome"), { recursive: true });
      const configPath = join(target, ".dome", "config.yaml");
      await writeFile(
        configPath,
        "extensions:\n" +
          "  dome.lint:\n" +
          "    enabled: true\n" +
          "  dome.markdown:\n" +
          "    enabled: true\n" +
          "    grant:\n" +
          "      read:\n" +
          "        - \"notes/**/*.md\"\n" +
          "  dome.search:\n" +
          "    enabled: true\n" +
          "    grants:\n" +
          "      read:\n" +
          "        - \"wiki/**/*.md\"\n" +
          "  dome.health:\n" +
          "    enabled: false\n" +
          "  custom.local:\n" +
          "    enabled: true\n" +
          "engine:\n" +
          "  max_iterations: 25\n",
        "utf8",
      );

      expect(await runInit({ path: target, refreshConfig: true })).toBe(0);
      const refreshed = parseYaml(await readFile(configPath, "utf8")) as {
        readonly extensions: Record<string, {
          readonly enabled?: boolean;
          readonly grant?: Record<string, unknown>;
          readonly grants?: Record<string, unknown>;
        }>;
        readonly engine: { readonly max_iterations: number };
      };

      expect(refreshed.extensions["dome.lint"]?.grant?.read).toEqual([
        "**/*.md",
      ]);
      expect(refreshed.extensions["dome.markdown"]?.grant?.read).toEqual([
        "notes/**/*.md",
      ]);
      expect(refreshed.extensions["dome.markdown"]?.grant?.["patch.auto"])
        .toEqual(["**/*.md"]);
      expect(refreshed.extensions["dome.markdown"]?.grant?.["question.ask"])
        .toBe(true);
      expect(refreshed.extensions["dome.search"]?.grants?.read).toEqual([
        "wiki/**/*.md",
      ]);
      expect(refreshed.extensions["dome.search"]?.grants?.["search.write"])
        .toEqual(["**/*.md"]);
      expect(refreshed.extensions["dome.graph"]?.grant?.["graph.write"])
        .toEqual(["dome.graph.*"]);
      expect(refreshed.extensions["dome.daily"]?.enabled).toBe(true);
      expect(refreshed.extensions["dome.daily"]?.grant?.["patch.auto"])
        .toEqual(["wiki/**/*.md"]);
      expect(refreshed.extensions["dome.health"]?.enabled).toBe(false);
      expect(refreshed.extensions["dome.intake"]?.enabled).toBe(false);
      expect(refreshed.extensions["custom.local"]?.grant).toBeUndefined();
      expect(refreshed.engine.max_iterations).toBe(25);

      const firstRefresh = await readFile(configPath, "utf8");
      expect(await runInit({ path: target, refreshConfig: true })).toBe(0);
      expect(await readFile(configPath, "utf8")).toBe(firstRefresh);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  test("--refresh-instructions repairs old orientation shims", async () => {
    const target = mkdtempSync(join(tmpdir(), "cli-init-instructions-"));
    try {
      await writeFile(
        join(target, "AGENTS.md"),
        "# Old instructions\n\nKeep this vault-specific guidance.\n",
        "utf8",
      );
      await writeFile(
        join(target, "CLAUDE.md"),
        "# Work Knowledge Base\n\nOld Claude-specific memory.\n",
        "utf8",
      );

      expect(await runInit({ path: target, refreshInstructions: true })).toBe(0);

      const agents = await readFile(join(target, "AGENTS.md"), "utf8");
      const claude = await readFile(join(target, "CLAUDE.md"), "utf8");
      expect(agents).toContain("# Old instructions");
      expect(agents).toContain("Keep this vault-specific guidance.");
      expect(agents).toContain("<!-- BEGIN user-prose -->");
      expect(agents).toContain("<!-- END user-prose -->");
      expect(claude.startsWith("@AGENTS.md\n\n# Work Knowledge Base")).toBe(true);
      expect(claude).toContain("Old Claude-specific memory.");

      const firstAgents = agents;
      const firstClaude = claude;
      expect(await runInit({ path: target, refreshInstructions: true })).toBe(0);
      expect(await readFile(join(target, "AGENTS.md"), "utf8")).toBe(firstAgents);
      expect(await readFile(join(target, "CLAUDE.md"), "utf8")).toBe(firstClaude);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  test(
    "end-to-end demo: init → sync init → broken wikilink commit → sync → diagnostic lands",
    async () => {
      const target = mkdtempSync(join(tmpdir(), "cli-init-e2e-"));
      try {
        // Step 1: dome init produces a fully-scaffolded vault with an
        //         initial commit on `main` (HEAD resolves; the adopted
        //         ref is still uninitialized — first `dome sync`
        //         empty-diff-initializes it).
        expect(await runInit({ path: target })).toBe(0);

        // Phase 11f: `dome sync` defaults `--bundles-root` to the SDK's
        // shipped `assets/extensions/` directory via
        // `resolveShippedBundlesRoot`. The vault doesn't carry any
        // bundle copies; the runtime resolves them at the SDK source.
        // This test runs without `--bundles-root` to exercise the
        // production demo path.

        // Step 2: initialize the adopted ref. Per detectDrift, an
        //         uninitialized adopted ref surfaces as an empty-diff
        //         drift (base === head === HEAD); the engine runs a
        //         no-effect iteration and advances the ref so the next
        //         sync can compute a real diff.
        expect(
          await runSync({ vault: target }),
        ).toBe(0);

        // Step 3: user writes a markdown file with a broken wikilink.
        await writeFile(join(target, "wiki", "foo.md"), "[[broken]]\n", "utf8");

        // Step 4: user commits the new file.
        await commit({
          path: target,
          message: "add wiki/foo.md\n",
          files: ["wiki/foo.md"],
        });

        // Step 5: dome sync — this run sees base=initial-scaffold,
        //         head=new-commit, emits `file.created` +
        //         `document.changed` for wiki/foo.md, and
        //         dome.markdown.validate-wikilinks fires.
        expect(
          await runSync({ vault: target }),
        ).toBe(0);

        // Step 6: the broken-wikilink diagnostic lands in the projection.
        const projectionPath = join(target, ".dome", "state", "projection.db");
        expect(existsSync(projectionPath)).toBe(true);

        const projectionResult = await openProjectionDb({
          path: projectionPath,
          extensionSet: [
            { name: "dome.lint", version: "0.1.0" },
            { name: "dome.markdown", version: "0.1.0" },
          ],
          processorVersions: [
            { id: "dome.lint.report", version: "0.1.0" },
            { id: "dome.markdown.validate-wikilinks", version: "0.1.0" },
          ],
          capabilityPolicyHash: "test-policy",
        });
        expect(projectionResult.ok).toBe(true);
        if (!projectionResult.ok) return;

        try {
          const diagnostics = queryDiagnostics(projectionResult.value.db);
          const broken = diagnostics.find(
            (d) => d.code === "dome.markdown.broken-wikilink",
          );
          expect(broken).toBeDefined();
          expect(broken?.message).toContain("[[broken]]");
        } finally {
          projectionResult.value.db.close();
        }

        // Step 7: the broken-wikilink must also appear in the user-facing
        // CLI output. Regression: before queryDiagnostics ordered DESC, a
        // user with N>20 accumulated diagnostics couldn't see freshly-
        // emitted ones in `dome inspect diagnostics`'s default view. The
        // DB had the row; the CLI didn't surface it. This step is the
        // structural fence against that class of UX bug: we assert the
        // freshest diagnostic appears in the CLI's default-limit output.
        captured.out = [];
        captured.err = [];
        const inspectCode = await runInspect(
          { subject: "diagnostics", vault: target },
        );
        expect(inspectCode).toBe(0);
        const inspectOut = captured.out.join("\n");
        expect(inspectOut).toContain("[[broken]]");
      } finally {
        await rm(target, { recursive: true, force: true });
      }
    },
    // The end-to-end test spins up two full adoption runs (the
    // empty-diff init + the wiki/foo.md drift) and opens four sqlite
    // handles across the engine + the test's direct projection read.
    // 30s is comfortably above the observed runtime on CI.
    30_000,
  );

  test(
    "default CLI bundle roots compose shipped bundles with vault-local bundles",
    async () => {
      const target = mkdtempSync(join(tmpdir(), "cli-local-bundle-"));
      try {
        expect(await runInit({ path: target })).toBe(0);
        await writeLocalDiagnosticBundle(target);
        await appendLocalBundleConfig(target);
        await commit({
          path: target,
          message: "enable custom local bundle\n",
          files: [
            ".dome/config.yaml",
            ".dome/extensions/custom.local/manifest.json",
            ".dome/extensions/custom.local/processors/audit.ts",
          ],
        });

        expect(await runSync({ vault: target })).toBe(0);

        await writeFile(
          join(target, "wiki", "local.md"),
          "# Local bundle proof\n",
          "utf8",
        );
        await commit({
          path: target,
          message: "add local bundle proof page\n",
          files: ["wiki/local.md"],
        });

        expect(await runSync({ vault: target })).toBe(0);

        captured.out = [];
        captured.err = [];
        const inspectCode = await runInspect({
          subject: "diagnostics",
          vault: target,
          code: "custom.local.seen",
          json: true,
        });
        expect(inspectCode).toBe(0);
        const diagnostics = JSON.parse(captured.out.join("\n")) as ReadonlyArray<{
          readonly code: string;
          readonly message: string;
        }>;
        expect(diagnostics).toContainEqual(
          expect.objectContaining({
            code: "custom.local.seen",
            message: "Vault-local bundle ran through the default composed root.",
          }),
        );
      } finally {
        await rm(target, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test(
    "vault-local bundle external handlers dispatch ExternalActionEffect rows",
    async () => {
      const target = mkdtempSync(join(tmpdir(), "cli-local-handler-"));
      try {
        expect(await runInit({ path: target })).toBe(0);
        await writeLocalExternalHandlerBundle(target);
        await appendLocalExternalHandlerConfig(target);
        await commit({
          path: target,
          message: "enable local external handler bundle\n",
          files: [
            ".dome/config.yaml",
            ".dome/extensions/custom.external/manifest.json",
            ".dome/extensions/custom.external/processors/emit.ts",
            ".dome/extensions/custom.external/external-handlers/calendar.write.ts",
          ],
        });

        expect(await runSync({ vault: target })).toBe(0);

        await writeFile(
          join(target, "wiki", "handler.md"),
          "# Handler proof\n",
          "utf8",
        );
        await commit({
          path: target,
          message: "trigger local external handler\n",
          files: ["wiki/handler.md"],
        });

        expect(await runSync({ vault: target })).toBe(0);

        const outboxResult = await openOutboxDb({
          path: join(target, ".dome", "state", "outbox.db"),
        });
        expect(outboxResult.ok).toBe(true);
        if (!outboxResult.ok) return;
        try {
          const row = queryOutbox(outboxResult.value.db, {
            capability: "calendar.write",
          })[0];
          expect(row).toEqual(
            expect.objectContaining({
              idempotencyKey: "custom.external:wiki/handler.md",
              status: "sent",
              externalId: "local-handler:wiki/handler.md",
            }),
          );
        } finally {
          outboxResult.value.db.close();
        }
      } finally {
        await rm(target, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

async function appendLocalBundleConfig(target: string): Promise<void> {
  const configPath = join(target, ".dome", "config.yaml");
  const config = await readFile(configPath, "utf8");
  const localBundleStanza = `  custom.local:
    enabled: true
    grant:
      read: ["wiki/**/*.md"]
`;
  await writeFile(
    configPath,
    config.replace("\nengine:\n", `\n${localBundleStanza}\nengine:\n`),
    "utf8",
  );
}

async function writeLocalDiagnosticBundle(target: string): Promise<void> {
  const bundleDir = join(target, ".dome", "extensions", "custom.local");
  const processorsDir = join(bundleDir, "processors");
  await mkdir(processorsDir, { recursive: true });
  await writeFile(
    join(bundleDir, "manifest.json"),
    JSON.stringify({
      id: "custom.local",
      version: "0.1.0",
      processors: [
        {
          id: "custom.local.audit",
          version: "0.1.0",
          phase: "adoption",
          triggers: [
            {
              kind: "signal",
              name: "file.created",
              pathPattern: "wiki/**/*.md",
            },
          ],
          capabilities: [{ kind: "read", paths: ["wiki/**/*.md"] }],
          module: "processors/audit.ts",
        },
      ],
    }),
    "utf8",
  );
  await writeFile(
    join(processorsDir, "audit.ts"),
    `
      export default {
        async run(ctx) {
          return [{
            kind: "diagnostic",
            severity: "info",
            code: "custom.local.seen",
            message: "Vault-local bundle ran through the default composed root.",
            sourceRefs: [ctx.sourceRef("wiki/local.md")],
          }];
        },
      };
    `,
    "utf8",
  );
}

async function appendLocalExternalHandlerConfig(target: string): Promise<void> {
  const configPath = join(target, ".dome", "config.yaml");
  const config = await readFile(configPath, "utf8");
  const localBundleStanza = `  custom.external:
    enabled: true
    grant:
      read: ["wiki/**/*.md"]
      external: ["calendar.write"]
`;
  await writeFile(
    configPath,
    config.replace("\nengine:\n", `\n${localBundleStanza}\nengine:\n`),
    "utf8",
  );
}

async function writeLocalExternalHandlerBundle(target: string): Promise<void> {
  const bundleDir = join(target, ".dome", "extensions", "custom.external");
  const processorsDir = join(bundleDir, "processors");
  const handlersDir = join(bundleDir, "external-handlers");
  await mkdir(processorsDir, { recursive: true });
  await mkdir(handlersDir, { recursive: true });
  await writeFile(
    join(bundleDir, "manifest.json"),
    JSON.stringify({
      id: "custom.external",
      version: "0.1.0",
      processors: [
        {
          id: "custom.external.emit",
          version: "0.1.0",
          phase: "garden",
          triggers: [
            {
              kind: "signal",
              name: "file.created",
              pathPattern: "wiki/handler.md",
            },
          ],
          capabilities: [
            { kind: "read", paths: ["wiki/**/*.md"] },
            { kind: "external", capability: "calendar.write" },
          ],
          module: "processors/emit.ts",
        },
      ],
    }),
    "utf8",
  );
  await writeFile(
    join(processorsDir, "emit.ts"),
    `
      export default {
        async run(ctx) {
          const path = "wiki/handler.md";
          const content = await ctx.snapshot.readFile(path);
          if (content === null) return [];
          return [{
            kind: "external",
            capability: "calendar.write",
            idempotencyKey: "custom.external:" + path,
            payload: { path },
            sourceRefs: [ctx.sourceRef(path)],
          }];
        },
      };
    `,
    "utf8",
  );
  await writeFile(
    join(handlersDir, "calendar.write.ts"),
    `
      export default async function handle(input) {
        return { externalId: "local-handler:" + input.payload.path };
      }
    `,
    "utf8",
  );
}

// ----- runInspect -----------------------------------------------------------
//
// `dome inspect <subject>` is the v1.0 read surface for the operational
// substrate (renamed from the pre-recut `dome doctor --show <subject>`
// shape per [[wiki/specs/cli]] §"dome inspect"). Subject is positional,
// not a flag; v1.0 ships four subjects (runs, diagnostics, questions,
// outbox), each backed by an existing query function.

describe("runInspect", () => {
  test("subject 'runs' returns 0 on a fresh vault with an empty-table message", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    const code = await runInspect({ subject: "runs", vault: f.vaultPath });
    expect(code).toBe(0);
    expect(captured.out.join("\n")).toContain("(no rows)");
  });

  test("subject 'diagnostics' returns source locations", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    const projection = await openProjectionDb({
      path: join(f.vaultPath, ".dome", "state", "projection.db"),
      extensionSet: [],
      processorVersions: [],
      capabilityPolicyHash: "test-policy",
    });
    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    try {
      insertDiagnostic(projection.value.db, {
        effect: diagnosticEffect({
          severity: "warning",
          code: "test.diagnostic",
          message: "Needs a source location",
          sourceRefs: [
            sourceRef({
              commit: commitOid(f.headSha),
              path: "wiki/new.md",
              range: {
                startLine: 3,
                endLine: 5,
              },
            }),
          ],
        }),
        processorId: "test.cli",
        proposalId: "prop_cli",
        adoptedCommit: commitOid(f.headSha),
      });
    } finally {
      projection.value.db.close();
    }

    expect(
      await runInspect({ subject: "diagnostics", vault: f.vaultPath }),
    ).toBe(0);
    const out = captured.out.join("\n");
    expect(out).toContain("test.diagnostic");
    expect(out).toContain("wiki/new.md:3-5");
  });

  test("diagnostics --summary groups by severity and code", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    const projection = await openProjectionDb({
      path: join(f.vaultPath, ".dome", "state", "projection.db"),
      extensionSet: [],
      processorVersions: [],
      capabilityPolicyHash: "test-policy",
    });
    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    try {
      insertDiagnostic(projection.value.db, {
        effect: diagnosticEffect({
          severity: "warning",
          code: "test.repeated",
          message: "First repeated diagnostic",
          sourceRefs: [
            sourceRef({ commit: commitOid(f.headSha), path: "wiki/new.md" }),
          ],
        }),
        processorId: "test.cli",
        proposalId: "prop_cli_summary",
        adoptedCommit: commitOid(f.headSha),
      });
      insertDiagnostic(projection.value.db, {
        effect: diagnosticEffect({
          severity: "warning",
          code: "test.repeated",
          message: "Second repeated diagnostic",
          sourceRefs: [
            sourceRef({ commit: commitOid(f.headSha), path: "wiki/seed.md" }),
          ],
        }),
        processorId: "test.cli",
        proposalId: "prop_cli_summary",
        adoptedCommit: commitOid(f.headSha),
      });
      insertDiagnostic(projection.value.db, {
        effect: diagnosticEffect({
          severity: "error",
          code: "test.single",
          message: "Single diagnostic",
          sourceRefs: [
            sourceRef({ commit: commitOid(f.headSha), path: "wiki/other.md" }),
          ],
        }),
        processorId: "test.other",
        proposalId: "prop_cli_summary",
        adoptedCommit: commitOid(f.headSha),
      });
    } finally {
      projection.value.db.close();
    }

    expect(
      await runInspect({
        subject: "diagnostics",
        vault: f.vaultPath,
        summary: true,
        json: true,
      }),
    ).toBe(0);
    const payload = JSON.parse(captured.out.join("\n")) as {
      readonly total: number;
      readonly group_count: number;
      readonly groups: ReadonlyArray<{
        readonly severity: string;
        readonly code: string;
        readonly count: number;
        readonly first_source_refs: string;
      }>;
    };
    expect(payload.total).toBe(3);
    expect(payload.group_count).toBe(2);
    expect(payload.groups[0]).toEqual(
      expect.objectContaining({
        severity: "warning",
        code: "test.repeated",
        count: 2,
      }),
    );
    expect(payload.groups[0]?.first_source_refs).toContain("wiki/seed.md");
  });

  test("diagnostics filters by severity, code, and processor", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    const projection = await openProjectionDb({
      path: join(f.vaultPath, ".dome", "state", "projection.db"),
      extensionSet: [],
      processorVersions: [],
      capabilityPolicyHash: "test-policy",
    });
    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    try {
      insertDiagnostic(projection.value.db, {
        effect: diagnosticEffect({
          severity: "warning",
          code: "test.keep",
          message: "Keep this diagnostic",
          sourceRefs: [
            sourceRef({ commit: commitOid(f.headSha), path: "wiki/new.md" }),
          ],
        }),
        processorId: "test.keep",
        proposalId: "prop_cli_filters",
        adoptedCommit: commitOid(f.headSha),
      });
      insertDiagnostic(projection.value.db, {
        effect: diagnosticEffect({
          severity: "error",
          code: "test.drop",
          message: "Drop this diagnostic",
          sourceRefs: [
            sourceRef({ commit: commitOid(f.headSha), path: "wiki/seed.md" }),
          ],
        }),
        processorId: "test.drop",
        proposalId: "prop_cli_filters",
        adoptedCommit: commitOid(f.headSha),
      });
    } finally {
      projection.value.db.close();
    }

    expect(
      await runInspect({
        subject: "diagnostics",
        vault: f.vaultPath,
        severity: "warning",
        code: "test.keep",
        processor: "test.keep",
        json: true,
      }),
    ).toBe(0);
    const rows = JSON.parse(captured.out.join("\n")) as ReadonlyArray<{
      readonly severity: string;
      readonly code: string;
      readonly message: string;
    }>;
    expect(rows).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "test.keep",
        message: "Keep this diagnostic",
      }),
    ]);
  });

  test("subjects 'questions' and 'outbox' both return 0", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    expect(
      await runInspect(
        { subject: "questions", vault: f.vaultPath },
      ),
    ).toBe(0);
    expect(
      await runInspect(
        { subject: "outbox", vault: f.vaultPath },
      ),
    ).toBe(0);
  });

  test("corrupt operational JSON returns a clear state-read failure", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    expect(
      await runInspect(
        { subject: "outbox", vault: f.vaultPath },
      ),
    ).toBe(0);
    const db = new Database(join(f.vaultPath, ".dome", "state", "outbox.db"));
    try {
      const now = new Date().toISOString();
      db.query(
        "INSERT INTO outbox (capability, idempotency_key, payload_json, source_refs, status, attempts, max_attempts, enqueued_at, next_attempt_at, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "calendar.write",
        "bad-json",
        "{not-json",
        "[]",
        "pending",
        0,
        3,
        now,
        now,
        "run_bad_json",
      );
    } finally {
      db.close();
    }

    const code = await runInspect(
      { subject: "outbox", vault: f.vaultPath },
    );
    expect(code).toBe(1);
    expect(captured.err.join("\n")).toContain("state read failed");
    expect(captured.err.join("\n")).toContain(
      "operational database may be corrupt",
    );
  });

  test("missing positional subject returns 64 (EX_USAGE)", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    expect(await runInspect({ vault: f.vaultPath })).toBe(64);
  });

  test("unknown subject returns 64", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    expect(
      await runInspect({ subject: "garbage", vault: f.vaultPath }),
    ).toBe(64);
  });

  test("malformed --limit returns 64 before opening runtime", async () => {
    expect(await runInspect({ subject: "runs", limit: "10x" })).toBe(64);
    expect(captured.err.join("\n")).toContain(
      "--limit must be a positive integer",
    );
  });

  test("diagnostic-only flags reject other subjects", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    expect(
      await runInspect({
        subject: "runs",
        vault: f.vaultPath,
        summary: true,
      }),
    ).toBe(64);
    expect(captured.err.join("\n")).toContain(
      "only valid for the diagnostics subject",
    );
  });

  test("invalid diagnostic severity returns 64", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    expect(
      await runInspect({
        subject: "diagnostics",
        vault: f.vaultPath,
        severity: "fatal",
      }),
    ).toBe(64);
    expect(captured.err.join("\n")).toContain(
      "--severity must be one of info, warning, error, block",
    );
  });
});

// ----- runAnswer ------------------------------------------------------------

describe("runAnswer", () => {
  test("records an answer by question row id", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    const projection = await openProjectionDb({
      path: join(f.vaultPath, ".dome", "state", "projection.db"),
      extensionSet: [],
      processorVersions: [],
      capabilityPolicyHash: "test-policy",
    });
    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    const adopted = commitOid(f.headSha);
    const effect = questionEffect({
      question: "Are these duplicates?",
      sourceRefs: [sourceRef({ commit: adopted, path: "wiki/new.md" })],
      idempotencyKey: "cli-question-1",
      options: ["merge", "keep"],
    });
    insertQuestion(projection.value.db, {
      effect,
      processorId: "test.cli",
      adoptedCommit: adopted,
    });
    const id = queryQuestionRecords(projection.value.db)[0]?.id;
    projection.value.db.close();
    expect(id).toBeGreaterThan(0);
    if (id === undefined) return;

    const code = await runAnswer({
      id,
      value: "keep",
      vault: f.vaultPath,
      json: true,
    });
    expect(code).toBe(0);

    const after = await openProjectionDb({
      path: join(f.vaultPath, ".dome", "state", "projection.db"),
      extensionSet: [],
      processorVersions: [],
      capabilityPolicyHash: "test-policy",
    });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    try {
      const record = queryQuestionRecords(after.value.db)[0];
      expect(record?.answer).toBe("keep");
      expect(record?.answeredAt).not.toBeNull();
    } finally {
      after.value.db.close();
    }
  });

  test("rejects invalid options without answering", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    const projection = await openProjectionDb({
      path: join(f.vaultPath, ".dome", "state", "projection.db"),
      extensionSet: [],
      processorVersions: [],
      capabilityPolicyHash: "test-policy",
    });
    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    const adopted = commitOid(f.headSha);
    insertQuestion(projection.value.db, {
      effect: questionEffect({
        question: "Pick one",
        sourceRefs: [sourceRef({ commit: adopted, path: "wiki/new.md" })],
        idempotencyKey: "cli-question-2",
        options: ["yes", "no"],
      }),
      processorId: "test.cli",
      adoptedCommit: adopted,
    });
    const id = queryQuestionRecords(projection.value.db)[0]?.id;
    projection.value.db.close();
    expect(id).toBeGreaterThan(0);
    if (id === undefined) return;

    const code = await runAnswer({
      id,
      value: "maybe",
      vault: f.vaultPath,
    });
    expect(code).toBe(64);

    const after = await openProjectionDb({
      path: join(f.vaultPath, ".dome", "state", "projection.db"),
      extensionSet: [],
      processorVersions: [],
      capabilityPolicyHash: "test-policy",
    });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    try {
      const record = queryQuestionRecords(after.value.db)[0];
      expect(record?.answer).toBeNull();
      expect(record?.answeredAt).toBeNull();
    } finally {
      after.value.db.close();
    }
  });
});

// ----- runDoctor ------------------------------------------------------------

describe("runDoctor", () => {
  test("clean vault reports ok", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeDoctorConfig(f);

    const code = await runDoctor({ vault: f.vaultPath });
    expect(code).toBe(0);
    const out = captured.out.join("\n");
    expect(out).toContain("DOME doctor");
    expect(out).toContain("health    ok");
  });

  test("--json reports failed outbox, orphan runs, and quarantines", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeDoctorConfig(f);
    await seedUnhealthyOperationalState(f);

    const code = await runDoctor({
      vault: f.vaultPath,
      json: true,
      orphanThresholdMs: 0,
    });
    expect(code).toBe(0);
    const blob = captured.out.find((line) => line.includes("\"status\""));
    expect(blob).toBeDefined();
    if (blob === undefined) return;
    const parsed = JSON.parse(blob) as {
      readonly status: string;
      readonly summary: {
        readonly findingCount: number;
        readonly failedOutbox: number;
        readonly orphanRuns: number;
        readonly quarantinedProcessors: number;
      };
      readonly findings: ReadonlyArray<{ readonly code: string }>;
    };
    expect(parsed.status).toBe("unhealthy");
    expect(parsed.summary.findingCount).toBe(3);
    expect(parsed.summary.failedOutbox).toBe(1);
    expect(parsed.summary.orphanRuns).toBe(1);
    expect(parsed.summary.quarantinedProcessors).toBe(1);
    expect(parsed.findings.map((finding) => finding.code)).toEqual([
      "outbox.failed",
      "run.orphan",
      "processor.quarantined",
    ]);
  });

  test("--json reports operational schema mismatches without opening runtime", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    const runsPath = join(f.vaultPath, ".dome", "state", "runs.db");
    const old = new Database(runsPath);
    old.run(
      "CREATE TABLE ledger_meta (schema_hash TEXT NOT NULL PRIMARY KEY, built_at TEXT NOT NULL)",
    );
    old.run("CREATE TABLE runs (id TEXT PRIMARY KEY)");
    old.run(
      "INSERT INTO ledger_meta (schema_hash, built_at) VALUES (?, ?)",
      ["unknown-ledger-schema", "2026-05-28T00:00:00.000Z"],
    );
    old.run("INSERT INTO runs (id) VALUES (?)", ["run-preserved"]);
    old.close();

    const code = await runDoctor({ vault: f.vaultPath, json: true });
    expect(code).toBe(0);
    const blob = captured.out.find((line) => line.includes("\"status\""));
    expect(blob).toBeDefined();
    if (blob === undefined) return;
    const parsed = JSON.parse(blob) as {
      readonly status: string;
      readonly summary: {
        readonly operationalSchemaMismatch: number;
      };
      readonly findings: ReadonlyArray<{
        readonly code: string;
        readonly storage: { readonly stored: string | null };
      }>;
    };
    expect(parsed.status).toBe("unhealthy");
    expect(parsed.summary.operationalSchemaMismatch).toBe(1);
    expect(parsed.findings[0]?.code).toBe("operational.schema-mismatch");
    expect(parsed.findings[0]?.storage.stored).toBe("unknown-ledger-schema");

    const check = new Database(runsPath);
    try {
      const row = check
        .query<{ id: string }, []>("SELECT id FROM runs LIMIT 1")
        .get();
      expect(row?.id).toBe("run-preserved");
    } finally {
      check.close();
    }
  });

  test("with --repair: exits 64 (not implemented yet)", async () => {
    const code = await runDoctor({ repair: true });
    expect(code).toBe(64);
    expect(captured.err.join("\n")).toContain("not implemented yet");
  });

  test("malformed --orphan-threshold-ms returns 64 before opening runtime", async () => {
    expect(await runDoctor({ orphanThresholdMs: "10x" })).toBe(64);
    expect(captured.err.join("\n")).toContain(
      "--orphan-threshold-ms must be a non-negative integer",
    );
  });
});

async function writeDoctorConfig(f: Fixture): Promise<void> {
  await writeFile(
    join(f.vaultPath, ".dome", "config.yaml"),
    "extensions: {}\n",
    "utf8",
  );
  await writeFile(
    join(f.vaultPath, "AGENTS.md"),
    [
      "# This is a Dome vault.",
      "",
      "<!-- BEGIN user-prose -->",
      "<!-- END user-prose -->",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(join(f.vaultPath, "CLAUDE.md"), "@AGENTS.md\n", "utf8");
}

// ----- runStatus ------------------------------------------------------------

describe("runStatus", () => {
  test("prints sensible defaults on a fresh (unsubmitted) vault", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    const code = await runStatus({ vault: f.vaultPath });
    expect(code).toBe(0);

    const out = captured.out.join("\n");
    expect(out).toContain("(uninitialized)"); // adopted ref
    expect(out).toContain("sync needed");
    expect(out).toContain("pending unknown");
    expect(out).toContain("(never)"); // last_sync
    expect(out).toContain("DOME status");
    expect(out).toContain("content   2 pages");
    expect(out).toContain("links 0");
    expect(out).toContain("diagnostics 0");
    expect(out).toContain("questions 0");
    expect(out).toContain("outbox 0 pending / 0 failed");
    expect(out).toContain("quarantine 0");
    expect(out).toContain("serve off");
  });

  test("--json mode emits a parseable JSON object with expected keys", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    expect(await runStatus({ vault: f.vaultPath, json: true })).toBe(0);

    const blob = captured.out.find((l) => l.includes("\"vault\""));
    expect(blob).toBeDefined();
    if (blob === undefined) return;
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([...STATUS_JSON_KEYS]);
    expect(parsed["vault"]).toBe(f.vaultPath);
    expect(parsed["branch"]).toBeDefined();
    expect(parsed["sync_needed"]).toBe(true);
    expect(parsed["pending_commits"]).toBeNull();
    expect(parsed["adopted_diverged"]).toBe(false);
    expect(parsed["attention_required"]).toBe(true);
    expect(parsed["attention"]).toEqual(
      expect.arrayContaining(["sync_needed"]),
    );
    expect(parsed["dirty_modified"]).toBe(0);
    expect(parsed["dirty_untracked"]).toBe(0);
    expect(parsed["content_pages"]).toBe(2);
    expect(parsed["wiki_pages"]).toBe(2);
    expect(parsed["notes_pages"]).toBe(0);
    expect(parsed["inbox_pages"]).toBe(0);
    expect(parsed["wikilinks"]).toBe(0);
    expect(parsed["raw_files"]).toBe(0);
    expect(parsed["raw_bytes"]).toBe(0);
    expect(parsed["pending_runs"]).toBe(0);
    expect(parsed["failed_runs"]).toBe(0);
    expect(parsed["recent_processor_runs"]).toEqual([]);
    expect(parsed["serve_status"]).toBe("off");
    expect(parsed["serve_pid"]).toBeNull();
    expect(parsed["serve_branch"]).toBeNull();
    expect(parsed["serve_updated_at"]).toBeNull();
    expect(parsed["diagnostics"]).toBe(0);
    expect(parsed["questions"]).toBe(0);
    expect(parsed["outbox_pending"]).toBe(0);
    expect(parsed["outbox_failed"]).toBe(0);
    expect(parsed["quarantined"]).toBe(0);
  });

  test("--json mode reports stale serve heartbeat", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    await writeServeHeartbeat({
      vaultPath: f.vaultPath,
      handle: createServeHeartbeatHandle(
        new Date("2026-01-01T00:00:00.000Z"),
      ),
      branch: "main",
      pollIntervalMs: 20,
      operationalIntervalMs: 20,
      now: new Date(Date.now() - 10_000),
    });

    expect(await runStatus({ vault: f.vaultPath, json: true })).toBe(0);

    const blob = captured.out.find((l) => l.includes("\"vault\""));
    expect(blob).toBeDefined();
    if (blob === undefined) return;
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    expect(parsed["serve_status"]).toBe("stale");
    expect(parsed["serve_pid"]).toBe(process.pid);
    expect(parsed["serve_branch"]).toBe("main");
    expect(typeof parsed["serve_updated_at"]).toBe("string");
  });

  test("--json mode reports invalid serve heartbeat as stale", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    await writeFile(serveHeartbeatPath(f.vaultPath), "not json\n", "utf8");

    expect(await runStatus({ vault: f.vaultPath, json: true })).toBe(0);

    const blob = captured.out.find((l) => l.includes("\"vault\""));
    expect(blob).toBeDefined();
    if (blob === undefined) return;
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    expect(parsed["serve_status"]).toBe("stale");
    expect(parsed["serve_pid"]).toBeNull();
    expect(parsed["serve_branch"]).toBeNull();
    expect(parsed["serve_updated_at"]).toBeNull();
  });

  test("--json mode reports sync drift and pending commit count", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    expect(await runSync({ vault: f.vaultPath, json: true })).toBe(0);
    const adopted = await currentSha(f.vaultPath);
    captured.out = [];
    captured.err = [];

    await writeFile(
      join(f.vaultPath, "wiki/pending.md"),
      "---\ntype: concept\n---\n# Pending\n\npending\n",
      "utf8",
    );
    const head = await commit({
      path: f.vaultPath,
      message: "add pending page\n",
      files: ["wiki/pending.md"],
    });

    expect(await runStatus({ vault: f.vaultPath, json: true })).toBe(0);

    const blob = captured.out.find((l) => l.includes("\"vault\""));
    expect(blob).toBeDefined();
    if (blob === undefined) return;
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    expect(parsed["head"]).toBe(head);
    expect(parsed["adopted"]).toBe(adopted);
    expect(parsed["sync_needed"]).toBe(true);
    expect(parsed["pending_commits"]).toBe(1);
    expect(parsed["adopted_diverged"]).toBe(false);
    expect(parsed["attention_required"]).toBe(true);
    expect(parsed["attention"]).toEqual(expect.arrayContaining(["sync_needed"]));
  });

  test("--json mode reports vault content analytics", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    await mkdir(join(f.vaultPath, "notes"), { recursive: true });
    await mkdir(join(f.vaultPath, "inbox"), { recursive: true });
    await mkdir(join(f.vaultPath, "raw"), { recursive: true });
    await writeFile(
      join(f.vaultPath, "wiki/links.md"),
      "[[wiki/seed.md]] [[notes/day.md]]\n",
      "utf8",
    );
    await writeFile(
      join(f.vaultPath, "notes/day.md"),
      "review [[wiki/new.md]]\n",
      "utf8",
    );
    await writeFile(join(f.vaultPath, "inbox/todo.md"), "- [ ] inbox\n", "utf8");
    await writeFile(join(f.vaultPath, "raw/capture.txt"), "raw", "utf8");

    expect(await runStatus({ vault: f.vaultPath, json: true })).toBe(0);

    const blob = captured.out.find((l) => l.includes("\"vault\""));
    expect(blob).toBeDefined();
    if (blob === undefined) return;
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    expect(parsed["content_pages"]).toBe(5);
    expect(parsed["wiki_pages"]).toBe(3);
    expect(parsed["notes_pages"]).toBe(1);
    expect(parsed["inbox_pages"]).toBe(1);
    expect(parsed["wikilinks"]).toBe(3);
    expect(parsed["raw_files"]).toBe(1);
    expect(parsed["raw_bytes"]).toBe(3);
    expect(parsed["dirty_untracked"]).toBe(4);
  });

  test("--json mode ignores excluded untracked files in dirty counts", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    await writeFile(
      join(f.vaultPath, ".git", "info", "exclude"),
      ".claude/\n",
      "utf8",
    );
    await mkdir(join(f.vaultPath, ".claude", "commands"), {
      recursive: true,
    });
    await writeFile(
      join(f.vaultPath, ".claude", "commands", "eod.md"),
      "local command\n",
      "utf8",
    );

    expect(await runStatus({ vault: f.vaultPath, json: true })).toBe(0);

    const blob = captured.out.find((l) => l.includes("\"vault\""));
    expect(blob).toBeDefined();
    if (blob === undefined) return;
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    expect(parsed["dirty_untracked"]).toBe(0);
    expect(parsed["attention"]).not.toContain("dirty_untracked");
  });

  test("--json mode reports operational health counts", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    const adoptedCommit = commitOid(f.headSha);
    const ref = sourceRef({
      commit: adoptedCommit,
      path: "wiki/seed.md",
    });

    const projection = await openProjectionDb({
      path: join(f.vaultPath, ".dome", "state", "projection.db"),
      extensionSet: [],
      processorVersions: [],
      capabilityPolicyHash: "test-policy",
    });
    if (!projection.ok) {
      throw new Error(`projection open failed: ${projection.error.kind}`);
    }
    try {
      insertDiagnostic(projection.value.db, {
        effect: diagnosticEffect({
          severity: "warning",
          code: "status.test",
          message: "status diagnostic",
          sourceRefs: [ref],
        }),
        processorId: "test.status",
        proposalId: null,
        adoptedCommit,
      });
      insertQuestion(projection.value.db, {
        effect: questionEffect({
          question: "Choose one?",
          options: ["one", "two"],
          sourceRefs: [ref],
          idempotencyKey: "status-question",
        }),
        processorId: "test.status",
        adoptedCommit,
      });
    } finally {
      projection.value.db.close();
    }

    const outbox = await openOutboxDb({
      path: join(f.vaultPath, ".dome", "state", "outbox.db"),
    });
    if (!outbox.ok) {
      throw new Error(`outbox open failed: ${outbox.error.kind}`);
    }
    try {
      insertPending(outbox.value.db, {
        effect: externalActionEffect({
          capability: "calendar.write",
          idempotencyKey: "status-pending",
          payload: { event: "pending" },
          sourceRefs: [ref],
        }),
        runId: "run-status-pending",
      });
      insertPending(outbox.value.db, {
        effect: externalActionEffect({
          capability: "calendar.write",
          idempotencyKey: "status-failed",
          payload: { event: "failed" },
          sourceRefs: [ref],
        }),
        runId: "run-status-failed",
      });
      markOutboxFailed(outbox.value.db, "status-failed", "terminal failure");
    } finally {
      outbox.value.db.close();
    }

    const ledger = await openLedgerDb({
      path: join(f.vaultPath, ".dome", "state", "runs.db"),
    });
    if (!ledger.ok) {
      throw new Error(`ledger open failed: ${ledger.error.kind}`);
    }
    try {
      const runId = newRunId(new Date(0), () => "status");
      const succeededRunId = newRunId(new Date(10), () => "statok");
      insertQueued(ledger.value.db, {
        id: runId,
        proposalId: null,
        processorId: "test.status",
        processorVersion: "0.0.1",
        phase: "garden",
        inputCommit: adoptedCommit,
        triggerKind: "schedule",
        triggerPayload: { test: true },
        startedAt: new Date(0),
      });
      markRunning(ledger.value.db, runId, new Date(1));
      markRunFailed(ledger.value.db, {
        id: runId,
        error: "failed",
        durationMs: 1,
        finishedAt: new Date(2),
      });
      insertQueued(ledger.value.db, {
        id: succeededRunId,
        proposalId: null,
        processorId: "test.status",
        processorVersion: "0.0.1",
        phase: "garden",
        inputCommit: adoptedCommit,
        triggerKind: "schedule",
        triggerPayload: { test: "later" },
        startedAt: new Date(10),
      });
      markRunning(ledger.value.db, succeededRunId, new Date(11));
      markSucceeded(ledger.value.db, {
        id: succeededRunId,
        effectHashes: [],
        costUsd: null,
        durationMs: 2,
        outputCommit: null,
        finishedAt: new Date(12),
      });
    } finally {
      ledger.value.db.close();
    }

    const quarantine = openQuarantineStore({
      path: join(f.vaultPath, ".dome", "state", "quarantined.json"),
      quarantineThreshold: 2,
    });
    if (!quarantine.ok) {
      throw new Error(`quarantine open failed: ${quarantine.error.kind}`);
    }
    const key = Object.freeze({
      phase: "garden" as const,
      processorId: "test.status",
      processorVersion: "0.0.1",
      triggerHash: "status-trigger",
    });
    quarantine.value.recordRetryableTerminalFailure(key, "first");
    quarantine.value.recordRetryableTerminalFailure(key, "second");

    expect(await runStatus({ vault: f.vaultPath, json: true })).toBe(0);

    const blob = captured.out.find((l) => l.includes("\"vault\""));
    expect(blob).toBeDefined();
    if (blob === undefined) return;
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    expect(parsed["diagnostics"]).toBe(1);
    expect(parsed["questions"]).toBe(1);
    expect(parsed["outbox_pending"]).toBe(1);
    expect(parsed["outbox_failed"]).toBe(1);
    expect(parsed["failed_runs"]).toBe(1);
    expect(parsed["quarantined"]).toBe(1);
    expect(parsed["attention_required"]).toBe(true);
    expect(parsed["attention"]).toEqual([
      "sync_needed",
      "failed_runs",
      "diagnostics",
      "questions",
      "outbox_pending",
      "outbox_failed",
      "quarantined",
    ]);
    expect(parsed["recent_processor_runs"]).toEqual([
      {
        processor_id: "test.status",
        processor_version: "0.0.1",
        phase: "garden",
        latest_run_id: "run_10_statok",
        latest_status: "succeeded",
        latest_started_at: new Date(10).toISOString(),
        latest_finished_at: new Date(12).toISOString(),
        latest_duration_ms: 2,
        recent_runs: 2,
        recent_problem_runs: 1,
      },
    ]);
  });

  // The "status after a submit reports the advanced adopted ref" test
  // was retired in Phase 11a along with `runSubmit`; the corresponding
  // assertion against an advanced adopted ref will land in the Phase 11b
  // daemon integration tests, which drive adoption via the watcher.
});
