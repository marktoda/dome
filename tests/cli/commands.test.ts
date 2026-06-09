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
import { runCheck } from "../../src/cli/commands/check";
import { runDoctor } from "../../src/cli/commands/doctor";
import { runExportContext } from "../../src/cli/commands/export-context";
import { runInspect } from "../../src/cli/commands/inspect";
import { runLint } from "../../src/cli/commands/lint";
import { runQuery } from "../../src/cli/commands/query";
import { runResolve } from "../../src/cli/commands/resolve";
import { runStatus } from "../../src/cli/commands/status";
import { runSync } from "../../src/cli/commands/sync";
import { resolveShippedBundlesRoot } from "../../src/cli/commands/sync-shared";
import {
  defaultModelProviderConfig,
  defaultConfigRecord,
  defaultConfigYaml,
} from "../../src/cli/default-vault-config";
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
  markTimedOut,
  newRunId,
} from "../../src/ledger/runs";
import { openOutboxDb } from "../../src/outbox/db";
import {
  insertPending,
  markFailed as markOutboxFailed,
  queryOutbox,
} from "../../src/outbox/dispatch";
import { markProjectionBuilt, openProjectionDb } from "../../src/projections/db";
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
  "projection_stale",
  "projection_cache_drift",
  "attention_required",
  "attention",
  "next_actions",
  "dirty_modified",
  "dirty_untracked",
  "dirty_modified_paths",
  "dirty_untracked_paths",
  "content_pages",
  "wiki_pages",
  "notes_pages",
  "inbox_pages",
  "inbox_raw_pages",
  "wikilinks",
  "raw_files",
  "raw_bytes",
  "last_sync",
  "pending_runs",
  "orphan_runs",
  "failed_runs",
  "recent_processor_runs",
  "maintenance_loops",
  "serve_status",
  "serve_pid",
  "serve_branch",
  "serve_updated_at",
  "diagnostics",
  "content_diagnostics",
  "unlocated_diagnostics",
  "attention_diagnostics",
  "diagnostic_summary",
  "attention_diagnostic_summary",
  "diagnostic_message_summary",
  "attention_diagnostic_message_summary",
  "diagnostic_disposition_summary",
  "attention_diagnostic_disposition_summary",
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

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected object");
  }
  return value as Record<string, unknown>;
}

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
      // `.gitkeep` keeps the inbox dirs tracked once the ingest agent empties
      // inbox/raw/ — a dotfile so it matches neither inbox/raw/*.md (ingest)
      // nor inbox/**/*.md (stale-check).
      expect(existsSync(join(target, "inbox", "raw", ".gitkeep"))).toBe(true);
      expect(
        existsSync(join(target, "inbox", "processed", ".gitkeep")),
      ).toBe(true);
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
      expect(existsSync(join(target, ".dome", "model-provider.ts"))).toBe(
        false,
      );

      const agentsPath = join(target, "AGENTS.md");
      expect(existsSync(agentsPath)).toBe(true);
      const agentsBody = await readFile(agentsPath, "utf8");
      expect(agentsBody).toContain("This is a Dome vault");
      expect(agentsBody).toContain("## Daily loop");
      expect(agentsBody).toContain("Commit each coherent unit of work");
      expect(agentsBody).toContain("Dome works at the git commit boundary");
      expect(agentsBody).toContain("serve_status");
      expect(agentsBody).toContain("foreground `dome serve` host");
      expect(agentsBody).toContain("next_actions");
      expect(agentsBody).toContain("dome check --json");
      expect(agentsBody).toContain("dome resolve <id> <value>");
      expect(agentsBody).toContain("agent-safe");
      expect(agentsBody).toContain("owner-needed");
      expect(agentsBody).toContain("recommended_answer");
      expect(agentsBody).toContain("## Read-first context");
      expect(agentsBody).toContain("dome export-context <topic> --json");
      expect(agentsBody).toContain("dome query <text> --json");
      expect(agentsBody).toContain("The daily note should already be");
      expect(agentsBody).not.toContain("dome today");
      expect(agentsBody).not.toContain("dome prep");
      expect(agentsBody).toContain("dome export-context <topic>");
      expect(agentsBody).toContain("Advanced/debug commands");
      expect(agentsBody).toContain("dome inspect <subject>");
      expect(agentsBody).toContain("dome inspect bundles --json");
      expect(agentsBody).toContain("inbox/raw/");
      expect(agentsBody).toContain("dome.agent");
      expect(agentsBody).toContain('model: "ready"');
      expect(agentsBody).toContain("Do not edit or commit it");
      expect(agentsBody).toContain("<!-- BEGIN user-prose -->");
      expect(agentsBody).toContain("<!-- END user-prose -->");
      expect(agentsBody).not.toContain("git worktree add");

      const claudePath = join(target, "CLAUDE.md");
      expect(existsSync(claudePath)).toBe(true);
      const claudeBody = await readFile(claudePath, "utf8");
      expect(claudeBody.startsWith("@AGENTS.md")).toBe(true);
      expect(claudeBody).toContain("dome status --json");
      expect(claudeBody).toContain("next_actions");
      expect(claudeBody).toContain("dome sync --json");
      expect(claudeBody).toContain("dome check --json");
      expect(claudeBody).toContain("dome resolve <id> <value>");
      expect(claudeBody).toContain("before broad manual file hunting");
      expect(claudeBody).toContain("agent-safe");
      expect(claudeBody).toContain("owner-needed");
      expect(claudeBody).not.toContain("only use `dome status`");
      expect(captured.out.join("\n")).toContain("CLAUDE.md");
      expect(captured.out.join("\n")).toContain("inbox/raw/");
      expect(captured.out.join("\n")).toContain(".dome/model-provider.ts");

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
        expect(ids).toContain("dome.agent");
        expect(ids).toContain("dome.lint");
        expect(ids).toContain("dome.markdown");
      }
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  test("--with-model-provider anthropic writes a vault-local command provider", async () => {
    const target = mkdtempSync(join(tmpdir(), "cli-init-provider-"));
    try {
      const code = await runInit({
        path: target,
        modelProvider: "anthropic",
      });
      expect(code).toBe(0);

      const configPath = join(target, ".dome", "config.yaml");
      const providerPath = join(target, ".dome", "model-provider.ts");
      expect(existsSync(configPath)).toBe(true);
      expect(existsSync(providerPath)).toBe(true);

      const configBody = await readFile(configPath, "utf8");
      expect(parseYaml(configBody)).toEqual(
        defaultConfigRecord({ modelProvider: "anthropic" }),
      );
      const parsedConfig = record(parseYaml(configBody));
      expect(parsedConfig.model_provider).toEqual(
        defaultModelProviderConfig("anthropic"),
      );
      const extensions = record(parsedConfig.extensions);
      expect(record(extensions["dome.agent"]).enabled).toBe(false);

      const providerBody = await readFile(providerPath, "utf8");
      expect(providerBody.startsWith("#!/usr/bin/env bun")).toBe(true);
      expect(providerBody).toContain("ANTHROPIC_API_KEY");
      expect(providerBody).toContain("claude-haiku-4-5-20251001");
      expect(providerBody).toContain("dome.model-provider.request/v1");

      const head = await currentSha(target);
      expect(head).not.toBeNull();
      if (head !== null) {
        expect(
          await readBlob({
            path: target,
            commit: head,
            filepath: ".dome/config.yaml",
          }),
        ).toBe(configBody);
        expect(
          await readBlob({
            path: target,
            commit: head,
            filepath: ".dome/model-provider.ts",
          }),
        ).toBe(providerBody);
      }

      expect(await runInit({ path: target, modelProvider: "anthropic" })).toBe(
        0,
      );
      expect(await readFile(configPath, "utf8")).toBe(configBody);
      expect(await readFile(providerPath, "utf8")).toBe(providerBody);
      expect(await currentSha(target)).toBe(head);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  test("--json emits a stable initialization summary", async () => {
    const target = mkdtempSync(join(tmpdir(), "cli-init-json-"));
    try {
      const code = await runInit({ path: target, json: true });
      expect(code).toBe(0);
      const parsed = JSON.parse(captured.out.join("\n")) as {
        readonly schema: string;
        readonly status: string;
        readonly vault: string;
        readonly steps: Record<string, string>;
      };
      expect(parsed.schema).toBe("dome.init/v1");
      expect(parsed.status).toBe("initialized");
      expect(parsed.vault).toBe(target);
      expect(parsed.steps.config_yaml).toBe("created");
      expect(parsed.steps.initial_commit).toBe("created");
      expect(parsed.steps.model_provider).toBe("skipped (not requested)");
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
        .toEqual(["wiki/**/*.md", "notes/*.md"]);
      expect(refreshed.extensions["dome.health"]?.enabled).toBe(false);
      expect(refreshed.extensions["dome.agent"]?.enabled).toBe(false);
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
      expect(agents).toContain("## Read-first context");
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

  test("--refresh-instructions refreshes managed AGENTS while preserving user prose", async () => {
    const target = mkdtempSync(join(tmpdir(), "cli-init-managed-agents-"));
    try {
      await writeFile(
        join(target, "AGENTS.md"),
        [
          "# Old managed heading",
          "",
          "Outdated instruction: use dome doctor --show diagnostics.",
          "",
          "<!-- BEGIN user-prose -->",
          "",
          "My private vault notes.",
          "",
          "<!-- END user-prose -->",
          "",
        ].join("\n"),
        "utf8",
      );
      await writeFile(join(target, "CLAUDE.md"), "@AGENTS.md\n", "utf8");

      expect(await runInit({ path: target, refreshInstructions: true })).toBe(0);

      const agents = await readFile(join(target, "AGENTS.md"), "utf8");
      expect(agents.startsWith("# This is a Dome vault.")).toBe(true);
      expect(agents).toContain("## Read-first context");
      expect(agents).toContain("dome export-context <topic> --json");
      expect(agents).toContain("My private vault notes.");
      expect(agents).not.toContain("# Old managed heading");
      expect(agents).not.toContain("doctor --show");

      const firstAgents = agents;
      expect(await runInit({ path: target, refreshInstructions: true })).toBe(0);
      expect(await readFile(join(target, "AGENTS.md"), "utf8")).toBe(firstAgents);
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
            { id: "dome.lint.report", version: "0.1.1" },
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
        // The message "Wikilink [[broken]] does not resolve..." may be
        // truncated by the width-fit table column; check the visible prefix.
        expect(inspectOut).toContain("[[broken]");
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
// not a flag; each subject is backed by an existing runtime/query surface.

describe("runInspect", () => {
  test("subjects 'bundles' and 'processors' expose the loaded feature surface", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    expect(
      await runInspect({
        subject: "bundles",
        vault: f.vaultPath,
        json: true,
      }),
    ).toBe(0);
    const bundles = JSON.parse(captured.out.join("\n")) as ReadonlyArray<{
      readonly bundle: string;
      readonly processors: number;
      readonly adoption: number;
      readonly garden: number;
      readonly view: number;
      readonly command_views: number;
      readonly model_processors: number;
      readonly model: string;
    }>;
    const agentBundle = bundles.find((row) => row.bundle === "dome.agent");
    expect(agentBundle).toEqual(
      expect.objectContaining({
        processors: 3,
        adoption: 0,
        garden: 3,
        view: 0,
        model_processors: 2,
        model: "granted-no-provider",
      }),
    );
    const dailyBundle = bundles.find((row) => row.bundle === "dome.daily");
    expect(dailyBundle?.command_views).toBe(3);

    captured.out = [];
    expect(
      await runInspect({
        subject: "processors",
        vault: f.vaultPath,
        json: true,
      }),
    ).toBe(0);
    const processors = JSON.parse(captured.out.join("\n")) as ReadonlyArray<{
      readonly processor: string;
      readonly bundle: string;
      readonly version: string;
      readonly phase: string;
      readonly triggers: string;
      readonly commands: string;
      readonly capabilities: string;
      readonly bundle_grants: string;
      readonly grant_scopes: string;
      readonly grant_details: ReadonlyArray<{
        readonly kind: string;
        readonly scope: string;
        readonly values: ReadonlyArray<string>;
      }>;
      readonly execution: string;
      readonly model: string;
    }>;
    const ingest = processors.find(
      (row) => row.processor === "dome.agent.ingest",
    );
    expect(ingest).toEqual(
      expect.objectContaining({
        bundle: "dome.agent",
        version: "0.1.0",
        phase: "garden",
        triggers: "signal",
        execution: "llm",
        model: "granted-no-provider",
      }),
    );
    expect(ingest?.capabilities).toContain("model.invoke");
    expect(ingest?.bundle_grants).toContain("model.invoke");
    expect(ingest?.grant_scopes).toContain("read:inbox/**/*.md");
    expect(ingest?.grant_scopes).toContain("wiki/**/*.md");
    expect(ingest?.grant_scopes).toContain("patch.auto:");
    expect(ingest?.grant_details).toContainEqual({
      kind: "patch.auto",
      scope: "paths",
      values: [
        "inbox/processed/*.md",
        "inbox/raw/*.md",
        "index.md",
        "log.md",
        "notes/**/*.md",
        "wiki/**/*.md",
      ],
    });
    expect(ingest?.grant_details).toContainEqual({
      kind: "model.invoke",
      scope: "maxDailyCostUsd",
      values: ["5"],
    });

    const markdownRepair = processors.find(
      (row) => row.processor === "dome.markdown.repair-wikilinks",
    );
    expect(markdownRepair?.grant_scopes).toContain("patch.auto:**/*.md");

    const healthRecovery = processors.find(
      (row) => row.processor === "dome.health.outbox-recovery-questions",
    );
    expect(healthRecovery?.grant_scopes).toContain("read:**");
    expect(healthRecovery?.grant_scopes).toContain("outbox.read:failed");
    expect(healthRecovery?.grant_details).toContainEqual({
      kind: "outbox.read",
      scope: "statuses",
      values: ["failed"],
    });

    const query = processors.find(
      (row) => row.processor === "dome.search.query",
    );
    expect(query).toEqual(
      expect.objectContaining({
        phase: "view",
        triggers: "command",
        commands: "query",
        model: "none",
      }),
    );

    captured.out = [];
    expect(
      await runInspect({
        subject: "processors",
        vault: f.vaultPath,
        model: true,
        json: true,
      }),
    ).toBe(0);
    const modelProcessors = JSON.parse(
      captured.out.join("\n"),
    ) as ReadonlyArray<{
      readonly processor: string;
      readonly model: string;
    }>;
    expect(modelProcessors.length).toBe(3);
    expect(modelProcessors.map((row) => row.processor).sort()).toEqual([
      "dome.agent.consolidate",
      "dome.agent.ingest",
      "dome.warden.integrity",
    ]);
    expect(modelProcessors.every((row) => row.model !== "none")).toBe(true);
  });

  test("subject 'facts' exposes source-backed projection fact provenance", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeFile(
      join(f.vaultPath, "wiki/new.md"),
      "# New\n\nSee [[seed]] for the source note.\n",
    );
    await commit({
      path: f.vaultPath,
      message: "link seed note\n",
      files: ["wiki/new.md"],
    });

    expect(await runSync({ vault: f.vaultPath, json: true, quiet: true })).toBe(
      0,
    );

    captured.out = [];
    expect(
      await runInspect({
        subject: "facts",
        vault: f.vaultPath,
        predicate: "dome.graph.links_to",
        subjectKind: "page",
        subjectId: "wiki/new.md",
        json: true,
      }),
    ).toBe(0);
    const rows = JSON.parse(captured.out.join("\n")) as ReadonlyArray<{
      readonly id: number;
      readonly subject: string;
      readonly predicate: string;
      readonly object: string;
      readonly assertion: string;
      readonly processor: string;
      readonly run: string;
      readonly adopted: string;
      readonly source_refs: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        subject: "page:wiki/new.md",
        predicate: "dome.graph.links_to",
        object: "seed",
        assertion: "extracted",
        processor: "dome.graph.links",
      }),
    );
    expect(rows[0]?.id).toBeGreaterThan(0);
    expect(rows[0]?.run).toMatch(/^run_/);
    expect(rows[0]?.adopted).toMatch(/^[0-9a-f]{40}$/);
    expect(rows[0]?.source_refs).toContain("wiki/new.md:3");

    captured.out = [];
    expect(
      await runInspect({
        subject: "facts",
        vault: f.vaultPath,
        predicate: "dome.graph.tagged",
        json: true,
      }),
    ).toBe(0);
    expect(JSON.parse(captured.out.join("\n"))).toEqual([]);
  });

  test("subject 'patches' exposes generated markdown change provenance", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    expect(await runSync({ vault: f.vaultPath, json: true, quiet: true })).toBe(
      0,
    );

    await writeFile(
      join(f.vaultPath, "wiki/messy.md"),
      "---\nid: messy\ntype: page\n---\n# Messy\n",
    );
    await commit({
      path: f.vaultPath,
      message: "add messy frontmatter\n",
      files: ["wiki/messy.md"],
    });

    expect(await runSync({ vault: f.vaultPath, json: true, quiet: true })).toBe(
      0,
    );

    captured.out = [];
    expect(
      await runInspect({
        subject: "patches",
        vault: f.vaultPath,
        processor: "dome.markdown.normalize-frontmatter",
        json: true,
      }),
    ).toBe(0);
    const rows = JSON.parse(captured.out.join("\n")) as ReadonlyArray<{
      readonly id: number;
      readonly run: string;
      readonly processor: string;
      readonly phase: string;
      readonly status: string;
      readonly capability: string;
      readonly outcome: string;
      readonly paths: string;
      readonly input: string;
      readonly output: string;
      readonly effect_hashes: number;
    }>;
    const messyPatch = rows.find((row) => row.paths === "wiki/messy.md");
    expect(messyPatch).toBeDefined();
    expect(messyPatch).toEqual(
      expect.objectContaining({
        processor: "dome.markdown.normalize-frontmatter",
        phase: "adoption",
        status: "succeeded",
        capability: "patch.auto",
        outcome: "allowed",
        paths: "wiki/messy.md",
        effect_hashes: 1,
      }),
    );
    expect(messyPatch?.id).toBeGreaterThan(0);
    expect(messyPatch?.run).toMatch(/^run_/);
    expect(messyPatch?.input).toMatch(/^[0-9a-f]{12}$/);
    expect(messyPatch?.output).toMatch(/^[0-9a-f]{12}$/);

    captured.out = [];
    expect(
      await runInspect({
        subject: "patches",
        vault: f.vaultPath,
        processor: "dome.nope",
        json: true,
      }),
    ).toBe(0);
    expect(JSON.parse(captured.out.join("\n"))).toEqual([]);
  });

  test("subject 'bundles' shows configured disabled bundles without loading them", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await mkdir(join(f.vaultPath, ".dome"), { recursive: true });
    await writeFile(
      join(f.vaultPath, ".dome", "config.yaml"),
      defaultConfigYaml(),
    );

    expect(
      await runInspect({
        subject: "bundles",
        vault: f.vaultPath,
        json: true,
      }),
    ).toBe(0);
    const bundles = JSON.parse(captured.out.join("\n")) as ReadonlyArray<{
      readonly bundle: string;
      readonly status: string;
      readonly loaded: boolean;
      readonly inventory: string;
      readonly version: string;
      readonly processors: number;
      readonly garden: number;
      readonly model_processors: number;
      readonly model: string;
    }>;
    const agent = bundles.find((row) => row.bundle === "dome.agent");
    expect(agent).toEqual(
      expect.objectContaining({
        status: "disabled",
        loaded: false,
        inventory: "manifest",
        version: "0.1.0",
        processors: 3,
        garden: 3,
        model_processors: 2,
        model: "disabled-no-provider",
      }),
    );
    const search = bundles.find((row) => row.bundle === "dome.search");
    expect(search).toEqual(
      expect.objectContaining({
        status: "enabled",
        loaded: true,
        processors: 3,
      }),
    );

    captured.out = [];
    expect(
      await runInspect({
        subject: "processors",
        vault: f.vaultPath,
        json: true,
      }),
    ).toBe(0);
    const processors = JSON.parse(captured.out.join("\n")) as ReadonlyArray<{
      readonly processor: string;
    }>;
    expect(
      processors.some((row) => row.processor.startsWith("dome.agent.")),
    ).toBe(false);

    captured.out = [];
    expect(
      await runInspect({
        subject: "processors",
        vault: f.vaultPath,
        model: true,
        json: true,
      }),
    ).toBe(0);
    expect(JSON.parse(captured.out.join("\n"))).toEqual([]);

    captured.out = [];
    expect(
      await runInspect({
        subject: "bundles",
        vault: f.vaultPath,
        model: true,
        json: true,
      }),
    ).toBe(0);
    const modelBundles = JSON.parse(captured.out.join("\n")) as ReadonlyArray<{
      readonly bundle: string;
      readonly status: string;
      readonly loaded: boolean;
      readonly model_processors: number;
      readonly model: string;
    }>;
    expect(modelBundles).toEqual([
      expect.objectContaining({
        bundle: "dome.agent",
        status: "disabled",
        loaded: false,
        model_processors: 2,
        model: "disabled-no-provider",
      }),
      expect.objectContaining({
        bundle: "dome.warden",
        status: "disabled",
        loaded: false,
        model_processors: 1,
        model: "disabled-no-provider",
      }),
    ]);
  });

  test("--model filter is only valid for bundle and processor metadata", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    expect(
      await runInspect({
        subject: "runs",
        vault: f.vaultPath,
        model: true,
        json: true,
      }),
    ).toBe(64);
    expect(captured.err.join("\n")).toContain(
      "--model is only valid for the bundles and processors subjects",
    );
  });

  test("subject 'bundles' reads disabled local manifests without importing modules", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    const bundleDir = join(f.vaultPath, ".dome", "extensions", "custom.disabled");
    await mkdir(join(bundleDir, "processors"), { recursive: true });
    await writeFile(
      join(f.vaultPath, ".dome", "config.yaml"),
      [
        "extensions:",
        "  custom.disabled:",
        "    enabled: false",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(bundleDir, "manifest.json"),
      JSON.stringify(
        {
          id: "custom.disabled",
          version: "1.2.3",
          processors: [
            {
              id: "custom.disabled.missing-module",
              version: "0.0.1",
              phase: "garden",
              triggers: [{ kind: "schedule", cron: "* * * * *" }],
              capabilities: [{ kind: "model.invoke", maxDailyCostUsd: 1 }],
              execution: { class: "llm" },
              module: "processors/missing-module.ts",
            },
          ],
        },
        null,
        2,
      ),
    );

    expect(
      await runInspect({
        subject: "bundles",
        vault: f.vaultPath,
        json: true,
      }),
    ).toBe(0);
    const bundles = JSON.parse(captured.out.join("\n")) as ReadonlyArray<{
      readonly bundle: string;
      readonly status: string;
      readonly loaded: boolean;
      readonly inventory: string;
      readonly version: string;
      readonly processors: number;
      readonly model_processors: number;
      readonly model: string;
    }>;
    expect(bundles).toContainEqual(
      expect.objectContaining({
        bundle: "custom.disabled",
        status: "disabled",
        loaded: false,
        inventory: "manifest",
        version: "1.2.3",
        processors: 1,
        model_processors: 1,
        model: "disabled-no-provider",
      }),
    );
  });

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
        runId: "run-cli-diagnostic",
        proposalId: "prop_cli",
        adoptedCommit: commitOid(f.headSha),
      });
    } finally {
      projection.value.db.close();
    }

    expect(
      await runInspect({
        subject: "diagnostics",
        vault: f.vaultPath,
        json: true,
      }),
    ).toBe(0);
    const rows = JSON.parse(captured.out.join("\n")) as ReadonlyArray<{
      readonly id: number;
      readonly code: string;
      readonly processor: string;
      readonly run: string;
      readonly proposal: string;
      readonly adopted: string;
      readonly source_refs: string;
    }>;
    expect(rows[0]).toEqual(
      expect.objectContaining({
        code: "test.diagnostic",
        processor: "test.cli",
        run: "run-cli-diagnostic",
        proposal: "prop_cli",
      }),
    );
    expect(rows[0]?.id).toBeGreaterThan(0);
    expect(rows[0]?.adopted).toBe(f.headSha);
    expect(rows[0]?.source_refs).toContain("wiki/new.md:3-5");
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
        severity: "error",
        code: "test.single",
        count: 1,
      }),
    );
    expect(payload.groups[1]).toEqual(
      expect.objectContaining({
        severity: "warning",
        code: "test.repeated",
        count: 2,
      }),
    );
    expect(payload.groups[1]?.first_source_refs).toContain("wiki/seed.md");
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

  test("subject 'questions' exposes producer and source provenance", async () => {
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
      const adopted = commitOid(f.headSha);
      insertQuestion(projection.value.db, {
        effect: questionEffect({
          question: "Resolve this source-backed uncertainty?",
          sourceRefs: [
            sourceRef({
              commit: adopted,
              path: "wiki/new.md",
              range: { startLine: 1, endLine: 1 },
            }),
          ],
          idempotencyKey: "inspect-question-provenance",
          metadata: {
            risk: "low",
            confidence: 0.9,
            automationPolicy: "agent-safe",
          },
        }),
        processorId: "test.question",
        runId: "run-cli-question",
        adoptedCommit: adopted,
      });
    } finally {
      projection.value.db.close();
    }

    captured.out = [];
    expect(
      await runInspect({
        subject: "questions",
        vault: f.vaultPath,
        json: true,
      }),
    ).toBe(0);
    const rows = JSON.parse(captured.out.join("\n")) as ReadonlyArray<{
      readonly question: string;
      readonly processor: string;
      readonly run: string;
      readonly adopted: string;
      readonly source_refs: string;
    }>;
    expect(rows[0]).toEqual(
      expect.objectContaining({
        question: "Resolve this source-backed uncertainty?",
        processor: "test.question",
        run: "run-cli-question",
        adopted: f.headSha,
      }),
    );
    expect(rows[0]?.source_refs).toContain("wiki/new.md:1");
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

    captured.err = [];
    expect(
      await runInspect({
        subject: "runs",
        vault: f.vaultPath,
        processor: "dome.markdown.normalize-frontmatter",
      }),
    ).toBe(64);
    expect(captured.err.join("\n")).toContain(
      "--processor is only valid for the diagnostics and patches subjects",
    );
  });

  test("fact-only flags reject other subjects", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    expect(
      await runInspect({
        subject: "runs",
        vault: f.vaultPath,
        predicate: "dome.graph.links_to",
      }),
    ).toBe(64);
    expect(captured.err.join("\n")).toContain(
      "only valid for the facts subject",
    );
  });

  test("invalid fact filters return 64", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    expect(
      await runInspect({
        subject: "facts",
        vault: f.vaultPath,
        subjectKind: "file",
        subjectId: "wiki/seed.md",
      }),
    ).toBe(64);
    expect(captured.err.join("\n")).toContain(
      "--subject-kind must be one of page, task, entity",
    );

    captured.err = [];
    expect(
      await runInspect({
        subject: "facts",
        vault: f.vaultPath,
        subjectKind: "page",
      }),
    ).toBe(64);
    expect(captured.err.join("\n")).toContain(
      "--subject-kind and --subject-id must be provided together",
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
      runId: "run-test-fixture",
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
      runId: "run-test-fixture",
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

// ----- runResolve ------------------------------------------------------------

describe("runResolve", () => {
  test("records an answer through the user-facing decision verb", async () => {
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
        question: "Track this follow-up?",
        sourceRefs: [sourceRef({ commit: adopted, path: "wiki/new.md" })],
        idempotencyKey: "cli-resolve-1",
        options: ["track", "ignore"],
      }),
      processorId: "test.cli",
      runId: "run-test-fixture",
      adoptedCommit: adopted,
    });
    const id = queryQuestionRecords(projection.value.db)[0]?.id;
    projection.value.db.close();
    expect(id).toBeGreaterThan(0);
    if (id === undefined) return;

    expect(
      await runResolve({
        id,
        value: "track",
        vault: f.vaultPath,
        json: true,
      }),
    ).toBe(0);

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
      expect(record?.answer).toBe("track");
    } finally {
      after.value.db.close();
    }
  });
});

// ----- runCheck --------------------------------------------------------------

describe("runCheck", () => {
  test("clean vault reports one unified ok surface", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeDoctorConfig(f);

    expect(await runCheck({ vault: f.vaultPath })).toBe(0);
    const out = captured.out.join("\n");
    expect(out).toContain("dome check");
    expect(out).toContain("AT A GLANCE");
    expect(out).toMatch(/status\s+.*ok/);
    expect(out).toMatch(/engine\s+.*ok/);
    expect(out).toContain("0 diagnostics");
    expect(out).toContain("0 open questions");
    expect(out).toContain("5 known");
    expect(out).not.toContain("  LOOPS\n");
  });

  test("--loops prints maintenance-loop detail rows", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeDoctorConfig(f);

    expect(await runCheck({ vault: f.vaultPath, loops: true })).toBe(0);
    const out = captured.out.join("\n");
    expect(out).toContain("5 known");
    expect(out).toContain("  LOOPS\n");
    expect(out).toContain("[inactive] dome.capture.digest");
    expect(out).toContain("surfaces: path:wiki/sources/*.md");
    expect(out).toContain("command:export-context");
    expect(out).toContain("no-op:");
  });

  test("--json reports engine findings, content diagnostics, and decisions", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeDoctorConfig(f);
    await seedUnhealthyOperationalState(f);

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
    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    try {
      insertDiagnostic(projection.value.db, {
        effect: diagnosticEffect({
          severity: "warning",
          code: "check.test",
          message: "check diagnostic",
          sourceRefs: [ref],
        }),
        processorId: "test.check",
        proposalId: null,
        adoptedCommit,
      });
      insertQuestion(projection.value.db, {
        effect: questionEffect({
          question: "Resolve this?",
          options: ["yes", "no"],
          sourceRefs: [ref],
          idempotencyKey: "check-question",
          metadata: {
            risk: "medium",
            confidence: 0.8,
            recommendedAnswer: "yes",
            automationPolicy: "owner-needed",
            ownerNeededReason: "Fixture needs explicit review.",
          },
        }),
        processorId: "test.check",
        runId: "run-test-fixture",
        adoptedCommit,
      });
    } finally {
      projection.value.db.close();
    }

    expect(await runCheck({ vault: f.vaultPath, json: true })).toBe(0);

    const blob = captured.out.find((l) => l.includes("\"schema\""));
    expect(blob).toBeDefined();
    if (blob === undefined) return;
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    expect(parsed["schema"]).toBe("dome.check/v1");
    expect(parsed["status"]).toBe("attention");
    expect(record(parsed["scopes"])).toEqual({
      engine: true,
      content: true,
      decisions: true,
    });
    expect(record(parsed["engine"])["status"]).toBe("unhealthy");
    expect(record(record(parsed["engine"])["summary"])["findingCount"])
      .toBeGreaterThan(0);
    expect(record(parsed["content"])["diagnostics"]).toBe(1);
    expect(record(parsed["content"])["attention_diagnostics"]).toBe(1);
    expect(record(parsed["content"])["shownItems"]).toBe(1);
    expect(record(parsed["content"])["omittedItems"]).toBe(0);
    expect(record(parsed["decisions"])["questions"]).toBe(1);
    expect(record(parsed["decisions"])["agent_safe_questions"]).toBe(0);
    expect(record(parsed["decisions"])["model_safe_questions"]).toBe(0);
    expect(record(parsed["decisions"])["owner_needed_questions"]).toBe(1);
    expect(record(parsed["decisions"])["shownItems"]).toBe(1);
    expect(record(parsed["decisions"])["omittedItems"]).toBe(0);
    expect(Array.isArray(parsed["maintenance_loops"])).toBe(true);
    const maintenanceLoops =
      parsed["maintenance_loops"] as ReadonlyArray<Record<string, unknown>>;
    expect(maintenanceLoops).toHaveLength(5);
    expect(maintenanceLoops.find((loop) =>
      loop["id"] === "dome.question.continuity"
    )).toEqual(expect.objectContaining({
      question_scope: "all",
      processor_ids: expect.arrayContaining([
        "dome.warden.integrity",
      ]),
      optional_processor_ids: [
        "dome.warden.integrity",
        "dome.warden.integrity-answer",
      ],
      questions: 1,
      agent_safe_questions: 0,
      model_safe_questions: 0,
      owner_needed_questions: 1,
    }));
    const diagnosticItems =
      record(parsed["content"])["items"] as ReadonlyArray<Record<string, unknown>>;
    expect(diagnosticItems[0]?.["source_refs"]).toContain("wiki/seed.md");
    expect(diagnosticItems[0]?.["source_refs"]).not.toContain(
      adoptedCommit.slice(0, 7),
    );
    const diagnosticSourceRefs =
      diagnosticItems[0]?.["sourceRefs"] as ReadonlyArray<Record<string, unknown>>;
    expect(diagnosticSourceRefs[0]?.["path"]).toBe("wiki/seed.md");
    expect(diagnosticSourceRefs[0]?.["commit"]).toBe(adoptedCommit);
    const decisionItems =
      record(parsed["decisions"])["items"] as ReadonlyArray<Record<string, unknown>>;
    expect(decisionItems[0]?.["source_refs"]).toContain("wiki/seed.md");
    expect(decisionItems[0]?.["source_refs"]).not.toContain(
      adoptedCommit.slice(0, 7),
    );
    expect(decisionItems[0]?.["resolveCommand"]).toBe(
      "dome resolve 1 <yes|no>",
    );
    expect(decisionItems[0]?.["automation_policy"]).toBe("owner-needed");
    expect(decisionItems[0]?.["recommended_answer"]).toBe("yes");
    expect(decisionItems[0]?.["owner_needed_reason"]).toBe(
      "Fixture needs explicit review.",
    );
    const decisionSourceRefs =
      decisionItems[0]?.["sourceRefs"] as ReadonlyArray<Record<string, unknown>>;
    expect(decisionSourceRefs[0]?.["path"]).toBe("wiki/seed.md");
    expect(decisionSourceRefs[0]?.["commit"]).toBe(adoptedCommit);
    expect(parsed["next_actions"]).toEqual([
      {
        reasons: ["engine"],
        command: "dome sync --json",
        description:
          "Run the compiler so health processors can raise recovery questions; rerun dome check if findings remain.",
      },
      {
        reasons: ["diagnostics"],
        command: "dome check --content --attention --limit 50 --json",
        description:
          "Review a larger bounded attention-diagnostic list; fix the source markdown issue(s), commit, then run dome sync --json.",
      },
      {
        reasons: ["questions"],
        command: "dome resolve 1 <yes|no>",
        description:
          "Resolve an open Dome decision using one of the listed options.",
      },
    ]);

    captured.out = [];
    expect(await runCheck({ vault: f.vaultPath, decisions: true })).toBe(0);
    expect(captured.out.join("\n")).toContain(
      "resolve: dome resolve 1 <yes|no>",
    );
    expect(captured.out.join("\n")).toContain(
      "policy: owner-needed; risk medium; confidence 0.80",
    );
  });

  test("--json treats info-only diagnostics as visible but non-attention", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeDoctorConfig(f);

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
    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    try {
      insertDiagnostic(projection.value.db, {
        effect: diagnosticEffect({
          severity: "info",
          code: "check.info",
          message: "informational diagnostic",
          sourceRefs: [ref],
        }),
        processorId: "test.check",
        proposalId: null,
        adoptedCommit,
      });
    } finally {
      projection.value.db.close();
    }

    expect(await runCheck({ vault: f.vaultPath, json: true })).toBe(0);

    const blob = captured.out.find((l) => l.includes("\"schema\""));
    expect(blob).toBeDefined();
    if (blob === undefined) return;
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    expect(parsed["status"]).toBe("ok");
    expect(record(parsed["content"])["diagnostics"]).toBe(1);
    expect(record(parsed["content"])["content_diagnostics"]).toBe(1);
    expect(record(parsed["content"])["unlocated_diagnostics"]).toBe(0);
    expect(record(parsed["content"])["attention_diagnostics"]).toBe(0);
    expect(parsed["next_actions"]).toEqual([]);

    captured.out = [];
    expect(await runCheck({ vault: f.vaultPath })).toBe(0);
    const text = captured.out.join("\n");
    expect(text).toContain("dome check");
    expect(text).toMatch(/status\s+.*ok/);
    expect(text).toContain(
      "1 diagnostic · 0 attention items · showing none",
    );
    expect(text).not.toContain("  CONTENT\n");
    expect(text).not.toContain("informational diagnostic");
  });

  test("--json keeps source-less runtime diagnostics out of content repair", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeDoctorConfig(f);

    const adoptedCommit = commitOid(f.headSha);
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
          severity: "block",
          code: "processor.timeout",
          message: "test.check.runtime: Processor exceeded timeout of 10ms.",
          sourceRefs: [],
        }),
        processorId: "test.check.runtime",
        proposalId: null,
        adoptedCommit,
      });
    } finally {
      projection.value.db.close();
    }

    expect(await runCheck({ vault: f.vaultPath, json: true })).toBe(0);

    const blob = captured.out.find((l) => l.includes("\"schema\""));
    expect(blob).toBeDefined();
    if (blob === undefined) return;
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    const content = record(parsed["content"]);
    expect(parsed["status"]).toBe("ok");
    expect(content["diagnostics"]).toBe(1);
    expect(content["content_diagnostics"]).toBe(0);
    expect(content["unlocated_diagnostics"]).toBe(1);
    expect(content["attention_diagnostics"]).toBe(0);
    expect(content["filtered_diagnostics"]).toBe(0);
    expect(content["items"]).toEqual([]);
    expect(parsed["next_actions"]).toEqual([]);
  });

  test("--json explains latest active processor failures as engine findings", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeDoctorConfig(f);

    const ledger = await openLedgerDb({
      path: join(f.vaultPath, ".dome", "state", "runs.db"),
    });
    if (!ledger.ok) {
      throw new Error(`ledger open failed: ${ledger.error.kind}`);
    }
    try {
      const runId = newRunId(new Date(10), () => "chkbad");
      insertQueued(ledger.value.db, {
        id: runId,
        proposalId: null,
        processorId: "test.check.failed",
        processorVersion: "0.0.1",
        phase: "garden",
        inputCommit: commitOid(f.headSha),
        triggerKind: "schedule",
        triggerPayload: { test: "failed-run" },
        startedAt: new Date(10),
      });
      markRunning(ledger.value.db, runId, new Date(11));
      markTimedOut(ledger.value.db, {
        id: runId,
        error: {
          code: "processor.timeout",
          message: "still timed out",
          retryable: true,
          phase: "garden",
          processorId: "test.check.failed",
        },
        durationMs: 10000,
        finishedAt: new Date(12),
      });
    } finally {
      ledger.value.db.close();
    }

    expect(await runCheck({ vault: f.vaultPath, json: true })).toBe(0);

    const blob = captured.out.find((l) => l.includes("\"schema\""));
    expect(blob).toBeDefined();
    if (blob === undefined) return;
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    const engine = record(parsed["engine"]);
    const summary = record(engine["summary"]);
    expect(engine["status"]).toBe("unhealthy");
    expect(summary["failedRuns"]).toBe(1);
    const findings = engine["findings"] as ReadonlyArray<Record<string, unknown>>;
    expect(findings).toEqual([
      expect.objectContaining({
        code: "run.latest-problem",
        severity: "error",
        subject: "runs",
        id: "run_10_chkbad",
        message: expect.stringContaining("test.check.failed"),
      }),
    ]);
    expect(record(findings[0]?.["run"])["status"]).toBe("timed_out");
    expect(parsed["next_actions"]).toEqual([
      {
        reasons: ["engine"],
        command: "dome sync --json",
        description:
          "Run the compiler so health processors can raise recovery questions; rerun dome check if findings remain.",
      },
    ]);
  });

  test("--json lists actionable diagnostics before open user decisions", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeDoctorConfig(f);

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
    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    try {
      insertDiagnostic(projection.value.db, {
        effect: diagnosticEffect({
          severity: "warning",
          code: "check.warning",
          message: "fixable warning",
          sourceRefs: [ref],
        }),
        processorId: "test.check",
        proposalId: null,
        adoptedCommit,
      });
      insertQuestion(projection.value.db, {
        effect: questionEffect({
          question: "Track this follow-up?",
          options: ["track", "ignore"],
          sourceRefs: [ref],
          idempotencyKey: "check-question",
          metadata: {
            risk: "low",
            confidence: 0.7,
            recommendedAnswer: "track",
            automationPolicy: "agent-safe",
          },
        }),
        processorId: "test.check",
        runId: "run-test-fixture",
        adoptedCommit,
      });
    } finally {
      projection.value.db.close();
    }

    expect(await runCheck({ vault: f.vaultPath, json: true })).toBe(0);
    const blob = captured.out.find((l) => l.includes("\"schema\""));
    expect(blob).toBeDefined();
    if (blob === undefined) return;
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    expect(record(parsed["engine"])["status"]).toBe("ok");
    expect(record(parsed["decisions"])["agent_safe_questions"]).toBe(1);
    expect(record(parsed["decisions"])["owner_needed_questions"]).toBe(0);
    expect(parsed["next_actions"]).toEqual([
      {
        reasons: ["diagnostics"],
        command: "dome check --content --attention --limit 50 --json",
        description:
          "Review a larger bounded attention-diagnostic list; fix the source markdown issue(s), commit, then run dome sync --json.",
      },
      {
        reasons: ["questions"],
        command: "dome resolve 1 <track|ignore>",
        description:
          "Resolve an open Dome decision using one of the listed options.",
      },
    ]);
  });

  test("--attention filters content rows while preserving total counts", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeDoctorConfig(f);

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
    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    try {
      insertDiagnostic(projection.value.db, {
        effect: diagnosticEffect({
          severity: "info",
          code: "check.info",
          message: "informational diagnostic",
          sourceRefs: [ref],
        }),
        processorId: "test.check",
        proposalId: null,
        adoptedCommit,
      });
      insertDiagnostic(projection.value.db, {
        effect: diagnosticEffect({
          severity: "warning",
          code: "check.warning",
          message: "warning diagnostic",
          sourceRefs: [ref],
        }),
        processorId: "test.check",
        proposalId: null,
        adoptedCommit,
      });
    } finally {
      projection.value.db.close();
    }

    expect(
      await runCheck({
        vault: f.vaultPath,
        content: true,
        attention: true,
        json: true,
      }),
    ).toBe(0);

    const blob = captured.out.find((l) => l.includes("\"schema\""));
    expect(blob).toBeDefined();
    if (blob === undefined) return;
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    const content = record(parsed["content"]);
    expect(content["diagnostics"]).toBe(2);
    expect(content["attention_diagnostics"]).toBe(1);
    expect(content["filtered_diagnostics"]).toBe(1);
    expect(content["shownItems"]).toBe(1);
    expect(content["omittedItems"]).toBe(0);
    expect(record(content["filter"])).toEqual({ attention: true });
    expect(record(content["summary"])["total"]).toBe(1);
    const items = content["items"] as ReadonlyArray<Record<string, unknown>>;
    expect(items.map((item) => item["severity"])).toEqual(["warning"]);
    expect(items.map((item) => item["code"])).toEqual(["check.warning"]);
    const sourceRefs = items[0]?.["sourceRefs"] as
      | ReadonlyArray<Record<string, unknown>>
      | undefined;
    expect(sourceRefs?.[0]?.["path"]).toBe("wiki/seed.md");
    expect(parsed["status"]).toBe("attention");
    expect(parsed["next_actions"]).toEqual([
      {
        reasons: ["diagnostics"],
        command: null,
        description:
          "Fix the listed source markdown diagnostics, commit the changes, then run dome sync --json.",
      },
    ]);
  });

  test("content report groups repeated diagnostic messages", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeDoctorConfig(f);

    const adoptedCommit = commitOid(f.headSha);
    const projection = await openProjectionDb({
      path: join(f.vaultPath, ".dome", "state", "projection.db"),
      extensionSet: [],
      processorVersions: [],
      capabilityPolicyHash: "test-policy",
    });
    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    try {
      for (const path of ["wiki/a.md", "wiki/b.md"]) {
        insertDiagnostic(projection.value.db, {
          effect: diagnosticEffect({
            severity: "warning",
            code: "check.repeated",
            message: "Repeated diagnostic",
            sourceRefs: [
              sourceRef({
                commit: adoptedCommit,
                path,
              }),
            ],
          }),
          processorId: "test.check",
          proposalId: null,
          adoptedCommit,
        });
      }
      insertDiagnostic(projection.value.db, {
        effect: diagnosticEffect({
          severity: "warning",
          code: "check.single",
          message: "Single diagnostic",
          sourceRefs: [
            sourceRef({
              commit: adoptedCommit,
              path: "wiki/c.md",
            }),
          ],
        }),
        processorId: "test.check",
        proposalId: null,
        adoptedCommit,
      });
    } finally {
      projection.value.db.close();
    }

    expect(
      await runCheck({
        vault: f.vaultPath,
        content: true,
        attention: true,
        json: true,
      }),
    ).toBe(0);

    const blob = captured.out.find((l) => l.includes("\"schema\""));
    expect(blob).toBeDefined();
    if (blob === undefined) return;
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    const content = record(parsed["content"]);
    const messageSummary = record(content["message_summary"]);
    expect(messageSummary["total"]).toBe(3);
    expect(messageSummary["group_count"]).toBe(2);
    const groups = messageSummary["groups"] as ReadonlyArray<
      Record<string, unknown>
    >;
    expect(groups[0]).toEqual(
      expect.objectContaining({
        severity: "warning",
        code: "check.repeated",
        message: "Repeated diagnostic",
        count: 2,
        first_source_refs: expect.stringContaining("wiki/"),
      }),
    );
    const items = content["items"] as ReadonlyArray<Record<string, unknown>>;
    expect(items.map((item) => item["message"])).toEqual([
      "Repeated diagnostic",
      "Repeated diagnostic",
      "Single diagnostic",
    ]);

    captured.out = [];
    expect(
      await runCheck({
        vault: f.vaultPath,
        content: true,
        attention: true,
      }),
    ).toBe(0);
    const text = captured.out.join("\n");
    expect(text).toContain("PATTERNS");
    expect(text).toContain(
      "2x [warning] check.repeated: Repeated diagnostic",
    );
    expect(text).toContain(
      "Fix the listed source markdown diagnostics, commit the changes, then run dome sync --json.",
    );
  });

  test("content report groups diagnostics by repair path", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeDoctorConfig(f);

    const adoptedCommit = commitOid(f.headSha);
    const projection = await openProjectionDb({
      path: join(f.vaultPath, ".dome", "state", "projection.db"),
      extensionSet: [],
      processorVersions: [],
      capabilityPolicyHash: "test-policy",
    });
    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    try {
      for (const path of ["wiki/a.md", "wiki/b.md"]) {
        insertDiagnostic(projection.value.db, {
          effect: diagnosticEffect({
            severity: "warning",
            code: "dome.markdown.broken-wikilink",
            message:
              "Wikilink [[missing-target]] does not resolve to any markdown file in the vault.",
            sourceRefs: [
              sourceRef({
                commit: adoptedCommit,
                path,
              }),
            ],
          }),
          processorId: "dome.markdown.validate-wikilinks",
          proposalId: null,
          adoptedCommit,
        });
      }
      insertDiagnostic(projection.value.db, {
        effect: diagnosticEffect({
          severity: "warning",
          code: "dome.markdown.broken-image",
          message: "Image embed ![[missing.png]] does not resolve in the vault.",
          sourceRefs: [
            sourceRef({
              commit: adoptedCommit,
              path: "wiki/c.md",
            }),
          ],
        }),
        processorId: "dome.markdown.broken-images",
        proposalId: null,
        adoptedCommit,
      });
    } finally {
      projection.value.db.close();
    }

    expect(
      await runCheck({
        vault: f.vaultPath,
        content: true,
        attention: true,
        json: true,
      }),
    ).toBe(0);
    const blob = captured.out.find((l) => l.includes("\"schema\""));
    expect(blob).toBeDefined();
    if (blob === undefined) return;
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    const content = record(parsed["content"]);
    const repairSummary = record(content["repair_summary"]);
    expect(repairSummary["total"]).toBe(3);
    expect(repairSummary["group_count"]).toBe(2);
    const groups = repairSummary["groups"] as ReadonlyArray<
      Record<string, unknown>
    >;
    expect(groups[0]).toEqual(
      expect.objectContaining({
        repair_path: "link.resolve-or-create",
        count: 2,
        attention_count: 2,
      }),
    );
    expect(groups[1]).toEqual(
      expect.objectContaining({
        repair_path: "asset.restore-or-relink",
        count: 1,
        attention_count: 1,
      }),
    );
    const dispositionSummary = record(content["disposition_summary"]);
    expect(dispositionSummary["total"]).toBe(3);
    const dispositionGroups = dispositionSummary["groups"] as ReadonlyArray<
      Record<string, unknown>
    >;
    expect(
      dispositionGroups.every((group) =>
        group["disposition"] === "agent-fixable"
      ),
    ).toBe(true);
    expect(
      dispositionGroups.reduce((sum, group) => sum + Number(group["count"]), 0),
    ).toBe(3);
    expect(
      dispositionGroups.reduce(
        (sum, group) => sum + Number(group["attention_count"]),
        0,
      ),
    ).toBe(3);
    const items = content["items"] as ReadonlyArray<Record<string, unknown>>;
    expect(items[0]?.["repair_path"]).toBe("link.resolve-or-create");
    expect(String(items[0]?.["repair_hint"])).toContain("Correct the wikilink");
    expect(items[0]?.["disposition"]).toBe("agent-fixable");
    expect(String(items[0]?.["disposition_hint"])).toContain("foreground agent");

    captured.out = [];
    expect(
      await runCheck({
        vault: f.vaultPath,
        content: true,
        attention: true,
      }),
    ).toBe(0);
    const text = captured.out.join("\n");
    expect(text).toContain("agent fixable");
    expect(text).toContain("PATTERNS");
    expect(text).toContain("2x link.resolve-or-create");
    expect(text).toContain("fix: link.resolve-or-create");
  });

  test("content report classifies optional-root diagnostic noise", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeDoctorConfig(f);

    const adoptedCommit = commitOid(f.headSha);
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
          severity: "info",
          code: "dome.markdown.broken-wikilink",
          message:
            "Wikilink [[dailies/2025-10-07]] does not resolve to any markdown file in the vault.",
          sourceRefs: [
            sourceRef({
              commit: adoptedCommit,
              path: "notes/2025-10-08.md",
            }),
          ],
        }),
        processorId: "dome.markdown.validate-wikilinks",
        proposalId: null,
        adoptedCommit,
      });
      insertDiagnostic(projection.value.db, {
        effect: diagnosticEffect({
          severity: "info",
          code: "dome.markdown.type-unknown",
          message:
            "Frontmatter `type:` references unknown page type \"interview_outline\".",
          sourceRefs: [
            sourceRef({
              commit: adoptedCommit,
              path: "notes/interview.md",
            }),
          ],
        }),
        processorId: "dome.markdown.lint-frontmatter",
        proposalId: null,
        adoptedCommit,
      });
    } finally {
      projection.value.db.close();
    }

    expect(
      await runCheck({
        vault: f.vaultPath,
        content: true,
        json: true,
      }),
    ).toBe(0);
    const blob = captured.out.find((l) => l.includes("\"schema\""));
    expect(blob).toBeDefined();
    if (blob === undefined) return;
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    const content = record(parsed["content"]);
    const dispositionSummary = record(content["disposition_summary"]);
    expect(dispositionSummary["total"]).toBe(2);
    expect(dispositionSummary["group_count"]).toBe(2);
    const groups = dispositionSummary["groups"] as ReadonlyArray<
      Record<string, unknown>
    >;
    expect(groups.map((group) => group["disposition"])).toEqual([
      "noise",
      "noise",
    ]);
    expect(groups.reduce((sum, group) => sum + Number(group["count"]), 0))
      .toBe(2);
    expect(groups.every((group) => group["attention_count"] === 0)).toBe(true);
    const items = content["items"] as ReadonlyArray<Record<string, unknown>>;
    expect(items.every((item) => item["disposition"] === "noise")).toBe(true);

    captured.out = [];
    expect(
      await runCheck({
        vault: f.vaultPath,
        content: true,
      }),
    ).toBe(0);
    const text = captured.out.join("\n");
    expect(text).toContain("noise (2 items)");
    expect(text).toContain("CONTENT");
    expect(text).toContain("dome.markdown.broken-wikilink");
    expect(text).toContain("dome.markdown.type-unknown");
  });

  test("text output reports omitted bounded rows", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeDoctorConfig(f);

    const adoptedCommit = commitOid(f.headSha);
    const projection = await openProjectionDb({
      path: join(f.vaultPath, ".dome", "state", "projection.db"),
      extensionSet: [],
      processorVersions: [],
      capabilityPolicyHash: "test-policy",
    });
    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    try {
      for (let i = 1; i <= 3; i += 1) {
        const ref = sourceRef({
          commit: adoptedCommit,
          path: `wiki/seed-${i}.md`,
        });
        insertDiagnostic(projection.value.db, {
          effect: diagnosticEffect({
            severity: "warning",
            code: `check.warning.${i}`,
            message: `warning diagnostic ${i}`,
            sourceRefs: [ref],
          }),
          processorId: "test.check",
          proposalId: null,
          adoptedCommit,
        });
        insertQuestion(projection.value.db, {
          effect: questionEffect({
            question: `Resolve ${i}?`,
            options: ["yes", "no"],
            sourceRefs: [ref],
            idempotencyKey: `check-question-${i}`,
          }),
          processorId: "test.check",
          runId: "run-test-fixture",
          adoptedCommit,
        });
      }
    } finally {
      projection.value.db.close();
    }

    expect(
      await runCheck({
        vault: f.vaultPath,
        content: true,
        attention: true,
        limit: 2,
      }),
    ).toBe(0);
    const text = captured.out.join("\n");
    expect(text).toContain(
      "3 diagnostics · 3 attention items · showing 2/3 attention",
    );
    expect(text).toContain(
      "... 1 more diagnostics (use --limit 3 to show all)",
    );

    captured.out = [];
    expect(
      await runCheck({
        vault: f.vaultPath,
        decisions: true,
        limit: 2,
      }),
    ).toBe(0);
    expect(captured.out.join("\n")).toContain(
      "... 1 more questions (use --limit 3 to show all)",
    );

    captured.out = [];
    expect(
      await runCheck({
        vault: f.vaultPath,
        content: true,
        attention: true,
        limit: 2,
        json: true,
      }),
    ).toBe(0);
    const contentJson = captured.out.find((l) => l.includes("\"schema\""));
    expect(contentJson).toBeDefined();
    if (contentJson === undefined) return;
    const contentPayload = JSON.parse(contentJson) as Record<string, unknown>;
    const content = record(contentPayload["content"]);
    expect(content["shownItems"]).toBe(2);
    expect(content["omittedItems"]).toBe(1);
    expect((content["items"] as ReadonlyArray<unknown>).length).toBe(2);
    expect(record(content["summary"])["omitted_groups"]).toBe(1);
    expect(record(content["message_summary"])["omitted_groups"]).toBe(1);

    captured.out = [];
    expect(
      await runCheck({
        vault: f.vaultPath,
        decisions: true,
        limit: 2,
        json: true,
      }),
    ).toBe(0);
    const decisionsJson = captured.out.find((l) => l.includes("\"schema\""));
    expect(decisionsJson).toBeDefined();
    if (decisionsJson === undefined) return;
    const decisionsPayload = JSON.parse(decisionsJson) as Record<string, unknown>;
    const decisions = record(decisionsPayload["decisions"]);
    expect(decisions["shownItems"]).toBe(2);
    expect(decisions["omittedItems"]).toBe(1);
    expect((decisions["items"] as ReadonlyArray<unknown>).length).toBe(2);
  });

  test("scope flags select one check surface", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeDoctorConfig(f);

    expect(
      await runCheck({
        vault: f.vaultPath,
        content: true,
        json: true,
      }),
    ).toBe(0);
    const blob = captured.out.find((l) => l.includes("\"schema\""));
    expect(blob).toBeDefined();
    if (blob === undefined) return;
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    expect(record(parsed["scopes"])).toEqual({
      engine: false,
      content: true,
      decisions: false,
    });
    expect(parsed["engine"]).toBeNull();
    expect(parsed["content"]).not.toBeNull();
    expect(parsed["decisions"]).toBeNull();
  });

  test("--json reports operational schema mismatches as engine-only attention", async () => {
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

    expect(await runCheck({ vault: f.vaultPath, json: true })).toBe(0);
    const blob = captured.out.find((l) => l.includes("\"schema\""));
    expect(blob).toBeDefined();
    if (blob === undefined) return;
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    expect(parsed["schema"]).toBe("dome.check/v1");
    expect(record(parsed["scopes"])).toEqual({
      engine: true,
      content: false,
      decisions: false,
    });
    expect(record(parsed["engine"])["status"]).toBe("unhealthy");
    expect(parsed["content"]).toBeNull();
    expect(parsed["decisions"]).toBeNull();
    expect(parsed["maintenance_loops"]).toBeNull();
    expect(parsed["next_actions"]).toEqual([
      {
        reasons: ["engine"],
        command: "dome sync --json",
        description:
          "Run the compiler so health processors can raise recovery questions; rerun dome check if findings remain.",
      },
    ]);
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
    expect(out).toContain("dome doctor");
    expect(out).toContain("ok");
    expect(out).toContain("FINDINGS");
    expect(out).toContain("none");
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
        readonly failedRuns: number;
        readonly quarantinedProcessors: number;
      };
      readonly findings: ReadonlyArray<{ readonly code: string }>;
    };
    expect(parsed.status).toBe("unhealthy");
    expect(parsed.summary.findingCount).toBe(3);
    expect(parsed.summary.failedOutbox).toBe(1);
    expect(parsed.summary.orphanRuns).toBe(1);
    expect(parsed.summary.failedRuns).toBe(0);
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

  test("with --repair: exits 64 as a reserved V1 surface", async () => {
    const code = await runDoctor({ repair: true });
    expect(code).toBe(64);
    expect(captured.err.join("\n")).toContain("reserved in V1");
    expect(captured.err.join("\n")).toContain("dome resolve");
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

// ----- runLint --------------------------------------------------------------

describe("runLint", () => {
  test("malformed --limit returns 64 before opening runtime", async () => {
    expect(await runLint({ limit: "nope" })).toBe(64);
    expect(captured.err.join("\n")).toContain(
      "--limit must be a positive integer",
    );
  });

  test("--json usage errors emit structured JSON", async () => {
    expect(await runLint({ limit: "nope", json: true })).toBe(64);
    const payload = JSON.parse(captured.out.join("\n")) as {
      readonly status: string;
      readonly error: string;
      readonly message: string;
    };
    expect(payload).toMatchObject({
      status: "error",
      error: "lint-usage",
      message: "dome lint: --limit must be a positive integer.",
    });
    expect(captured.err).toEqual([]);
  });
});

// ----- structured view command errors --------------------------------------

describe("structured view command errors", () => {
  test("query and export-context usage errors honor --json", async () => {
    expect(await runQuery({ json: true })).toBe(64);
    const queryPayload = JSON.parse(captured.out.join("\n")) as {
      readonly status: string;
      readonly error: string;
      readonly message: string;
    };
    expect(queryPayload).toMatchObject({
      status: "error",
      error: "query-usage",
      message: "dome query: missing query text. Usage: dome query <text>",
    });

    captured.out = [];
    captured.err = [];
    expect(await runExportContext({ json: true })).toBe(64);
    const exportPayload = JSON.parse(captured.out.join("\n")) as {
      readonly status: string;
      readonly error: string;
      readonly message: string;
    };
    expect(exportPayload).toMatchObject({
      status: "error",
      error: "export-context-usage",
      message:
        "dome export-context: missing topic. Usage: dome export-context <topic>",
    });
    expect(captured.err).toEqual([]);
  });
});

// ----- runStatus ------------------------------------------------------------

describe("runStatus", () => {
  test("prints sensible defaults on a fresh (unsubmitted) vault", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    const code = await runStatus({ vault: f.vaultPath });
    expect(code).toBe(0);

    const out = captured.out.join("\n");
    expect(out).toContain("dome status"); // headline
    expect(out).toContain("needs attention"); // headline status
    expect(out).toContain("(uninitialized)"); // adopted ref
    expect(out).toContain("sync"); expect(out).toContain("! needed"); // sync row
    expect(out).toContain("pending"); expect(out).toContain("unknown"); // pending commits
    expect(out).toContain("(never)"); // last_sync
    expect(out).toContain("content"); expect(out).toContain("2 pages"); // content summary
    expect(out).toContain("links 0"); // wikilinks in content
    expect(out).toContain("projection"); expect(out).toContain("√ fresh"); // projection row
    expect(out).toContain("loops"); expect(out).toContain("5 known"); // loops summary
    expect(out).not.toContain("\n  LOOPS\n"); // no loop detail section
    expect(out).toContain("diagnostics"); expect(out).toContain("√ 0"); // diagnostic row
    expect(out).toContain("questions"); expect(out).toContain("√ 0"); // questions row
    expect(out).toContain("outbox"); expect(out).toContain("0 pending · 0 failed"); // outbox row
    expect(out).toContain("quarantine"); // quarantine row
    expect(out).toContain("serve"); expect(out).toContain("o off"); // serve row (off glyph)
  });

  test("--loops prints maintenance-loop detail rows", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    const code = await runStatus({ vault: f.vaultPath, loops: true });
    expect(code).toBe(0);

    const out = captured.out.join("\n");
    expect(out).toContain("loops"); expect(out).toContain("5 known"); // loops summary
    expect(out).toContain("\n  LOOPS\n"); // loop detail section header (ALLCAPS, indent 2)
    // Tree connectors present (ASCII form — tests run without UTF locale)
    expect(out).toMatch(/[|`][-]/); // |- or `- tree connectors
    // Loop id and state in the node label
    expect(out).toContain("dome.capture.digest");
    // Child detail lines
    expect(out).toContain("processors:");
    expect(out).toContain("surfaces: path:wiki/sources/*.md");
    expect(out).toContain("settlement:");
    expect(out).toContain("no-op:");
  });

  test("fails early when config enables a missing bundle", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeFile(
      join(f.vaultPath, ".dome", "config.yaml"),
      [
        "extensions:",
        "  missing.bundle:",
        "    enabled: true",
        "",
      ].join("\n"),
    );

    expect(await runStatus({ vault: f.vaultPath })).toBe(1);
    expect(captured.err.join("\n")).toContain(
      "openVaultRuntime failed (bundle-load-failed)",
    );
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
    expect(parsed["projection_stale"]).toBe(false);
    expect(parsed["projection_cache_drift"]).toBe(false);
    expect(Array.isArray(parsed["maintenance_loops"])).toBe(true);
    const loops =
      parsed["maintenance_loops"] as ReadonlyArray<Record<string, unknown>>;
    expect(loops).toHaveLength(5);
    expect(loops[0]).toEqual(expect.objectContaining({
      questions: 0,
      agent_safe_questions: 0,
      model_safe_questions: 0,
      owner_needed_questions: 0,
      latest_run_at: null,
      last_successful_run_at: null,
      latest_problem_run_at: null,
    }));
    expect(parsed["attention_required"]).toBe(true);
    expect(parsed["attention"]).toEqual(
      expect.arrayContaining(["sync_needed"]),
    );
    expect(parsed["next_actions"]).toEqual([
      {
        reasons: ["sync_needed"],
        command: "dome sync --json",
        description:
          "Run one compiler tick to adopt pending commits or drain due operational work.",
      },
    ]);
    expect(parsed["dirty_modified"]).toBe(0);
    expect(parsed["dirty_untracked"]).toBe(0);
    expect(parsed["dirty_modified_paths"]).toEqual([]);
    expect(parsed["dirty_untracked_paths"]).toEqual([]);
    expect(parsed["content_pages"]).toBe(2);
    expect(parsed["wiki_pages"]).toBe(2);
    expect(parsed["notes_pages"]).toBe(0);
    expect(parsed["inbox_pages"]).toBe(0);
    expect(parsed["inbox_raw_pages"]).toBe(0);
    expect(parsed["wikilinks"]).toBe(0);
    expect(parsed["raw_files"]).toBe(0);
    expect(parsed["raw_bytes"]).toBe(0);
    expect(parsed["pending_runs"]).toBe(0);
    expect(parsed["orphan_runs"]).toBe(0);
    expect(parsed["failed_runs"]).toBe(0);
    expect(parsed["recent_processor_runs"]).toEqual([]);
    expect(parsed["serve_status"]).toBe("off");
    expect(parsed["serve_pid"]).toBeNull();
    expect(parsed["serve_branch"]).toBeNull();
    expect(parsed["serve_updated_at"]).toBeNull();
    expect(parsed["diagnostics"]).toBe(0);
    expect(parsed["attention_diagnostics"]).toBe(0);
    expect(parsed["diagnostic_summary"]).toEqual({
      total: 0,
      group_count: 0,
      shown_groups: 0,
      omitted_groups: 0,
      groups: [],
    });
    expect(parsed["attention_diagnostic_summary"]).toEqual({
      total: 0,
      group_count: 0,
      shown_groups: 0,
      omitted_groups: 0,
      groups: [],
    });
    expect(parsed["diagnostic_message_summary"]).toEqual({
      total: 0,
      group_count: 0,
      shown_groups: 0,
      omitted_groups: 0,
      groups: [],
    });
    expect(parsed["attention_diagnostic_message_summary"]).toEqual({
      total: 0,
      group_count: 0,
      shown_groups: 0,
      omitted_groups: 0,
      groups: [],
    });
    expect(parsed["diagnostic_disposition_summary"]).toEqual({
      total: 0,
      group_count: 0,
      shown_groups: 0,
      omitted_groups: 0,
      groups: [],
    });
    expect(parsed["attention_diagnostic_disposition_summary"]).toEqual({
      total: 0,
      group_count: 0,
      shown_groups: 0,
      omitted_groups: 0,
      groups: [],
    });
    expect(parsed["questions"]).toBe(0);
    expect(parsed["outbox_pending"]).toBe(0);
    expect(parsed["outbox_failed"]).toBe(0);
    expect(parsed["quarantined"]).toBe(0);
  });

  test("--json routes waiting raw captures when intake loop is inactive", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    await mkdir(join(f.vaultPath, ".dome"), { recursive: true });
    await mkdir(join(f.vaultPath, "inbox", "raw"), { recursive: true });
    await writeFile(
      join(f.vaultPath, ".dome", "config.yaml"),
      [
        "extensions:",
        "  dome.agent:",
        "    enabled: false",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(f.vaultPath, "inbox", "raw", "day.md"),
      [
        "---",
        "type: source",
        "---",
        "",
        "# Raw day",
        "",
        "Captured management note.",
        "",
      ].join("\n"),
      "utf8",
    );
    await commit({
      path: f.vaultPath,
      message: "add raw capture with disabled agent",
      files: [".dome/config.yaml", "inbox/raw/day.md"],
    });

    expect(await runSync({ vault: f.vaultPath, json: true, quiet: true })).toBe(
      0,
    );
    captured.out = [];
    captured.err = [];

    expect(await runStatus({ vault: f.vaultPath, json: true })).toBe(0);

    const blob = captured.out.find((l) => l.includes("\"vault\""));
    expect(blob).toBeDefined();
    if (blob === undefined) return;
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    expect(parsed["sync_needed"]).toBe(false);
    expect(parsed["inbox_pages"]).toBe(1);
    expect(parsed["inbox_raw_pages"]).toBe(1);
    expect(parsed["attention_required"]).toBe(true);
    expect(parsed["attention"]).toEqual(["capture_loop_inactive"]);
    expect(parsed["next_actions"]).toEqual([
      {
        reasons: ["capture_loop_inactive"],
        command: "dome inspect bundles --json",
        description:
          "Raw captures are waiting but the capture digestion loop is inactive or not model-ready; inspect dome.agent, enable it in .dome/config.yaml when ready, commit, then run dome sync --json.",
      },
    ]);
    const maintenanceLoops =
      parsed["maintenance_loops"] as ReadonlyArray<Record<string, unknown>>;
    expect(maintenanceLoops.find((loop) =>
      loop["id"] === "dome.capture.digest"
    )).toEqual(expect.objectContaining({
      state: "inactive",
      missing_processors: expect.arrayContaining([
        "dome.agent.ingest",
      ]),
    }));

    captured.out = [];
    captured.err = [];
    expect(await runStatus({ vault: f.vaultPath })).toBe(0);
    const text = captured.out.join("\n");
    expect(text).toContain("inbox 1 (1 raw)");
    expect(text).toContain("dome inspect bundles --json");
  });

  test("--json routes waiting raw captures before sync when intake lacks a model provider", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    await mkdir(join(f.vaultPath, ".dome"), { recursive: true });
    await mkdir(join(f.vaultPath, "inbox", "raw"), { recursive: true });
    await writeFile(
      join(f.vaultPath, ".dome", "config.yaml"),
      [
        "extensions:",
        "  dome.agent:",
        "    enabled: true",
        "    grant:",
        "      read:",
        "        - \"wiki/**/*.md\"",
        "        - \"notes/**/*.md\"",
        "        - \"inbox/**/*.md\"",
        "        - \"index.md\"",
        "        - \"log.md\"",
        "      patch.auto:",
        "        - \"wiki/**/*.md\"",
        "        - \"notes/**/*.md\"",
        "        - \"index.md\"",
        "        - \"log.md\"",
        "        - \"inbox/processed/*.md\"",
        "        - \"inbox/raw/*.md\"",
        "      model.invoke:",
        "        maxDailyCostUsd: 5",
        "      question.ask: true",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(f.vaultPath, "inbox", "raw", "day.md"),
      [
        "---",
        "type: source",
        "---",
        "",
        "# Raw day",
        "",
        "Captured management note.",
        "",
      ].join("\n"),
      "utf8",
    );
    await commit({
      path: f.vaultPath,
      message: "add raw capture without provider",
      files: [".dome/config.yaml", "inbox/raw/day.md"],
    });

    expect(await runStatus({ vault: f.vaultPath, json: true })).toBe(0);

    const blob = captured.out.find((l) => l.includes("\"vault\""));
    expect(blob).toBeDefined();
    if (blob === undefined) return;
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    expect(parsed["sync_needed"]).toBe(true);
    expect(parsed["inbox_raw_pages"]).toBe(1);
    expect(parsed["attention"]).toEqual([
      "sync_needed",
      "capture_loop_inactive",
    ]);
    expect(parsed["next_actions"]).toEqual([
      {
        reasons: ["capture_loop_inactive"],
        command: "dome inspect bundles --json",
        description:
          "Raw captures are waiting but the capture digestion loop is inactive or not model-ready; inspect dome.agent, enable it in .dome/config.yaml when ready, commit, then run dome sync --json.",
      },
      {
        reasons: ["sync_needed"],
        command: "dome sync --json",
        description:
          "Run one compiler tick to adopt pending commits or drain due operational work.",
      },
    ]);
    const maintenanceLoops =
      parsed["maintenance_loops"] as ReadonlyArray<Record<string, unknown>>;
    expect(maintenanceLoops.find((loop) =>
      loop["id"] === "dome.capture.digest"
    )).toEqual(expect.objectContaining({
      state: "quiet",
      active_processors: expect.arrayContaining([
        "dome.agent.ingest",
      ]),
    }));
  });

  test("--json keeps transient pending runs observable without routing attention", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    expect(await runSync({ vault: f.vaultPath, json: true, quiet: true })).toBe(
      0,
    );
    captured.out = [];
    captured.err = [];

    const ledger = await openLedgerDb({
      path: join(f.vaultPath, ".dome", "state", "runs.db"),
    });
    expect(ledger.ok).toBe(true);
    if (!ledger.ok) return;
    try {
      const runId = newRunId(new Date(), () => "trans1");
      insertQueued(ledger.value.db, {
        id: runId,
        proposalId: null,
        processorId: "test.status.transient",
        processorVersion: "0.0.1",
        phase: "view",
        inputCommit: commitOid(f.headSha),
        triggerKind: "command",
        triggerPayload: { command: "today" },
        startedAt: new Date(),
      });
      markRunning(ledger.value.db, runId, new Date());
    } finally {
      ledger.value.db.close();
    }

    expect(await runStatus({ vault: f.vaultPath, json: true })).toBe(0);

    const blob = captured.out.find((l) => l.includes("\"vault\""));
    expect(blob).toBeDefined();
    if (blob === undefined) return;
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    expect(parsed["pending_runs"]).toBe(1);
    expect(parsed["orphan_runs"]).toBe(0);
    expect(parsed["attention"]).not.toContain("pending_runs");
    const nextActions = parsed["next_actions"] as ReadonlyArray<{
      readonly reasons: ReadonlyArray<string>;
    }>;
    expect(
      nextActions.some((action) => action.reasons.includes("pending_runs")),
    ).toBe(false);
  });

  test("text mode distinguishes transient pending runs from stale run attention", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    expect(await runSync({ vault: f.vaultPath, json: true, quiet: true })).toBe(
      0,
    );
    captured.out = [];
    captured.err = [];

    const ledger = await openLedgerDb({
      path: join(f.vaultPath, ".dome", "state", "runs.db"),
    });
    expect(ledger.ok).toBe(true);
    if (!ledger.ok) return;
    try {
      const runId = newRunId(new Date(), () => "live01");
      insertQueued(ledger.value.db, {
        id: runId,
        proposalId: null,
        processorId: "test.status.live",
        processorVersion: "0.0.1",
        phase: "view",
        inputCommit: commitOid(f.headSha),
        triggerKind: "command",
        triggerPayload: { command: "prep" },
        startedAt: new Date(),
      });
      markRunning(ledger.value.db, runId, new Date());
    } finally {
      ledger.value.db.close();
    }

    expect(await runStatus({ vault: f.vaultPath })).toBe(0);

    const out = captured.out.join("\n");
    expect(out).toContain("runs"); expect(out).toContain("1 live pending · 0 failed");
    expect(out).not.toContain("pending 1 | failed");
    expect(out).not.toContain("pending_runs");

    const reopened = await openLedgerDb({
      path: join(f.vaultPath, ".dome", "state", "runs.db"),
    });
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    try {
      const runId = newRunId(new Date(0), () => "stale1");
      insertQueued(reopened.value.db, {
        id: runId,
        proposalId: null,
        processorId: "test.status.stale",
        processorVersion: "0.0.1",
        phase: "garden",
        inputCommit: commitOid(f.headSha),
        triggerKind: "schedule",
        triggerPayload: { test: "stale" },
        startedAt: new Date(0),
      });
      markRunning(reopened.value.db, runId, new Date(0));
    } finally {
      reopened.value.db.close();
    }

    captured.out = [];
    captured.err = [];
    expect(await runStatus({ vault: f.vaultPath })).toBe(0);

    const staleOut = captured.out.join("\n");
    expect(staleOut).toContain("runs"); expect(staleOut).toContain("2 total (1 stale) pending · 0 failed");
    expect(staleOut).toContain("dome check --json");
  });

  test("--json last_sync ignores newer view processor runs", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    const adoptedCommit = commitOid(f.headSha);

    const ledger = await openLedgerDb({
      path: join(f.vaultPath, ".dome", "state", "runs.db"),
    });
    if (!ledger.ok) {
      throw new Error(`ledger open failed: ${ledger.error.kind}`);
    }
    try {
      const compilerRunId = newRunId(new Date(10), () => "synced");
      const viewRunId = newRunId(new Date(20), () => "viewed");
      insertQueued(ledger.value.db, {
        id: compilerRunId,
        proposalId: null,
        processorId: "test.status.sync",
        processorVersion: "0.0.1",
        phase: "garden",
        inputCommit: adoptedCommit,
        triggerKind: "schedule",
        triggerPayload: { test: "sync" },
        startedAt: new Date(10),
      });
      markRunning(ledger.value.db, compilerRunId, new Date(11));
      markSucceeded(ledger.value.db, {
        id: compilerRunId,
        effectHashes: [],
        costUsd: null,
        durationMs: 1,
        outputCommit: null,
        finishedAt: new Date(12),
      });
      insertQueued(ledger.value.db, {
        id: viewRunId,
        proposalId: null,
        processorId: "test.status.view",
        processorVersion: "0.0.1",
        phase: "view",
        inputCommit: adoptedCommit,
        triggerKind: "command",
        triggerPayload: { command: "lint" },
        startedAt: new Date(20),
      });
      markRunning(ledger.value.db, viewRunId, new Date(21));
      markSucceeded(ledger.value.db, {
        id: viewRunId,
        effectHashes: [],
        costUsd: null,
        durationMs: 1,
        outputCommit: null,
        finishedAt: new Date(22),
      });
    } finally {
      ledger.value.db.close();
    }

    expect(await runStatus({ vault: f.vaultPath, json: true })).toBe(0);

    const blob = captured.out.find((l) => l.includes("\"vault\""));
    expect(blob).toBeDefined();
    if (blob === undefined) return;
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    expect(parsed["last_sync"]).toBe(new Date(10).toISOString());
    expect(parsed["recent_processor_runs"]).toEqual([
      expect.objectContaining({
        processor_id: "test.status.view",
        phase: "view",
        latest_started_at: new Date(20).toISOString(),
      }),
      expect.objectContaining({
        processor_id: "test.status.sync",
        phase: "garden",
        latest_started_at: new Date(10).toISOString(),
      }),
    ]);
  });

  test("--json mode does not route info-only diagnostics to attention", async () => {
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
    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    try {
      insertDiagnostic(projection.value.db, {
        effect: diagnosticEffect({
          severity: "info",
          code: "status.info",
          message: "informational diagnostic",
          sourceRefs: [ref],
        }),
        processorId: "test.status",
        proposalId: null,
        adoptedCommit,
      });
    } finally {
      projection.value.db.close();
    }

    expect(await runStatus({ vault: f.vaultPath, json: true })).toBe(0);

    const blob = captured.out.find((l) => l.includes("\"vault\""));
    expect(blob).toBeDefined();
    if (blob === undefined) return;
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    expect(parsed["diagnostics"]).toBe(1);
    expect(parsed["content_diagnostics"]).toBe(1);
    expect(parsed["unlocated_diagnostics"]).toBe(0);
    expect(parsed["attention_diagnostics"]).toBe(0);
    expect(record(parsed["attention_diagnostic_summary"])).toEqual({
      total: 0,
      group_count: 0,
      shown_groups: 0,
      omitted_groups: 0,
      groups: [],
    });
    expect(record(parsed["attention_diagnostic_message_summary"])).toEqual({
      total: 0,
      group_count: 0,
      shown_groups: 0,
      omitted_groups: 0,
      groups: [],
    });
    expect(record(parsed["attention_diagnostic_disposition_summary"])).toEqual({
      total: 0,
      group_count: 0,
      shown_groups: 0,
      omitted_groups: 0,
      groups: [],
    });
    const dispositionSummary = record(parsed["diagnostic_disposition_summary"]);
    expect(dispositionSummary["total"]).toBe(1);
    expect(dispositionSummary["group_count"]).toBe(1);
    expect(
      (dispositionSummary["groups"] as ReadonlyArray<Record<string, unknown>>)
        [0]?.["disposition"],
    ).toBe("agent-fixable");
    expect(parsed["attention"]).toContain("sync_needed");
    expect(parsed["attention"]).not.toContain("diagnostics");
    expect(parsed["next_actions"]).toEqual([
      {
        reasons: ["sync_needed"],
        command: "dome sync --json",
        description:
          "Run one compiler tick to adopt pending commits or drain due operational work.",
      },
    ]);
  });

  test("--json mode keeps source-less runtime diagnostics out of diagnostic attention", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    const adoptedCommit = commitOid(f.headSha);

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
          severity: "block",
          code: "processor.timeout",
          message: "test.status.runtime: Processor exceeded timeout of 10ms.",
          sourceRefs: [],
        }),
        processorId: "test.status.runtime",
        proposalId: null,
        adoptedCommit,
      });
    } finally {
      projection.value.db.close();
    }

    expect(await runStatus({ vault: f.vaultPath, json: true })).toBe(0);

    const blob = captured.out.find((l) => l.includes("\"vault\""));
    expect(blob).toBeDefined();
    if (blob === undefined) return;
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    expect(parsed["diagnostics"]).toBe(0);
    expect(parsed["content_diagnostics"]).toBe(0);
    expect(parsed["unlocated_diagnostics"]).toBe(1);
    expect(parsed["attention_diagnostics"]).toBe(0);
    expect(record(parsed["diagnostic_summary"])["total"]).toBe(0);
    expect(record(parsed["attention_diagnostic_summary"])["total"]).toBe(0);
    expect(parsed["attention"]).toContain("sync_needed");
    expect(parsed["attention"]).not.toContain("diagnostics");
  });

  test("text mode diagnostic top line focuses on actionable diagnostics", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    expect(await runSync({ vault: f.vaultPath, json: true })).toBe(0);
    captured.out = [];
    const head = await currentSha(f.vaultPath);
    expect(head).not.toBeNull();
    if (head === null) return;
    const adoptedCommit = commitOid(head);
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
    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    try {
      insertDiagnostic(projection.value.db, {
        effect: diagnosticEffect({
          severity: "info",
          code: "status.info",
          message: "informational diagnostic",
          sourceRefs: [ref],
        }),
        processorId: "test.status",
        proposalId: null,
        adoptedCommit,
      });
      insertDiagnostic(projection.value.db, {
        effect: diagnosticEffect({
          severity: "warning",
          code: "status.warning",
          message: "actionable diagnostic",
          sourceRefs: [ref],
        }),
        processorId: "test.status",
        proposalId: null,
        adoptedCommit,
      });
    } finally {
      projection.value.db.close();
    }

    expect(await runStatus({ vault: f.vaultPath })).toBe(0);
    const text = captured.out.join("\n");
    const topLine = text.split("\n").find((line) =>
      line.includes("top: ")
    );
    expect(topLine).toBeDefined();
    expect(topLine).toContain("1 warning status.warning");
    expect(topLine).not.toContain("status.info");
    const focusLine = text
      .split("\n")
      .find((line) => line.includes("fix: "));
    expect(focusLine).toBeDefined();
    expect(focusLine).toContain("actionable diagnostic");
    expect(focusLine).not.toContain("informational diagnostic");
  });

  test("--json mode routes diagnostics-only attention to bounded content check", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    expect(await runSync({ vault: f.vaultPath, json: true })).toBe(0);
    captured.out = [];
    const head = await currentSha(f.vaultPath);
    expect(head).not.toBeNull();
    if (head === null) return;
    const adoptedCommit = commitOid(head);
    const ref = sourceRef({
      commit: adoptedCommit,
      path: "wiki/seed.md",
      range: { startLine: 3, endLine: 3 },
    });

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
          code: "status.warning",
          message: "actionable diagnostic",
          sourceRefs: [ref],
        }),
        processorId: "test.status",
        proposalId: null,
        adoptedCommit,
      });
    } finally {
      projection.value.db.close();
    }

    expect(await runStatus({ vault: f.vaultPath, json: true })).toBe(0);

    const blob = captured.out.find((l) => l.includes("\"vault\""));
    expect(blob).toBeDefined();
    if (blob === undefined) return;
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    expect(parsed["attention"]).toEqual(["diagnostics"]);
    expect(parsed["next_actions"]).toEqual([
      {
        reasons: ["diagnostics"],
        command: "dome check --content --attention --limit 50 --json",
        description:
          "Review bounded actionable content diagnostics; fix the source markdown issue(s), commit, then run dome sync --json.",
      },
    ]);
    const summary = record(parsed["diagnostic_summary"]);
    const groups = summary["groups"] as ReadonlyArray<Record<string, unknown>>;
    const group = groups.find((item) => item["code"] === "status.warning");
    expect(group?.["first_source_refs"]).toContain("wiki/seed.md:3");
    const attentionSummary = record(parsed["attention_diagnostic_summary"]);
    expect(attentionSummary).toEqual(summary);
    const firstSourceRefs =
      group?.["firstSourceRefs"] as ReadonlyArray<Record<string, unknown>>;
    expect(firstSourceRefs[0]?.["path"]).toBe("wiki/seed.md");
    expect(firstSourceRefs[0]?.["commit"]).toBe(adoptedCommit);
  });

  test("--json mode includes message-level diagnostic repair grouping", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    expect(await runSync({ vault: f.vaultPath, json: true })).toBe(0);
    captured.out = [];
    const head = await currentSha(f.vaultPath);
    expect(head).not.toBeNull();
    if (head === null) return;
    const adoptedCommit = commitOid(head);
    const firstRef = sourceRef({
      commit: adoptedCommit,
      path: "wiki/seed.md",
      range: { startLine: 3, endLine: 3 },
    });
    const secondRef = sourceRef({
      commit: adoptedCommit,
      path: "wiki/new.md",
      range: { startLine: 5, endLine: 5 },
    });

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
          code: "status.warning",
          message: "broken target alpha",
          sourceRefs: [firstRef],
        }),
        processorId: "test.status",
        proposalId: null,
        adoptedCommit,
      });
      insertDiagnostic(projection.value.db, {
        effect: diagnosticEffect({
          severity: "warning",
          code: "status.warning",
          message: "broken target beta",
          sourceRefs: [secondRef],
        }),
        processorId: "test.status",
        proposalId: null,
        adoptedCommit,
      });
    } finally {
      projection.value.db.close();
    }

    expect(await runStatus({ vault: f.vaultPath, json: true })).toBe(0);

    const blob = captured.out.find((l) => l.includes("\"vault\""));
    expect(blob).toBeDefined();
    if (blob === undefined) return;
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    const codeSummary = record(parsed["attention_diagnostic_summary"]);
    const codeGroups = codeSummary["groups"] as ReadonlyArray<
      Record<string, unknown>
    >;
    expect(
      codeGroups.find((group) => group["code"] === "status.warning"),
    ).toEqual(
      expect.objectContaining({
        severity: "warning",
        code: "status.warning",
        count: 2,
      }),
    );
    const messageSummary = record(
      parsed["attention_diagnostic_message_summary"],
    );
    expect(Number(messageSummary["group_count"])).toBeGreaterThanOrEqual(2);
    const groups = (
      messageSummary["groups"] as ReadonlyArray<Record<string, unknown>>
    ).filter((group) => group["code"] === "status.warning");
    expect(groups.map((group) => group["message"])).toEqual([
      "broken target alpha",
      "broken target beta",
    ]);
    expect(groups[0]?.["first_source_refs"]).toBe("wiki/seed.md:3");
    expect(groups[1]?.["first_source_refs"]).toBe("wiki/new.md:5");
  });

  test("--json mode reports stale projection rows as attention", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    expect(await runSync({ vault: f.vaultPath, json: true })).toBe(0);
    captured.out = [];

    const projection = await openProjectionDb({
      path: join(f.vaultPath, ".dome", "state", "projection.db"),
      extensionSet: [],
      processorVersions: [],
      capabilityPolicyHash: "stale-policy",
    });
    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    try {
      markProjectionBuilt(projection.value.db, {
        adoptedCommit: commitOid(f.headSha),
        extensionSet: [],
        processorVersions: [],
        capabilityPolicyHash: "stale-policy",
      });
    } finally {
      projection.value.db.close();
    }

    expect(await runStatus({ vault: f.vaultPath, json: true })).toBe(0);

    const blob = captured.out.find((l) => l.includes("\"vault\""));
    expect(blob).toBeDefined();
    if (blob === undefined) return;
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    expect(parsed["projection_stale"]).toBe(true);
    expect(parsed["projection_cache_drift"]).toBe(true);
    expect(parsed["attention"]).toEqual(
      expect.arrayContaining(["projection_stale"]),
    );
    expect(parsed["next_actions"]).toEqual(expect.arrayContaining([
      {
        reasons: ["projection_stale"],
        command: "dome sync --json",
        description:
          "Run one compiler tick to rebuild stale projections from adopted markdown.",
      },
    ]));
    expect((parsed["attention"] as ReadonlyArray<string>)[0]).toBe(
      "projection_stale",
    );
  });

  test("check --content --json reports stale projection rows", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    expect(await runSync({ vault: f.vaultPath, json: true })).toBe(0);
    captured.out = [];

    const projection = await openProjectionDb({
      path: join(f.vaultPath, ".dome", "state", "projection.db"),
      extensionSet: [],
      processorVersions: [],
      capabilityPolicyHash: "stale-policy",
    });
    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    try {
      markProjectionBuilt(projection.value.db, {
        adoptedCommit: commitOid(f.headSha),
        extensionSet: [],
        processorVersions: [],
        capabilityPolicyHash: "stale-policy",
      });
    } finally {
      projection.value.db.close();
    }

    expect(await runCheck({
      vault: f.vaultPath,
      content: true,
      json: true,
    })).toBe(0);

    const blob = captured.out.find((l) => l.includes("\"schema\""));
    expect(blob).toBeDefined();
    if (blob === undefined) return;
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    expect(record(parsed["scopes"])["engine"]).toBe(false);
    expect(record(parsed["projection"])["stale"]).toBe(true);
    expect(parsed["status"]).toBe("attention");
    expect(parsed["next_actions"]).toEqual(expect.arrayContaining([
      {
        reasons: ["projection_stale"],
        command: "dome sync --json",
        description:
          "Rebuild stale projection rows before relying on projection-backed diagnostics or questions.",
      },
    ]));
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
    expect(parsed["attention"]).toContain("serve_stale");
    expect(parsed["next_actions"]).toEqual(expect.arrayContaining([
      {
        reasons: ["serve_stale"],
        command: "dome serve",
        description:
          "Restart the foreground compiler host so it can refresh the stale serve heartbeat.",
      },
    ]));
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
    expect(parsed["attention"]).toContain("serve_stale");
    expect(parsed["next_actions"]).toEqual(expect.arrayContaining([
      {
        reasons: ["serve_stale"],
        command: "dome serve",
        description:
          "Restart the foreground compiler host so it can refresh the stale serve heartbeat.",
      },
    ]));
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
    expect(parsed["dirty_untracked_paths"]).toEqual([
      "inbox/todo.md",
      "notes/day.md",
      "raw/capture.txt",
      "wiki/links.md",
    ]);
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
    expect(parsed["dirty_untracked_paths"]).toEqual([]);
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
          metadata: {
            risk: "low",
            confidence: 0.75,
            recommendedAnswer: "one",
            automationPolicy: "agent-safe",
          },
        }),
        processorId: "dome.daily.ambiguous-followup-answer",
        runId: "run-test-fixture",
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
      const timedOutRunId = newRunId(new Date(5), () => "statto");
      const runningRunId = newRunId(new Date(8), () => "statrn");
      const succeededRunId = newRunId(new Date(10), () => "statok");
      const latestProblemRunId = newRunId(new Date(15), () => "statpr");
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
        id: timedOutRunId,
        proposalId: null,
        processorId: "test.status",
        processorVersion: "0.0.1",
        phase: "garden",
        inputCommit: adoptedCommit,
        triggerKind: "schedule",
        triggerPayload: { test: "timeout" },
        startedAt: new Date(5),
      });
      markRunning(ledger.value.db, timedOutRunId, new Date(6));
      markTimedOut(ledger.value.db, {
        id: timedOutRunId,
        error: {
          code: "processor.timeout",
          message: "timed out",
          retryable: true,
          phase: "garden",
          processorId: "test.status",
        },
        durationMs: 1,
        finishedAt: new Date(7),
      });
      insertQueued(ledger.value.db, {
        id: runningRunId,
        proposalId: null,
        processorId: "test.status",
        processorVersion: "0.0.1",
        phase: "garden",
        inputCommit: adoptedCommit,
        triggerKind: "schedule",
        triggerPayload: { test: "running" },
        startedAt: new Date(8),
      });
      markRunning(ledger.value.db, runningRunId, new Date(9));
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
      insertQueued(ledger.value.db, {
        id: latestProblemRunId,
        proposalId: null,
        processorId: "test.status.problem",
        processorVersion: "0.0.1",
        phase: "garden",
        inputCommit: adoptedCommit,
        triggerKind: "schedule",
        triggerPayload: { test: "latest-problem" },
        startedAt: new Date(15),
      });
      markRunning(ledger.value.db, latestProblemRunId, new Date(16));
      markTimedOut(ledger.value.db, {
        id: latestProblemRunId,
        error: {
          code: "processor.timeout",
          message: "still timed out",
          retryable: true,
          phase: "garden",
          processorId: "test.status.problem",
        },
        durationMs: 1,
        finishedAt: new Date(17),
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
    expect(parsed["attention_diagnostics"]).toBe(1);
    expect(parsed["diagnostic_summary"]).toEqual({
      total: 1,
      group_count: 1,
      shown_groups: 1,
      omitted_groups: 0,
      groups: [
        {
          severity: "warning",
          code: "status.test",
          count: 1,
          first_message: "status diagnostic",
          first_source_refs: "wiki/seed.md",
          firstSourceRefs: [
            {
              commit: adoptedCommit,
              path: "wiki/seed.md",
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(parsed["diagnostic_summary"])).toContain(
      adoptedCommit,
    );
    expect(parsed["questions"]).toBe(1);
    const maintenanceLoops =
      parsed["maintenance_loops"] as ReadonlyArray<Record<string, unknown>>;
    const openLoopSummary = maintenanceLoops.find((loop) =>
      loop["id"] === "dome.open-loop.continuity"
    );
    expect(openLoopSummary).toEqual(expect.objectContaining({
      questions: 1,
      agent_safe_questions: 1,
      model_safe_questions: 0,
      owner_needed_questions: 0,
    }));
    expect(parsed["outbox_pending"]).toBe(1);
    expect(parsed["outbox_failed"]).toBe(1);
    expect(parsed["pending_runs"]).toBe(1);
    expect(parsed["orphan_runs"]).toBe(1);
    expect(parsed["failed_runs"]).toBe(1);
    expect(parsed["quarantined"]).toBe(1);
    expect(parsed["attention_required"]).toBe(true);
    expect(parsed["attention"]).toEqual([
      "sync_needed",
      "pending_runs",
      "failed_runs",
      "diagnostics",
      "questions",
      "outbox_pending",
      "outbox_failed",
      "quarantined",
    ]);
    expect(parsed["next_actions"]).toEqual([
      {
        reasons: ["sync_needed", "outbox_pending"],
        command: "dome sync --json",
        description:
          "Run one compiler tick to adopt pending commits or drain due operational work.",
      },
      {
        reasons: [
          "pending_runs",
          "failed_runs",
          "diagnostics",
          "questions",
          "outbox_failed",
          "quarantined",
        ],
        command: "dome check --json",
        description:
          "Explain remaining compiler attention across engine health, content diagnostics, and open decisions.",
      },
    ]);
    expect(parsed["recent_processor_runs"]).toEqual([
      {
        processor_id: "test.status.problem",
        processor_version: "0.0.1",
        phase: "garden",
        latest_run_id: "run_15_statpr",
        latest_status: "timed_out",
        latest_started_at: new Date(15).toISOString(),
        latest_finished_at: new Date(17).toISOString(),
        latest_duration_ms: 1,
        recent_runs: 1,
        recent_problem_runs: 1,
      },
      {
        processor_id: "test.status",
        processor_version: "0.0.1",
        phase: "garden",
        latest_run_id: "run_10_statok",
        latest_status: "succeeded",
        latest_started_at: new Date(10).toISOString(),
        latest_finished_at: new Date(12).toISOString(),
        latest_duration_ms: 2,
        recent_runs: 4,
        recent_problem_runs: 2,
      },
    ]);
  });

  // The "status after a submit reports the advanced adopted ref" test
  // was retired in Phase 11a along with `runSubmit`; the corresponding
  // assertion against an advanced adopted ref will land in the Phase 11b
  // daemon integration tests, which drive adoption via the watcher.
});
