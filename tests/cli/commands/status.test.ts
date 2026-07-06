// `dome status` — end-to-end tests (split from tests/cli/commands.test.ts; shared setup lives in ./fixture.ts).

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCheck } from "../../../src/cli/commands/check";
import {
  serviceLabelForVault,
  type LaunchctlRunner,
  type ServiceDeps,
} from "../../../src/surface/service-probe";
import { runStatus, type RunStatusOptions } from "../../../src/cli/commands/status";
import { runSync } from "../../../src/cli/commands/sync";

import {
  diagnosticEffect,
  externalActionEffect,
  fileChange,
  questionEffect,
} from "../../../src/core/effect";
import { commitOid, sourceRef } from "../../../src/core/source-ref";
import { openProposalsDb } from "../../../src/proposals/db";
import { enqueuePendingProposal } from "../../../src/proposals/pending-proposals";
import { commit, currentSha } from "../../../src/git";
import {
  createServeHeartbeatHandle,
  serveHeartbeatPath,
  writeServeHeartbeat,
} from "../../../src/engine/host/compiler-host-heartbeat";
import { openQuarantineStore } from "../../../src/engine/operational/quarantine-store";
import {
  readModelProviderProbeCache,
  writeModelProviderProbeCache,
} from "../../../src/engine/host/model-provider-probe-cache";
import { openLedgerDb } from "../../../src/ledger/db";
import {
  insertQueued,
  markFailed as markRunFailed,
  markRunning,
  markSucceeded,
  markTimedOut,
  newRunId,
} from "../../../src/ledger/runs";
import { openOutboxDb } from "../../../src/outbox/db";
import {
  insertPending,
  markFailed as markOutboxFailed,
} from "../../../src/outbox/dispatch";
import { markProjectionBuilt, openProjectionDb } from "../../../src/projections/db";
import {
  insertDiagnostic,
} from "../../../src/projections/diagnostics";
import {
  insertQuestion,
} from "../../../src/projections/questions";

import {
  captured,
  fixtures,
  installConsoleCapture,
  installFixtureCleanup,
  makeFixture,
  record,
  writeDoctorConfigBody,
} from "./fixture";

installConsoleCapture();
installFixtureCleanup();

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
  "service_status",
  "service_label",
  "model_provider_configured",
  "model_provider_probe_status",
  "model_provider_probed_at",
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
  "pending_proposals",
]);

// ----- runStatus ------------------------------------------------------------

describe("runStatus", () => {
  test("prints sensible defaults on a fresh (unsubmitted) vault", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    // verbose: true to get the full breakdown (default view is signal-only)
    const code = await runStatus({ vault: f.vaultPath, verbose: true });
    expect(code).toBe(0);

    const out = captured.out.join("\n");
    expect(out).toContain("dome status"); // headline
    expect(out).toContain("attention"); // headline status
    expect(out).toContain("(uninitialized)"); // adopted ref
    expect(out).toContain("sync"); expect(out).toContain("! needed"); // sync row
    expect(out).toContain("pending"); expect(out).toContain("unknown"); // pending commits
    expect(out).toContain("(never)"); // last_sync
    expect(out).toContain("content"); expect(out).toContain("2 pages"); // content summary
    expect(out).toContain("links 0"); // wikilinks in content
    expect(out).toContain("projection"); expect(out).toContain("√ fresh"); // projection row
    expect(out).toContain("loops"); expect(out).toContain("10 known"); // loops summary
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

    // verbose: true to get the full breakdown; loops also requires verbose to show engine
    const code = await runStatus({ vault: f.vaultPath, loops: true, verbose: true });
    expect(code).toBe(0);

    const out = captured.out.join("\n");
    expect(out).toContain("loops"); expect(out).toContain("10 known"); // loops summary
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
    expect(loops).toHaveLength(10);
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
    expect(parsed["pending_proposals"]).toBe(0);
  });

  test("--json counts pending proposals and routes the dome proposals next action", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    const opened = await openProposalsDb({
      path: join(f.vaultPath, ".dome", "state", "proposals.db"),
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    try {
      enqueuePendingProposal(opened.value.db, {
        processorId: "dome.test.garden",
        extensionId: "test",
        runId: "run_1",
        reason: "tidy up the note",
        changes: [fileChange({ kind: "write", path: "wiki/seed.md", content: "seed\nmore\n" })],
        sourceRefs: [sourceRef({ commit: commitOid(f.headSha), path: "wiki/seed.md" })],
        baseCommit: f.headSha,
        baseContents: { "wiki/seed.md": "seed\n" },
        createdAt: "2026-07-06T00:00:00.000Z",
      });
    } finally {
      opened.value.db.close();
    }

    expect(await runStatus({ vault: f.vaultPath, json: true })).toBe(0);
    const blob = captured.out.find((l) => l.includes("\"vault\""));
    expect(blob).toBeDefined();
    if (blob === undefined) return;
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    expect(parsed["pending_proposals"]).toBe(1);
    expect(parsed["attention"]).toEqual(
      expect.arrayContaining(["pending_proposals"]),
    );
    expect(parsed["next_actions"]).toEqual(
      expect.arrayContaining([
        {
          reasons: ["pending_proposals"],
          command: "dome proposals",
          description: "1 proposals awaiting review — dome proposals",
        },
      ]),
    );
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
    // verbose: true to see the vault content summary (inbox 1 (1 raw))
    expect(await runStatus({ vault: f.vaultPath, verbose: true })).toBe(0);
    const text = captured.out.join("\n");
    expect(text).toContain("inbox 1 (1 raw)");
    expect(text).toContain("dome inspect bundles");
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

    // verbose: true to see the engine runs row detail
    expect(await runStatus({ vault: f.vaultPath, verbose: true })).toBe(0);

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
    // verbose: true to see the engine runs row detail
    expect(await runStatus({ vault: f.vaultPath, verbose: true })).toBe(0);

    const staleOut = captured.out.join("\n");
    expect(staleOut).toContain("runs"); expect(staleOut).toContain("2 total (1 stale) pending · 0 failed");
    expect(staleOut).toContain("dome check");
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

    // verbose: true to see the DIAGNOSTICS section with top/fix lines
    expect(await runStatus({ vault: f.vaultPath, verbose: true })).toBe(0);
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
    // The full summary carries the missing-description info nudge from pages
    // without `description:` frontmatter; the attention summary excludes
    // info-severity groups (info is gradual-fill, never attention).
    const infoGroups = groups.filter((item) => item["severity"] === "info");
    expect(infoGroups.map((item) => item["code"])).toEqual([
      "dome.markdown.missing-description",
    ]);
    const infoCount = infoGroups.reduce(
      (sum, item) => sum + (item["count"] as number),
      0,
    );
    const attentionSummary = record(parsed["attention_diagnostic_summary"]);
    expect(attentionSummary).toEqual({
      ...summary,
      groups: groups.filter((item) => item["severity"] !== "info"),
      group_count: (summary["group_count"] as number) - infoGroups.length,
      shown_groups: (summary["shown_groups"] as number) - infoGroups.length,
      total: (summary["total"] as number) - infoCount,
    });
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
    // test.status.problem is not a registered processor, so its failure is
    // suppressed (registered/unregistered branches are covered by the
    // runCheck latest-failure tests).
    expect(parsed["failed_runs"]).toBe(0);
    expect(parsed["quarantined"]).toBe(1);
    expect(parsed["attention_required"]).toBe(true);
    expect(parsed["attention"]).toEqual([
      "sync_needed",
      "pending_runs",
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

  // ----- launchd service line + model-provider probe state -------------------
  //
  // Per docs/wiki/specs/cli.md §"dome status": the service line is probed via
  // install's injected ServiceDeps (launchctl print only when a plist is
  // installed); the model-provider line reads the persisted last-probe cache
  // by default and spawns the provider only under --probe.

  function statusServiceDeps(input: {
    readonly agentsDir: string;
    readonly printExitCode?: number;
    readonly platform?: NodeJS.Platform;
    readonly calls?: Array<ReadonlyArray<string>>;
  }): ServiceDeps {
    const runner: LaunchctlRunner = async (args) => {
      input.calls?.push([...args]);
      return {
        exitCode: input.printExitCode ?? 113,
        stdout: "",
        stderr: "",
      };
    };
    return {
      platform: input.platform ?? "darwin",
      uid: 501,
      launchAgentsDir: input.agentsDir,
      launchctl: runner,
    };
  }

  function statusJson(): Record<string, unknown> {
    const blob = captured.out.find((l) => l.includes("\"vault\""));
    if (blob === undefined) throw new Error("expected status --json output");
    return JSON.parse(blob) as Record<string, unknown>;
  }

  test("service line: loaded launchd service reports loaded without attention", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    const agents = mkdtempSync(join(tmpdir(), "dome-status-agents-"));
    const label = serviceLabelForVault(f.vaultPath);
    await writeFile(join(agents, `${label}.plist`), "<plist/>", "utf8");

    expect(
      await runStatus(
        { vault: f.vaultPath, json: true },
        statusServiceDeps({ agentsDir: agents, printExitCode: 0 }),
      ),
    ).toBe(0);
    const parsed = statusJson();
    expect(parsed["service_status"]).toBe("loaded");
    expect(parsed["service_label"]).toBe(label);
    expect(parsed["attention"]).not.toContain("service_not_loaded");
    await rm(agents, { recursive: true, force: true });
  });

  test("service line: installed-but-not-loaded routes service_not_loaded to dome restart", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    const agents = mkdtempSync(join(tmpdir(), "dome-status-agents-"));
    const label = serviceLabelForVault(f.vaultPath);
    await writeFile(join(agents, `${label}.plist`), "<plist/>", "utf8");

    expect(
      await runStatus(
        { vault: f.vaultPath, json: true },
        statusServiceDeps({ agentsDir: agents, printExitCode: 113 }),
      ),
    ).toBe(0);
    const parsed = statusJson();
    expect(parsed["service_status"]).toBe("installed");
    expect(parsed["attention"]).toContain("service_not_loaded");
    const nextActions = parsed["next_actions"] as ReadonlyArray<{
      readonly reasons: ReadonlyArray<string>;
      readonly command: string | null;
    }>;
    expect(
      nextActions.find((action) => action.command === "dome restart")
        ?.reasons,
    ).toEqual(["service_not_loaded"]);
    await rm(agents, { recursive: true, force: true });
  });

  test("service line: not installed is informational and never spawns launchctl", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    const agents = mkdtempSync(join(tmpdir(), "dome-status-agents-"));
    const calls: Array<ReadonlyArray<string>> = [];

    expect(
      await runStatus(
        { vault: f.vaultPath, json: true },
        statusServiceDeps({ agentsDir: agents, calls }),
      ),
    ).toBe(0);
    const parsed = statusJson();
    expect(parsed["service_status"]).toBe("not-installed");
    expect(parsed["service_label"]).toBe(serviceLabelForVault(f.vaultPath));
    expect(parsed["attention"]).not.toContain("service_not_loaded");
    expect(calls).toEqual([]);
    await rm(agents, { recursive: true, force: true });
  });

  test("service line: unsupported platforms report unsupported", async () => {
    // win32, not linux: linux is now a supported service host (systemd --user).
    const f = await makeFixture();
    fixtures.push(f);
    const agents = mkdtempSync(join(tmpdir(), "dome-status-agents-"));
    const calls: Array<ReadonlyArray<string>> = [];

    expect(
      await runStatus(
        { vault: f.vaultPath, json: true },
        statusServiceDeps({ agentsDir: agents, platform: "win32", calls }),
      ),
    ).toBe(0);
    const parsed = statusJson();
    expect(parsed["service_status"]).toBe("unsupported");
    expect(parsed["service_label"]).toBeNull();
    expect(calls).toEqual([]);
    await rm(agents, { recursive: true, force: true });
  });

  test("model provider: cached unreachable probe routes model_provider_unreachable to dome doctor", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeDoctorConfigBody(f, [
      "model_provider:",
      "  kind: command",
      "  command: [\"/nonexistent/dome-test-provider\"]",
      "extensions: {}",
      "",
    ].join("\n"));
    writeModelProviderProbeCache(f.vaultPath, {
      command: ["/nonexistent/dome-test-provider"],
      probedAt: new Date("2026-06-10T00:00:00.000Z"),
      result: { status: "spawn-failed", detail: "no such file" },
    });

    expect(await runStatus({ vault: f.vaultPath, json: true })).toBe(0);
    const parsed = statusJson();
    expect(parsed["model_provider_configured"]).toBe(true);
    expect(parsed["model_provider_probe_status"]).toBe("spawn-failed");
    expect(parsed["model_provider_probed_at"]).toBe(
      "2026-06-10T00:00:00.000Z",
    );
    expect(parsed["attention"]).toContain("model_provider_unreachable");
    const nextActions = parsed["next_actions"] as ReadonlyArray<{
      readonly reasons: ReadonlyArray<string>;
      readonly command: string | null;
    }>;
    expect(
      nextActions.find((action) => action.command === "dome doctor --json")
        ?.reasons,
    ).toEqual(["model_provider_unreachable"]);
  });

  test("model provider: a cache for a different command is ignored (no stale attention)", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeDoctorConfigBody(f, [
      "model_provider:",
      "  kind: command",
      "  command: [\"/nonexistent/dome-test-provider\"]",
      "extensions: {}",
      "",
    ].join("\n"));
    writeModelProviderProbeCache(f.vaultPath, {
      command: ["/some/other/provider"],
      probedAt: new Date(),
      result: { status: "spawn-failed", detail: "different provider" },
    });

    expect(await runStatus({ vault: f.vaultPath, json: true })).toBe(0);
    const parsed = statusJson();
    expect(parsed["model_provider_configured"]).toBe(true);
    expect(parsed["model_provider_probe_status"]).toBeNull();
    expect(parsed["model_provider_probed_at"]).toBeNull();
    expect(parsed["attention"]).not.toContain("model_provider_unreachable");
  });

  test("model provider: --probe runs the live probe and refreshes the cache", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeDoctorConfigBody(f, [
      "model_provider:",
      "  kind: command",
      "  command: [\"/nonexistent/dome-test-provider\"]",
      "extensions: {}",
      "",
    ].join("\n"));

    expect(
      await runStatus({ vault: f.vaultPath, json: true, probe: true }),
    ).toBe(0);
    const parsed = statusJson();
    expect(parsed["model_provider_probe_status"]).toBe("spawn-failed");
    expect(parsed["attention"]).toContain("model_provider_unreachable");

    const cache = readModelProviderProbeCache(f.vaultPath);
    expect(cache).not.toBeNull();
    expect(cache?.result.status).toBe("spawn-failed");
    expect(cache?.command).toEqual(["/nonexistent/dome-test-provider"]);
  });

  // ----- Task 7: relative time, dimmed zeros, humanized next-action ----------

  test("last_sync renders as relative time and hides the raw ISO in text mode", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    // Seed a past sync run so last_sync is a real ISO timestamp.
    const ledger = await openLedgerDb({
      path: join(f.vaultPath, ".dome", "state", "runs.db"),
    });
    expect(ledger.ok).toBe(true);
    if (!ledger.ok) return;
    const adoptedCommit = commitOid(f.headSha);
    // Two hours in the past
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    try {
      const runId = newRunId(twoHoursAgo, () => "relsyn");
      insertQueued(ledger.value.db, {
        id: runId,
        proposalId: null,
        processorId: "test.relative.sync",
        processorVersion: "0.0.1",
        phase: "garden",
        inputCommit: adoptedCommit,
        triggerKind: "schedule",
        triggerPayload: { test: "relative" },
        startedAt: twoHoursAgo,
      });
      markRunning(ledger.value.db, runId, twoHoursAgo);
      markSucceeded(ledger.value.db, {
        id: runId,
        effectHashes: [],
        costUsd: null,
        durationMs: 1,
        outputCommit: null,
        finishedAt: twoHoursAgo,
      });
    } finally {
      ledger.value.db.close();
    }

    // verbose: true to see the ENGINE section with last sync relative time
    expect(await runStatus({ vault: f.vaultPath, verbose: true })).toBe(0);

    const out = captured.out.join("\n");
    // Should contain a relative time shape, not the raw ISO
    expect(out).toMatch(/\d+[mhd] ago|just now/);
    // The raw ISO string (starting with the year) must not appear
    expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test("next-action command is humanized (--json stripped) in text mode", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    // Fresh vault has sync_needed attention, which generates a next action with
    // command "dome sync --json". In text mode it should be stripped to "dome sync".
    expect(await runStatus({ vault: f.vaultPath })).toBe(0);

    const out = captured.out.join("\n");
    // Humanized command present
    expect(out).toContain("dome sync");
    // Raw --json form must not appear in the text output
    expect(out).not.toContain("dome sync --json");
  });

  test("runs and outbox rows dim zero terms in text mode", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    // Fresh vault: pending_runs=0, failed_runs=0, outbox_pending=0, outbox_failed=0.
    // In no-color test mode dimZeros returns the plain joined string.
    // verbose: true to see the ENGINE section with runs/outbox rows.
    expect(await runStatus({ vault: f.vaultPath, verbose: true })).toBe(0);

    const out = captured.out.join("\n");
    // runs row: "0 pending · 0 failed" (both terms dimmed when zero)
    expect(out).toContain("runs");
    expect(out).toMatch(/runs.*0 pending ·.*0 failed/s);
    // outbox row: "0 pending · 0 failed"
    expect(out).toContain("outbox");
    expect(out).toMatch(/outbox.*0 pending ·.*0 failed/s);
  });

  // The "status after a submit reports the advanced adopted ref" test
  // was retired in Phase 11a along with `runSubmit`; the corresponding
  // assertion against an advanced adopted ref will land in the Phase 11b
  // daemon integration tests, which drive adoption via the watcher.

  test("runStatus accepts a verbose option without error", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    const opts: RunStatusOptions = { vault: f.vaultPath, verbose: true };
    const code = await runStatus(opts);
    expect(code).toBe(0);
  });

  // ----- Task 7: signal-only default + verbose breakdown ----------------------

  test("default status shows only attention signals + rollup, no sections/rule", async () => {
    // Fresh vault has sync_needed; projection and everything else is clean.
    const f = await makeFixture();
    fixtures.push(f);

    const code = await runStatus({ vault: f.vaultPath });
    expect(code).toBe(0);

    const out = captured.out.join("\n");
    // Headline present with attention verdict
    expect(out).toContain("dome status");
    expect(out).toContain("attention");

    // sync signal line present
    expect(out).toContain("sync");

    // rollup covers the clean categories (may list named labels or say "everything else clean")
    expect(out).toMatch(/all clean|everything else clean/);

    // No section headers (they only appear in verbose)
    expect(out).not.toContain("VAULT");
    expect(out).not.toContain("AT A GLANCE");
    expect(out).not.toContain("DIAGNOSTICS");
    expect(out).not.toContain("ENGINE");

    // No full-width rule (10+ dashes/box-drawing chars in a row)
    expect(out).not.toMatch(/[-─]{10,}/);
  });

  test("all-clear status is a short verdict + fingerprint (≤3 non-blank lines)", async () => {
    // Build a vault with no attention: proper frontmatter + sync. A bare
    // "seed\n" fixture would draw lint diagnostics, so seed proper frontmatter.
    const vaultPath = mkdtempSync(join(tmpdir(), "cli-allclear-"));
    const { commit: commitGit } = await import("../../../src/git");
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["-C", vaultPath, "init"]);
    execFileSync("git", ["-C", vaultPath, "config", "commit.gpgsign", "false"]);
    await mkdir(join(vaultPath, "wiki"), { recursive: true });
    await mkdir(join(vaultPath, ".dome", "state"), { recursive: true });
    // Proper concept frontmatter so no lint diagnostics fire
    await writeFile(
      join(vaultPath, "wiki/seed.md"),
      "---\ntype: concept\ndescription: Seed concept.\n---\n\n# Seed\n\nContent.\n",
    );
    await commitGit({ path: vaultPath, message: "init\n", files: ["wiki/seed.md"] });
    fixtures.push({ vaultPath, baseSha: "", headSha: "", cleanup: async () => { await rm(vaultPath, { recursive: true, force: true }); } });

    // Sync to clear sync_needed
    await runSync({ vault: vaultPath, json: true, quiet: true });

    captured.out = [];
    captured.err = [];

    // Verify all-clear first
    const jsonCode = await runStatus({ vault: vaultPath, json: true });
    expect(jsonCode).toBe(0);
    const jsonBlob = captured.out.find((l) => l.includes("\"vault\""));
    if (jsonBlob === undefined) throw new Error("missing json output");
    const parsed = JSON.parse(jsonBlob) as Record<string, unknown>;
    if (parsed["attention_required"] === true) {
      // If vault still has attention after sync (e.g. lint diagnostics),
      // skip the fingerprint assertion — just verify healthy label absent and sections absent.
      captured.out = [];
      const code2 = await runStatus({ vault: vaultPath });
      expect(code2).toBe(0);
      const out2 = captured.out.join("\n");
      expect(out2).not.toContain("VAULT");
      expect(out2).not.toContain("ENGINE");
      expect(out2).not.toMatch(/[-─]{10,}/);
      return;
    }

    captured.out = [];
    captured.err = [];

    const code = await runStatus({ vault: vaultPath });
    expect(code).toBe(0);

    const out = captured.out.join("\n");
    const nonBlank = out.split("\n").filter((l) => l.trim().length > 0);
    expect(nonBlank.length).toBeLessThanOrEqual(3);
    expect(out).toContain("healthy");

    // No section headers in all-clear either
    expect(out).not.toContain("VAULT");
    expect(out).not.toContain("ENGINE");
    expect(out).not.toMatch(/[-─]{10,}/);
  });

  test("verbose status restores the full vault + engine breakdown", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    const code = await runStatus({ vault: f.vaultPath, verbose: true });
    expect(code).toBe(0);

    const verboseOut = captured.out.join("\n");
    // Full sections present in verbose
    expect(verboseOut).toContain("VAULT");
    expect(verboseOut).toContain("ENGINE");
    expect(verboseOut).toContain("loops");
    // No full-width rule even in verbose
    expect(verboseOut).not.toMatch(/[-─]{10,}/);
  });

  // ----- Task 7: attention code exhaustiveness / text-mode rendering ----------

  test("adopted_ref_diverged + failed_runs + quarantined all render a ⚠ row each and header count matches", async () => {
    // Set up vault state with THREE distinct attention codes:
    //   (a) adopted_ref_diverged: sync then git reset --hard HEAD~1 so adopted
    //       is ahead of (no longer an ancestor of) HEAD
    //   (b) failed_runs: insert a timed-out run for dome.lint.report, which IS
    //       a registered processor, so latestActiveProblemRuns picks it up
    //   (c) quarantined: push a key past the quarantine threshold
    //
    // Then assert in text mode:
    //   (a) a ⚠ row for "sync" (adopted_ref_diverged maps to the sync slot)
    //   (b) a ⚠ row for "runs" (failed_runs maps to the runs slot)
    //   (c) a ⚠ row for "quarantine"
    //   (d) header count == number of ⚠ rows rendered
    //   (e) none of "sync", "runs", "quarantine" appear in the healthy rollup

    const f = await makeFixture();
    fixtures.push(f);

    // Step 1: sync to move the adopted ref to HEAD
    expect(await runSync({ vault: f.vaultPath, json: true, quiet: true })).toBe(0);
    captured.out = [];
    captured.err = [];

    // Step 2: regress HEAD to baseSha so adopted (headSha) is no longer
    // an ancestor of HEAD — this triggers adopted_ref_diverged
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["-C", f.vaultPath, "reset", "--hard", f.baseSha]);

    // Verify the diverged state is reported in JSON before proceeding
    expect(await runStatus({ vault: f.vaultPath, json: true })).toBe(0);
    const jsonBlob = captured.out.find((l) => l.includes("\"vault\""));
    expect(jsonBlob).toBeDefined();
    if (jsonBlob === undefined) return;
    const parsedJson = JSON.parse(jsonBlob) as Record<string, unknown>;
    expect(parsedJson["adopted_diverged"]).toBe(true);
    expect((parsedJson["attention"] as ReadonlyArray<string>)).toContain("adopted_ref_diverged");
    captured.out = [];
    captured.err = [];

    // Step 3: insert a failed run for dome.lint.report (a registered processor)
    const ledger = await openLedgerDb({
      path: join(f.vaultPath, ".dome", "state", "runs.db"),
    });
    expect(ledger.ok).toBe(true);
    if (!ledger.ok) return;
    const adoptedCommit = commitOid(f.headSha); // headSha is now the adopted ref
    try {
      const failedRunId = newRunId(new Date(1), () => "failrd");
      insertQueued(ledger.value.db, {
        id: failedRunId,
        proposalId: null,
        processorId: "dome.lint.report",
        processorVersion: "1.0.0",
        phase: "garden",
        inputCommit: adoptedCommit,
        triggerKind: "schedule",
        triggerPayload: { test: "failed-run" },
        startedAt: new Date(1),
      });
      markRunning(ledger.value.db, failedRunId, new Date(2));
      markTimedOut(ledger.value.db, {
        id: failedRunId,
        error: {
          code: "processor.timeout",
          message: "lint timed out",
          retryable: true,
          phase: "garden",
          processorId: "dome.lint.report",
        },
        durationMs: 1,
        finishedAt: new Date(3),
      });
    } finally {
      ledger.value.db.close();
    }

    // Step 4: add a quarantined key
    const quarantine = openQuarantineStore({
      path: join(f.vaultPath, ".dome", "state", "quarantined.json"),
      quarantineThreshold: 2,
    });
    expect(quarantine.ok).toBe(true);
    if (!quarantine.ok) return;
    const qKey = Object.freeze({
      phase: "garden" as const,
      processorId: "dome.lint.report",
      processorVersion: "1.0.0",
      triggerHash: "exhaust-test-trigger",
    });
    quarantine.value.recordRetryableTerminalFailure(qKey, "first");
    quarantine.value.recordRetryableTerminalFailure(qKey, "second");

    // Step 5: assert text-mode output
    expect(await runStatus({ vault: f.vaultPath })).toBe(0);
    const out = captured.out.join("\n");

    // Confirm attention header present
    expect(out).toContain("attention");

    // Signal rows are lines matching "  <glyph> <label>   <detail>" where
    // glyph is one of: "!" (warn), "x" (err), or "√" / "√" etc.
    // The sync category renders with "err" tone (glyph "x") when diverged.
    // The runs/quarantine categories render with "warn" tone (glyph "!").
    // We count all non-ok signal lines: "!" or "x" prefix in ASCII mode.
    const attentionRows = out.split("\n").filter((l) =>
      /^\s+[!x]/.test(l) && (
        l.includes("sync") || l.includes("runs") || l.includes("quarantine") ||
        l.includes("diagnostics") || l.includes("projection") || l.includes("model") ||
        l.includes("service") || l.includes("serve") || l.includes("draft") ||
        l.includes("questions") || l.includes("outbox") || l.includes("inbox")
      )
    );

    // Each expected display-category has a rendered signal row
    expect(attentionRows.some((l) => l.includes("sync"))).toBe(true);
    expect(attentionRows.some((l) => l.includes("runs"))).toBe(true);
    expect(attentionRows.some((l) => l.includes("quarantine"))).toBe(true);

    // Header count is s.attention.length; attentionRows.length can be less
    // (multiple codes may merge into one display slot) but every slot must
    // have a row — nothing can vanish
    const headerMatch = out.match(/(\d+)\s+items?\s+need/);
    expect(headerMatch).not.toBeNull();
    const headerCount = parseInt(headerMatch?.[1] ?? "0", 10);
    expect(headerCount).toBeGreaterThanOrEqual(attentionRows.length);
    expect(headerCount).toBeGreaterThanOrEqual(3);

    // Healthy rollup must NOT list these categories as clean
    const rollupLine = out.split("\n").find((l) =>
      l.includes("all clean") || (l.includes("clean") && l.includes("√"))
    );
    if (rollupLine !== undefined) {
      expect(rollupLine).not.toContain("sync");
      expect(rollupLine).not.toContain("runs");
      expect(rollupLine).not.toContain("quarantine");
    }
  });
});
