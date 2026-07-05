// `dome check` — end-to-end tests (split from tests/cli/commands.test.ts; shared setup lives in ./fixture.ts).

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";

import { runCheck } from "../../../src/cli/commands/check";

import {
  diagnosticEffect,
  questionEffect,
} from "../../../src/core/effect";
import { commitOid, sourceRef } from "../../../src/core/source-ref";
import { openLedgerDb } from "../../../src/ledger/db";
import {
  insertQueued,
  markRunning,
  markTimedOut,
  newRunId,
} from "../../../src/ledger/runs";
import { openProjectionDb } from "../../../src/projections/db";
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
  seedUnhealthyOperationalState,
  writeDoctorConfig,
  writeDoctorConfigBody,
} from "./fixture";

installConsoleCapture();
installFixtureCleanup();

// ----- runCheck --------------------------------------------------------------

describe("runCheck", () => {
  test("clean vault reports one unified ok surface", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeDoctorConfig(f);

    expect(await runCheck({ vault: f.vaultPath })).toBe(0);
    const out = captured.out.join("\n");
    expect(out).toContain("dome check");
    // verdict-first: no engine findings → "all clear"
    expect(out).toContain("all clear");
    // AT A GLANCE is verbose-only
    expect(out).not.toContain("AT A GLANCE");
    // no loops detail section by default
    expect(out).not.toContain("  LOOPS\n");
  });

  test("--loops prints maintenance-loop detail rows", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeDoctorConfig(f);

    expect(await runCheck({ vault: f.vaultPath, loops: true })).toBe(0);
    const out = captured.out.join("\n");
    // loop detail rows are shown under --loops; "10 known" is AT A GLANCE (verbose-only)
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
    expect(maintenanceLoops).toHaveLength(10);
    expect(maintenanceLoops.find((loop) =>
      loop["id"] === "dome.question.continuity"
    )).toEqual(expect.objectContaining({
      question_scope: "all",
      processor_ids: expect.arrayContaining([
        "dome.health.outbox-recovery-questions",
      ]),
      optional_processor_ids: ["dome.agent.preference-promotion-answer"],
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
    // verdict: info-only diagnostics do not trigger attention → "all clear"
    expect(text).toContain("all clear");
    // content section not shown (attention_diagnostics=0, no rows to show)
    expect(text).not.toContain("  CONTENT\n");
    expect(text).not.toContain("informational diagnostic");
    // AT A GLANCE is verbose-only
    expect(text).not.toContain("AT A GLANCE");
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

  test("--json suppresses latest-failure findings for processors no longer registered", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeDoctorConfig(f); // extensions: {} — empty registry

    const ledger = await openLedgerDb({
      path: join(f.vaultPath, ".dome", "state", "runs.db"),
    });
    if (!ledger.ok) {
      throw new Error(`ledger open failed: ${ledger.error.kind}`);
    }
    try {
      // A failed run from a RETIRED processor (e.g. the old dome.intake
      // bundle): no newer run can ever supersede it, so without suppression
      // the finding holds attention_required hostage forever.
      const runId = newRunId(new Date(10), () => "chkgone");
      insertQueued(ledger.value.db, {
        id: runId,
        proposalId: null,
        processorId: "test.check.retired",
        processorVersion: "0.0.1",
        phase: "garden",
        inputCommit: commitOid(f.headSha),
        triggerKind: "schedule",
        triggerPayload: { test: "retired-run" },
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
          processorId: "test.check.retired",
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
    expect(summary["failedRuns"]).toBe(0);
    const findings = engine["findings"] as ReadonlyArray<Record<string, unknown>>;
    expect(findings.some((x) => x["code"] === "run.latest-problem")).toBe(false);
  });

  test("--json explains latest active processor failures as engine findings", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    // The processor must be REGISTERED for its latest failure to surface —
    // failures of retired/disabled processors are suppressed (see the
    // companion test below).
    await writeDoctorConfigBody(
      f,
      [
        "extensions:",
        "  dome.markdown:",
        "    enabled: true",
        "    grant:",
        // Mirror the manifest's full declared read set — a narrowed grant
        // would (deliberately) raise info-severity capability.grant-starved
        // findings, and this test pins the findings list exactly.
        '      read: ["**/*.md", "core.md", ".dome/page-types.yaml", "**/*.{png,jpg,jpeg,gif,webp,svg,avif}", "raw/**"]',
        '      patch.auto: ["**/*.md"]',
        '      graph.write: ["dome.page.*"]',
        "      question.ask: true",
        "",
      ].join("\n"),
    );

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
        processorId: "dome.markdown.validate-wikilinks",
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
          processorId: "dome.markdown.validate-wikilinks",
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
        message: expect.stringContaining("dome.markdown.validate-wikilinks"),
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
    // NEXT description for the null-command action: no "; " separator, so
    // firstClause returns the whole text minus trailing ".". The reference to
    // "dome sync --json" in the description stays (humanizeCommand only applies
    // to the command field, not the description).
    expect(text).toContain(
      "Fix the listed source markdown diagnostics, commit the changes, then run dome sync",
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
    // Default view is headerless — no CONTENT section label
    expect(text).not.toMatch(/^\s+CONTENT\s*$/m);
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
    // CONTENT section header shows bounded count (diagnosticLines output)
    expect(text).toContain("showing 2/3");
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

  test("human mode renders capability finding header with processor id, not 'config'", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    // Enable dome.markdown but omit core.md from the read grant — this
    // triggers a capability.grant-entry-missing finding for
    // dome.markdown.core-size (processorId, not "config").
    await writeDoctorConfigBody(
      f,
      [
        "extensions:",
        "  dome.markdown:",
        "    enabled: true",
        "    grant:",
        // Intentionally use wiki/**/*.md (not **/*.md) so core.md is not
        // covered — dome.markdown.core-size raises capability.grant-entry-missing
        // because the read kind is granted but the core.md entry is not covered.
        '      read: ["wiki/**/*.md", ".dome/page-types.yaml", "**/*.{png,jpg,jpeg,gif,webp,svg,avif}", "raw/**"]',
        '      patch.auto: ["**/*.md"]',
        '      graph.write: ["dome.page.*"]',
        "      question.ask: true",
        "",
      ].join("\n"),
    );

    expect(await runCheck({ vault: f.vaultPath })).toBe(0);
    const out = captured.out.join("\n");

    // The header must carry the processor id, not the literal "config"
    // subject stored in the HealthFinding. In a non-TTY env, unicode=false,
    // so the separator is ASCII "-".
    expect(out).toContain("dome.markdown.core-size");
    expect(out).not.toMatch(/capability\.grant-entry-missing\s*[-·]\s*config/);
    // The finding code must still appear
    expect(out).toContain("capability.grant-entry-missing");
  });

  test("capability finding shows terse summary by default, full message under verbose", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    // Enable dome.markdown but omit core.md from the read grant — triggers
    // capability.grant-entry-missing for dome.markdown.core-size.
    await writeDoctorConfigBody(
      f,
      [
        "extensions:",
        "  dome.markdown:",
        "    enabled: true",
        "    grant:",
        '      read: ["wiki/**/*.md", ".dome/page-types.yaml", "**/*.{png,jpg,jpeg,gif,webp,svg,avif}", "raw/**"]',
        '      patch.auto: ["**/*.md"]',
        '      graph.write: ["dome.page.*"]',
        "      question.ask: true",
        "",
      ].join("\n"),
    );

    // Default (non-verbose): terse summary shown, consequence clause hidden.
    captured.out = [];
    expect(await runCheck({ vault: f.vaultPath })).toBe(0);
    const defaultRender = captured.out.join("\n");

    expect(defaultRender).toContain("core.md");
    expect(defaultRender).not.toContain("core-memory size lint");

    // Verbose: full message shown as the "why" line (consequence clause visible).
    captured.out = [];
    expect(await runCheck({ vault: f.vaultPath, verbose: true })).toBe(0);
    const verboseRender = captured.out.join("\n");

    expect(verboseRender).toContain("core.md");
    expect(verboseRender).toContain("core-memory size");
  });

  test("--json capability finding carries both message (full) and summary (terse)", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    // Enable dome.markdown but omit core.md — triggers capability.grant-entry-missing
    // for dome.markdown.core-size with both message and summary authored.
    await writeDoctorConfigBody(
      f,
      [
        "extensions:",
        "  dome.markdown:",
        "    enabled: true",
        "    grant:",
        '      read: ["wiki/**/*.md", ".dome/page-types.yaml", "**/*.{png,jpg,jpeg,gif,webp,svg,avif}", "raw/**"]',
        '      patch.auto: ["**/*.md"]',
        '      graph.write: ["dome.page.*"]',
        "      question.ask: true",
        "",
      ].join("\n"),
    );

    expect(await runCheck({ vault: f.vaultPath, json: true })).toBe(0);
    const blob = captured.out.find((l) => l.includes("\"schema\""));
    expect(blob).toBeDefined();
    if (blob === undefined) return;
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    const engine = record(parsed["engine"]);
    const findings = engine["findings"] as ReadonlyArray<Record<string, unknown>>;
    const capFinding = findings.find(
      (x) => x["code"] === "capability.grant-entry-missing",
    );
    expect(capFinding).toBeDefined();
    if (capFinding === undefined) return;
    // message: full consequence clause present
    expect(typeof capFinding["message"]).toBe("string");
    expect(capFinding["message"] as string).toContain("core-memory size");
    // summary: terse, leads with entry, no consequence clause
    expect(typeof capFinding["summary"]).toBe("string");
    const summary = capFinding["summary"] as string;
    expect(summary).toContain("core.md");
    expect(summary).not.toContain("core-memory size");
  });

  test("human mode renders engine findings via the finding primitive", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await writeDoctorConfigBody(
      f,
      [
        "extensions:",
        "  dome.markdown:",
        "    enabled: true",
        "    grant:",
        '      read: ["**/*.md", "core.md", ".dome/page-types.yaml", "**/*.{png,jpg,jpeg,gif,webp,svg,avif}", "raw/**"]',
        '      patch.auto: ["**/*.md"]',
        '      graph.write: ["dome.page.*"]',
        "      question.ask: true",
        "",
      ].join("\n"),
    );

    const ledger = await openLedgerDb({
      path: join(f.vaultPath, ".dome", "state", "runs.db"),
    });
    if (!ledger.ok) {
      throw new Error(`ledger open failed: ${ledger.error.kind}`);
    }
    try {
      const runId = newRunId(new Date(10), () => "chkfnd");
      insertQueued(ledger.value.db, {
        id: runId,
        proposalId: null,
        processorId: "dome.markdown.validate-wikilinks",
        processorVersion: "0.0.1",
        phase: "garden",
        inputCommit: commitOid(f.headSha),
        triggerKind: "schedule",
        triggerPayload: { test: "finding-render" },
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
          processorId: "dome.markdown.validate-wikilinks",
        },
        durationMs: 10000,
        finishedAt: new Date(12),
      });
    } finally {
      ledger.value.db.close();
    }

    expect(await runCheck({ vault: f.vaultPath })).toBe(0);
    const out = captured.out.join("\n");

    // New anatomy: severity-glyph + code + sep + subject (unicode or ASCII glyphs)
    // In a non-TTY test environment caps.unicode=false so glyphs are ASCII: x and -
    expect(out).toMatch(/[x✗]\s+run\.latest-problem.*[-·].*runs/);
    // fix: label present
    expect(out).toContain("fix    ");
    // Old run-on prefix must be gone
    expect(out).not.toContain("[error]");
    expect(out).not.toContain("[warning]");
    // recovery: label must be gone
    expect(out).not.toMatch(/^\s+recovery:/m);
  });

  // ----- Task 8: verdict-first, terse default, one-line NEXT, no footer ------

  test("check NEXT is one humanized line (no --json, no run-on); no footer", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    await seedUnhealthyOperationalState(f);
    await writeDoctorConfig(f);

    expect(await runCheck({ vault: f.vaultPath })).toBe(0);
    const out = captured.out.join("\n");

    // Default view must be headerless — no NEXT or ENGINE section labels
    expect(out).not.toMatch(/^\s+NEXT\s*$/m);
    expect(out).not.toMatch(/^\s+ENGINE\s*$/m);

    // Action line must appear directly (the → pointer glyph is present)
    expect(out).toMatch(/[→>]\s+dome sync/);

    // --json must not appear in the action command line itself
    // (humanizeCommand strips it from the command; it may appear in fix: body text)
    const actionLine = out.split("\n").find((l) => /[→>]\s+dome sync/.test(l)) ?? "";
    expect(actionLine).not.toContain("--json");

    // Engine findings must appear directly (without ENGINE header)
    expect(out).toMatch(/outbox\.failed|run\.orphan|processor\.quarantined/);

    // legacy engineStatus "finding(s)" string must be gone
    expect(out).not.toContain("finding(s)");
    // no full-width rule/footer (10+ consecutive dashes or box-drawing)
    expect(out).not.toMatch(/[-─]{10,}/);
    // AT A GLANCE block must be absent in default mode
    expect(out).not.toContain("AT A GLANCE");
  });

  test("check default findings terse; verbose adds why + AT A GLANCE", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    // Trigger capability.grant-entry-missing for dome.markdown.core-size
    await writeDoctorConfigBody(
      f,
      [
        "extensions:",
        "  dome.markdown:",
        "    enabled: true",
        "    grant:",
        '      read: ["wiki/**/*.md", ".dome/page-types.yaml", "**/*.{png,jpg,jpeg,gif,webp,svg,avif}", "raw/**"]',
        '      patch.auto: ["**/*.md"]',
        '      graph.write: ["dome.page.*"]',
        "      question.ask: true",
        "",
      ].join("\n"),
    );

    // Default: terse — consequence clause ("core-memory size lint") hidden
    captured.out = [];
    expect(await runCheck({ vault: f.vaultPath })).toBe(0);
    const defaultOut = captured.out.join("\n");
    expect(defaultOut).not.toContain("core-memory size lint");
    expect(defaultOut).not.toContain("AT A GLANCE");

    // Verbose: why line shown + AT A GLANCE block present
    captured.out = [];
    expect(await runCheck({ vault: f.vaultPath, verbose: true })).toBe(0);
    const verboseOut = captured.out.join("\n");
    expect(verboseOut).toContain("core-memory size");
    expect(verboseOut).toContain("AT A GLANCE");
  });

  test("check verdict header counts problems vs notes", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    // Enable dome.markdown with restricted grant to produce 1 warning finding
    // (capability.grant-entry-missing = warning severity) — we need 3 warnings
    // + 1 info. Use seedUnhealthyOperationalState which produces run failures
    // (error-severity engine findings), then add a capability finding for info.
    // Instead, use the simplest path: capability finding is warning. We need
    // the fixture to produce exactly countable findings.
    // writeDoctorConfigBody with restricted grant → 1 warning capability finding.
    await writeDoctorConfigBody(
      f,
      [
        "extensions:",
        "  dome.markdown:",
        "    enabled: true",
        "    grant:",
        '      read: ["wiki/**/*.md", ".dome/page-types.yaml", "**/*.{png,jpg,jpeg,gif,webp,svg,avif}", "raw/**"]',
        '      patch.auto: ["**/*.md"]',
        '      graph.write: ["dome.page.*"]',
        "      question.ask: true",
        "",
      ].join("\n"),
    );

    expect(await runCheck({ vault: f.vaultPath })).toBe(0);
    const out = captured.out.join("\n");

    // At least one warning finding → problems > 0
    expect(out).toMatch(/\d+ problem/);
    // Singular form when exactly 1
    expect(out).toMatch(/1 problem\b/);
    // If there are info findings (infoCount > 0) notes appear; otherwise not
    // — for this fixture there are no info findings so "note" should not appear
    expect(out).not.toMatch(/\d+ note/);
  });
});

