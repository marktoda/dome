// Recurring-failure findings (v1 chunk 11, Task 3).
//
// Three root-cause-shaped findings that turn "ask once per failed row, forever"
// + "silent serve.log timeout loop" into ONE actionable finding, rendered on
// the dome doctor / dome check findings surface rather than minting more
// minute-cadence questions:
//
//   - `outbox.recurring-failure` (error): a failed outbox row that has been in
//     the failed state well beyond its retry budget — a fetcher/command loop
//     that keeps re-failing on re-emit, distinct from a fresh transient blip
//     (which stays the normal per-row `outbox.failed` retry question).
//   - `questions.unreadable-backlog` (warning): N question rows can't be
//     rehydrated (older-build/poison rows skipped by the failure-isolating
//     read) → rebuild to repair.
//   - `run.recurring-timeout` (warning): one processor's runs repeatedly hit
//     `timed_out` → raise its timeout or scope it, instead of a silent loop.

import { describe, expect, test } from "bun:test";

import {
  recurringOutboxFailureFindings,
  unreadableQuestionBacklogFindings,
  recurringTimeoutFindings,
  DEFAULT_RECURRING_OUTBOX_FAILURE_THRESHOLD_MS,
  DEFAULT_RECURRING_TIMEOUT_THRESHOLD,
} from "../../src/engine/host/health";
import type { OutboxRow } from "../../src/outbox/dispatch";
import type { RunSummaryRow } from "../../src/ledger/runs";

const NOW = new Date("2026-06-14T12:00:00.000Z");

function failedRow(over: Partial<OutboxRow>): OutboxRow {
  return Object.freeze({
    id: 1,
    capability: "sources.fetch",
    idempotencyKey: "dome.sources.fetch:calendar:2026-06-14",
    payload: {},
    sourceRefs: Object.freeze([]),
    status: "failed",
    externalId: null,
    attempts: 3,
    maxAttempts: 3,
    enqueuedAt: NOW.toISOString(),
    nextAttemptAt: NOW.toISOString(),
    sentAt: null,
    lastError: "fetch command exited 1",
    runId: "run-1",
    ...over,
  }) as OutboxRow;
}

describe("outbox.recurring-failure", () => {
  test("fires once for a failed row whose enqueue age exceeds the recurrence window", () => {
    const oldEnqueue = new Date(
      NOW.getTime() - DEFAULT_RECURRING_OUTBOX_FAILURE_THRESHOLD_MS - 60_000,
    ).toISOString();
    const findings = recurringOutboxFailureFindings({
      failedOutbox: [failedRow({ enqueuedAt: oldEnqueue })],
      now: NOW,
    });
    expect(findings.length).toBe(1);
    const finding = findings[0];
    expect(finding?.code).toBe("outbox.recurring-failure");
    expect(finding?.severity).toBe("error");
    // The root-cause framing: fix the command, not retry-or-abandon.
    expect(finding?.message.toLowerCase()).toContain("every");
  });

  test("a fresh transient failure does not fire (stays the normal retry question)", () => {
    const findings = recurringOutboxFailureFindings({
      failedOutbox: [failedRow({ enqueuedAt: NOW.toISOString() })],
      now: NOW,
    });
    expect(findings.length).toBe(0);
  });

  test("no failed rows → no finding", () => {
    expect(
      recurringOutboxFailureFindings({ failedOutbox: [], now: NOW }).length,
    ).toBe(0);
  });
});

describe("questions.unreadable-backlog", () => {
  test("fires when the unrehydratable count is > 0", () => {
    const findings = unreadableQuestionBacklogFindings({
      unrehydratableCount: 3,
    });
    expect(findings.length).toBe(1);
    expect(findings[0]?.code).toBe("questions.unreadable-backlog");
    expect(findings[0]?.severity).toBe("warning");
    expect(findings[0]?.message).toContain("3");
    expect(findings[0]?.recovery.toLowerCase()).toContain("rebuild");
  });

  test("does not fire when the count is 0", () => {
    expect(
      unreadableQuestionBacklogFindings({ unrehydratableCount: 0 }).length,
    ).toBe(0);
  });
});

function timedOutRun(processorId: string): RunSummaryRow {
  return {
    id: `run-${Math.random()}`,
    processorId,
    processorVersion: "0.1.2",
    phase: "adoption",
    status: "timed_out",
    durationMs: 30_000,
    error: "Processor exceeded timeout of 30000ms.",
    triggerKind: "signal",
    startedAt: NOW.toISOString(),
    finishedAt: NOW.toISOString(),
  } as RunSummaryRow;
}

describe("run.recurring-timeout", () => {
  test("fires once per processor when timeouts reach the threshold", () => {
    const runs = Array.from(
      { length: DEFAULT_RECURRING_TIMEOUT_THRESHOLD },
      () => timedOutRun("dome.markdown.duplicate-detection"),
    );
    const findings = recurringTimeoutFindings({ recentTimedOutRuns: runs });
    expect(findings.length).toBe(1);
    expect(findings[0]?.code).toBe("run.recurring-timeout");
    expect(findings[0]?.severity).toBe("warning");
    expect(findings[0]?.message).toContain("dome.markdown.duplicate-detection");
  });

  test("a single timeout does not fire (below threshold)", () => {
    const findings = recurringTimeoutFindings({
      recentTimedOutRuns: [timedOutRun("dome.markdown.duplicate-detection")],
    });
    expect(findings.length).toBe(0);
  });

  test("groups by processor: two processors each over threshold → two findings", () => {
    const runs = [
      ...Array.from({ length: DEFAULT_RECURRING_TIMEOUT_THRESHOLD }, () =>
        timedOutRun("a.b.c"),
      ),
      ...Array.from({ length: DEFAULT_RECURRING_TIMEOUT_THRESHOLD }, () =>
        timedOutRun("d.e.f"),
      ),
    ];
    const findings = recurringTimeoutFindings({ recentTimedOutRuns: runs });
    expect(findings.length).toBe(2);
    expect(findings.map((f) => f.id).sort()).toEqual(["a.b.c", "d.e.f"]);
  });
});
