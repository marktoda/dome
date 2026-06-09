// scenarios/cli-surface/doctor-health.scenario.test.ts
//
// `dome doctor` is the read-only recovery dashboard for operational substrate
// failures. This scenario proves the CLI sees real persisted engine state
// rather than a mocked report: failed outbox rows, orphan running rows, and
// persisted processor quarantines.

import { expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { externalActionEffect } from "../../../../src/core/effect";
import { sourceRef } from "../../../../src/core/source-ref";
import { openQuarantineStore } from "../../../../src/engine/quarantine-store";
import {
  insertQueued,
  markRunning,
  newRunId,
} from "../../../../src/ledger/runs";
import {
  insertPending,
  markFailed as markOutboxFailed,
} from "../../../../src/outbox/dispatch";
import { scenario } from "../../index";

scenario(
  {
    name: "cli-surface: dome doctor reports operational health findings",
    tags: [{ kind: "group", group: "cli-surface" }],
  },
  async (h) => {
    const head = await h.refs.head();
    const ref = sourceRef({
      commit: head,
      path: ".dome/.gitkeep",
    });

    insertPending(h.outbox, {
      effect: externalActionEffect({
        capability: "calendar.write",
        idempotencyKey: "doctor-scenario-failed",
        payload: { event: "failed" },
        sourceRefs: [ref],
      }),
      runId: "run-doctor-scenario-outbox",
      now: h.clock.now(),
    });
    markOutboxFailed(
      h.outbox,
      "doctor-scenario-failed",
      "terminal failure",
    );
    insertPending(h.outbox, {
      effect: externalActionEffect({
        capability: "calendar.write",
        idempotencyKey: "doctor-scenario-stuck",
        payload: { event: "stuck" },
        sourceRefs: [ref],
      }),
      runId: "run-doctor-scenario-stuck",
      now: new Date(0),
    });

    const runId = newRunId(h.clock.now(), () => "doctor");
    insertQueued(h.ledger, {
      id: runId,
      proposalId: null,
      processorId: "test.doctor",
      processorVersion: "0.0.1",
      phase: "garden",
      inputCommit: head,
      triggerKind: "schedule",
      triggerPayload: { test: true },
      startedAt: new Date(h.clock.now().getTime() - 1),
    });
    markRunning(h.ledger, runId, h.clock.now());

    const quarantine = openQuarantineStore({
      path: join(h.vaultPath, ".dome", "state", "quarantined.json"),
      quarantineThreshold: 2,
    });
    if (!quarantine.ok) {
      throw new Error(`quarantine open failed: ${quarantine.error.kind}`);
    }
    const key = Object.freeze({
      phase: "garden" as const,
      processorId: "test.doctor",
      processorVersion: "0.0.1",
      triggerHash: "doctor-scenario-trigger",
    });
    quarantine.value.recordRetryableTerminalFailure(key, "first");
    quarantine.value.recordRetryableTerminalFailure(key, "second");

    h.projection.raw
      .query(
        "UPDATE projection_meta SET extension_set_hash = ?, "
          + "processor_versions_hash = ?, capability_policy_hash = ?",
      )
      .run("stale-extension-set", "stale-processor-versions", "stale-policy");
    await writeFile(join(h.vaultPath, ".dome", "config.yaml"), "extensions: {}\n");
    await writeFile(
      join(h.vaultPath, "AGENTS.md"),
      "# This is a Dome vault.\n\n<!-- BEGIN user-prose -->\n<!-- END user-prose -->\n",
    );
    await writeFile(join(h.vaultPath, "CLAUDE.md"), "Missing AGENTS import\n");

    const doctor = await h.runCli([
      "doctor",
      "--json",
      "--orphan-threshold-ms",
      "0",
    ]);
    expect(doctor.exitCode).toBe(0);
    expect(doctor.stderr).toBe("");
    const report = JSON.parse(doctor.stdout) as {
      readonly status: string;
      readonly summary: {
        readonly failedOutbox: number;
        readonly stuckPendingOutbox: number;
        readonly orphanRuns: number;
        readonly quarantinedProcessors: number;
        readonly projectionCacheDrift: number;
        readonly instructionDrift: number;
      };
      readonly findings: ReadonlyArray<{ readonly code: string }>;
    };
    expect(report.status).toBe("unhealthy");
    expect(report.summary.failedOutbox).toBe(1);
    expect(report.summary.stuckPendingOutbox).toBe(1);
    expect(report.summary.orphanRuns).toBe(1);
    expect(report.summary.quarantinedProcessors).toBe(1);
    expect(report.summary.projectionCacheDrift).toBe(1);
    expect(report.summary.instructionDrift).toBe(1);
    expect(report.findings.map((finding) => finding.code)).toEqual([
      "outbox.failed",
      "outbox.pending-stuck",
      "run.orphan",
      "processor.quarantined",
      "projection.cache-key-drift",
      "instructions.drift",
    ]);
  },
);

scenario(
  {
    name: "cli-surface: dome doctor reports enabled processor grant gaps",
    tags: [
      { kind: "group", group: "cli-surface" },
      { kind: "capability", capability: "patch.auto" },
      { kind: "capability", capability: "question.ask" },
    ],
    harness: {
      bundles: ["dome.markdown"],
      initialFiles: {
        ".dome/config.yaml":
          "extensions:\n" +
          "  dome.markdown:\n" +
          "    enabled: true\n" +
          "    grant:\n" +
          "      read: [\"**/*.md\"]\n",
        "AGENTS.md":
          "# This is a Dome vault.\n\n" +
          "<!-- BEGIN user-prose -->\n" +
          "<!-- END user-prose -->\n",
        "CLAUDE.md": "@AGENTS.md\n",
      },
    },
  },
  async (h) => {
    const doctor = await h.runCli(["doctor", "--json"]);
    expect(doctor.exitCode).toBe(0);
    expect(doctor.stderr).toBe("");
    const report = JSON.parse(doctor.stdout) as {
      readonly status: string;
      readonly summary: {
        readonly capabilityGrantGaps: number;
      };
      readonly findings: ReadonlyArray<{
        readonly code: string;
        readonly id: string;
        readonly capability?: {
          readonly processorId: string;
          readonly missingKinds: ReadonlyArray<string>;
        };
      }>;
    };

    expect(report.status).toBe("unhealthy");
    expect(report.summary.capabilityGrantGaps).toBe(8);

    const grantGaps = report.findings.filter(
      (finding) => finding.code === "capability.grant-missing",
    );
    expect(grantGaps.map((finding) => finding.id).sort()).toEqual([
      "dome.markdown.ambiguous-wikilink-answer",
      "dome.markdown.duplicate-detection",
      "dome.markdown.duplicate-detection-answer",
      "dome.markdown.normalize-frontmatter",
      "dome.markdown.refresh-updated",
      "dome.markdown.repair-wikilinks",
      "dome.markdown.simplify-indexes",
      "dome.markdown.validate-wikilinks",
    ]);
    expect(grantGaps).toContainEqual(
      expect.objectContaining({
        capability: {
          processorId: "dome.markdown.ambiguous-wikilink-answer",
          missingKinds: ["patch.auto"],
        },
      }),
    );
    expect(grantGaps).toContainEqual(
      expect.objectContaining({
        capability: {
          processorId: "dome.markdown.validate-wikilinks",
          missingKinds: ["patch.auto", "question.ask"],
        },
      }),
    );
    expect(grantGaps).toContainEqual(
      expect.objectContaining({
        capability: {
          processorId: "dome.markdown.normalize-frontmatter",
          missingKinds: ["patch.auto"],
        },
      }),
    );
    expect(grantGaps).toContainEqual(
      expect.objectContaining({
        capability: {
          processorId: "dome.markdown.refresh-updated",
          missingKinds: ["patch.auto"],
        },
      }),
    );
    expect(grantGaps).toContainEqual(
      expect.objectContaining({
        capability: {
          processorId: "dome.markdown.repair-wikilinks",
          missingKinds: ["patch.auto"],
        },
      }),
    );
    expect(grantGaps).toContainEqual(
      expect.objectContaining({
        capability: {
          processorId: "dome.markdown.simplify-indexes",
          missingKinds: ["patch.auto"],
        },
      }),
    );
    expect(grantGaps).toContainEqual(
      expect.objectContaining({
        capability: {
          processorId: "dome.markdown.duplicate-detection",
          missingKinds: ["question.ask"],
        },
      }),
    );
    expect(grantGaps).toContainEqual(
      expect.objectContaining({
        capability: {
          processorId: "dome.markdown.duplicate-detection-answer",
          missingKinds: ["patch.auto"],
        },
      }),
    );
  },
);

scenario(
  {
    name: "cli-surface: dome doctor reports missing model provider preflight",
    tags: [
      { kind: "group", group: "cli-surface" },
      { kind: "capability", capability: "model.invoke" },
    ],
    harness: {
      bundles: ["dome.agent"],
      initialFiles: {
        ".dome/config.yaml": [
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
        ].join("\n"),
        "AGENTS.md":
          "# This is a Dome vault.\n\n" +
          "<!-- BEGIN user-prose -->\n" +
          "<!-- END user-prose -->\n",
        "CLAUDE.md": "@AGENTS.md\n",
      },
    },
  },
  async (h) => {
    const doctor = await h.runCli(["doctor", "--json"]);
    expect(doctor.exitCode).toBe(0);
    expect(doctor.stderr).toBe("");
    const report = JSON.parse(doctor.stdout) as {
      readonly status: string;
      readonly summary: {
        readonly modelProviderMissing: number;
        readonly capabilityGrantGaps: number;
      };
      readonly findings: ReadonlyArray<{
        readonly code: string;
        readonly id: string;
        readonly model?: {
          readonly processorIds: ReadonlyArray<string>;
        };
      }>;
    };

    expect(report.status).toBe("unhealthy");
    expect(report.summary.modelProviderMissing).toBe(1);
    expect(report.summary.capabilityGrantGaps).toBe(0);
    expect(report.findings).toEqual([
      expect.objectContaining({
        code: "model.provider-missing",
        id: "model_provider",
        model: {
          processorIds: [
            "dome.agent.brief",
            "dome.agent.consolidate",
            "dome.agent.ingest",
          ],
        },
      }),
    ]);
  },
);
