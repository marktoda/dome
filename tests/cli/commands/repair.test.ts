import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { commitOid } from "../../../src/core/source-ref";
import {
  runRepair,
  taskAnchorRepairPlan,
} from "../../../src/cli/commands/repair";
import { recordCapabilityUse } from "../../../src/ledger/capability-uses";
import { openLedgerDb, type LedgerDb } from "../../../src/ledger/db";
import {
  insertQueued,
  markFailed,
  markRunning,
  markSkipped,
  markSucceeded,
  newRunId,
  queryRuns,
  type RunId,
} from "../../../src/ledger/runs";

const tmpDirs: string[] = [];

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

describe("dome repair task-anchors", () => {
  test("plans removal from every collided occurrence so restamping converges", () => {
    const plan = taskAnchorRepairPlan([
      {
        path: "wiki/projects/a.md",
        content: "- [ ] first task ^tdeadbeef\n",
      },
      {
        path: "wiki/projects/b.md",
        content: "- [ ] second task ^tdeadbeef\n",
      },
    ]);

    expect(plan.collisions.map((collision) => collision.anchor)).toEqual([
      "tdeadbeef",
    ]);
    expect(plan.changes).toEqual([
      {
        path: "wiki/projects/a.md",
        line: 1,
        anchor: "tdeadbeef",
        action: "remove-duplicate-anchor",
        before: "- [ ] first task ^tdeadbeef",
        after: "- [ ] first task",
      },
      {
        path: "wiki/projects/b.md",
        line: 1,
        anchor: "tdeadbeef",
        action: "remove-duplicate-anchor",
        before: "- [ ] second task ^tdeadbeef",
        after: "- [ ] second task",
      },
    ]);
  });

  test("--apply clears every collided identity for deterministic restamping", async () => {
    const vault = mkdtempSync(join(tmpdir(), "dome-repair-task-anchors-"));
    tmpDirs.push(vault);
    await mkdir(join(vault, "wiki", "projects"), { recursive: true });
    await writeFile(
      join(vault, "wiki", "projects", "a.md"),
      "- [ ] first task ^tdeadbeef\n",
      "utf8",
    );
    await writeFile(
      join(vault, "wiki", "projects", "b.md"),
      "- [ ] second task ^tdeadbeef\n",
      "utf8",
    );

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (value?: unknown): void => {
      logs.push(String(value ?? ""));
    };
    try {
      expect(
        await runRepair({
          subject: "task-anchors",
          vault,
          apply: true,
          json: true,
        }),
      ).toBe(0);
    } finally {
      console.log = originalLog;
    }

    expect(logs.join("\n")).toContain('"status": "applied"');
    await expect(
      readFile(join(vault, "wiki", "projects", "a.md"), "utf8"),
    ).resolves.toBe("- [ ] first task\n");
    await expect(
      readFile(join(vault, "wiki", "projects", "b.md"), "utf8"),
    ).resolves.toBe("- [ ] second task\n");
  });
});

describe("dome repair run-ledger", () => {
  test("dry-run reports only old low-signal terminal rows", async () => {
    const vault = mkdtempSync(join(tmpdir(), "dome-repair-run-ledger-"));
    tmpDirs.push(vault);
    const ledger = await openTestLedger(vault);
    try {
      const oldSucceeded = seedSucceededRun(ledger, {
        suffix: "oldsuc",
        startedAt: new Date("2020-01-01T00:00:00.000Z"),
        costUsd: 1.25,
      });
      seedSkippedRun(ledger, {
        suffix: "oldskp",
        startedAt: new Date("2020-01-02T00:00:00.000Z"),
      });
      seedSkippedRun(ledger, {
        suffix: "skperr",
        startedAt: new Date("2020-01-03T00:00:00.000Z"),
        error: "policy denied",
      });
      seedFailedRun(ledger, {
        suffix: "oldfail",
        startedAt: new Date("2020-01-04T00:00:00.000Z"),
      });
      seedRunningRun(ledger, {
        suffix: "oldrun",
        startedAt: new Date("2020-01-05T00:00:00.000Z"),
      });
      seedSucceededRun(ledger, {
        suffix: "recent",
        startedAt: new Date(),
        costUsd: null,
      });
      recordCapabilityUse(ledger, {
        runId: oldSucceeded,
        capability: "patch.auto",
        resource: "wiki/a.md",
        outcome: "allowed",
        recordedAt: new Date("2020-01-01T00:00:01.000Z"),
      });
      // Supersession guards (RETENTION_ELIGIBLE_RUN_WHERE_SQL) require a
      // newer same-processor (schedule-triggered) run to exist before an
      // old succeeded/skipped run is eligible — without these, oldSucceeded
      // and oldSkipped would be their processors' only/newest run and stay
      // ineligible. A non-terminal placeholder is enough: it supersedes
      // without itself affecting cost/status-count assertions.
      seedRunningRun(ledger, {
        suffix: "oldsuc-newer",
        processorId: "test.oldsuc",
        startedAt: new Date(),
      });
      seedRunningRun(ledger, {
        suffix: "oldskp-newer",
        processorId: "test.oldskp",
        startedAt: new Date(),
      });
    } finally {
      ledger.close();
    }

    const { code, json } = await captureJson(() =>
      runRepair({
        subject: "run-ledger",
        vault,
        olderThanDays: 30,
        json: true,
      }),
    );

    expect(code).toBe(0);
    expect(json["status"]).toBe("planned");
    expect(json["eligibleRuns"]).toBe(2);
    expect(json["eligibleCapabilityUses"]).toBe(1);
    expect(json["eligibleCostUsd"]).toBe(1.25);
    expect(json["statusCounts"]).toEqual([
      { status: "skipped", runs: 1 },
      { status: "succeeded", runs: 1 },
    ]);

    const after = await openTestLedger(vault);
    try {
      expect(queryRuns(after).length).toBe(8);
    } finally {
      after.close();
    }
  });

  test("--apply prunes eligible runs and capability-use children", async () => {
    const vault = mkdtempSync(join(tmpdir(), "dome-repair-run-ledger-"));
    tmpDirs.push(vault);
    const ledger = await openTestLedger(vault);
    try {
      const oldSucceeded = seedSucceededRun(ledger, {
        suffix: "oldsuc",
        startedAt: new Date("2020-01-01T00:00:00.000Z"),
        costUsd: null,
      });
      seedFailedRun(ledger, {
        suffix: "oldfail",
        startedAt: new Date("2020-01-02T00:00:00.000Z"),
      });
      recordCapabilityUse(ledger, {
        runId: oldSucceeded,
        capability: "patch.auto",
        resource: "wiki/a.md",
        outcome: "allowed",
        recordedAt: new Date("2020-01-01T00:00:01.000Z"),
      });
      // See the dry-run test above: a newer same-processor run must exist
      // for oldSucceeded to clear the supersession guard.
      seedRunningRun(ledger, {
        suffix: "oldsuc-newer",
        processorId: "test.oldsuc",
        startedAt: new Date(),
      });
    } finally {
      ledger.close();
    }

    const { code, json } = await captureJson(() =>
      runRepair({
        subject: "run-ledger",
        vault,
        olderThanDays: 30,
        apply: true,
        json: true,
      }),
    );

    expect(code).toBe(0);
    expect(json["status"]).toBe("applied");
    expect(json["prunedRuns"]).toBe(1);
    expect(json["prunedCapabilityUses"]).toBe(1);

    const after = await openTestLedger(vault);
    try {
      const runs = queryRuns(after);
      expect(runs.map((run) => run.status)).toEqual(["running", "failed"]);
      const capUseCount = after.raw
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM capability_uses",
        )
        .get()?.count;
      expect(capUseCount).toBe(0);
    } finally {
      after.close();
    }
  });
});

async function openTestLedger(vault: string): Promise<LedgerDb> {
  const result = await openLedgerDb({
    path: join(vault, ".dome", "state", "runs.db"),
  });
  if (!result.ok) throw new Error(`ledger open failed: ${result.error.kind}`);
  return result.value.db;
}

const INPUT_COMMIT = commitOid("a".repeat(40));

function seedQueuedRun(
  db: LedgerDb,
  opts: {
    readonly suffix: string;
    readonly startedAt: Date;
    // Defaults to `test.${suffix}`; pass explicitly to place a second run
    // under the same processor (e.g. a newer run that supersedes an older
    // one for the retention-eligibility guards).
    readonly processorId?: string;
  },
): RunId {
  const id = newRunId(opts.startedAt, () => opts.suffix);
  insertQueued(db, {
    id,
    proposalId: null,
    processorId: opts.processorId ?? `test.${opts.suffix}`,
    processorVersion: "0.0.1",
    phase: "garden",
    inputCommit: INPUT_COMMIT,
    triggerKind: "schedule",
    triggerPayload: { test: true },
    startedAt: opts.startedAt,
  });
  return id;
}

function seedRunningRun(
  db: LedgerDb,
  opts: {
    readonly suffix: string;
    readonly startedAt: Date;
    readonly processorId?: string;
  },
): RunId {
  const id = seedQueuedRun(db, opts);
  markRunning(db, id, new Date(opts.startedAt.getTime() + 1));
  return id;
}

function seedSucceededRun(
  db: LedgerDb,
  opts: {
    readonly suffix: string;
    readonly startedAt: Date;
    readonly costUsd: number | null;
    readonly processorId?: string;
  },
): RunId {
  const id = seedRunningRun(db, opts);
  markSucceeded(db, {
    id,
    effectHashes: [],
    costUsd: opts.costUsd,
    durationMs: 10,
    outputCommit: null,
    finishedAt: new Date(opts.startedAt.getTime() + 10),
  });
  return id;
}

function seedSkippedRun(
  db: LedgerDb,
  opts: {
    readonly suffix: string;
    readonly startedAt: Date;
    readonly error?: string;
    readonly processorId?: string;
  },
): RunId {
  const id = seedQueuedRun(db, opts);
  markSkipped(db, {
    id,
    finishedAt: new Date(opts.startedAt.getTime() + 10),
    ...(opts.error !== undefined ? { error: opts.error } : {}),
  });
  return id;
}

function seedFailedRun(
  db: LedgerDb,
  opts: {
    readonly suffix: string;
    readonly startedAt: Date;
    readonly processorId?: string;
  },
): RunId {
  const id = seedRunningRun(db, opts);
  markFailed(db, {
    id,
    error: "test failure",
    durationMs: 10,
    finishedAt: new Date(opts.startedAt.getTime() + 10),
  });
  return id;
}

async function captureJson(
  fn: () => Promise<number>,
): Promise<{ readonly code: number; readonly json: Record<string, unknown> }> {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (value?: unknown): void => {
    logs.push(String(value ?? ""));
  };
  try {
    const code = await fn();
    const first = logs[0];
    if (first === undefined) throw new Error("expected JSON output");
    return { code, json: JSON.parse(first) as Record<string, unknown> };
  } finally {
    console.log = originalLog;
  }
}
