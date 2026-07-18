import { describe, expect, test } from "bun:test";

import {
  HarnessActivity,
  scheduleScenarioDeadlineDiagnostic,
  type ScenarioDeadlineTimer,
} from "./activity";
import { HarnessImpl } from "./harness";

describe("scenario deadline attribution", () => {
  test("clears the owner when a tracked operation rejects and is caught", async () => {
    const harness = await HarnessImpl.create();
    try {
      const rejection = harness.userCommit({
        files: { ".": "cannot replace the vault directory" },
        message: "private commit subject\r\nCOMMIT_SECRET",
      });

      await expect(rejection).rejects.toThrow();
      expect(harness.deadlineActivity()).toBeNull();
    } finally {
      await harness.cleanup();
      expect(harness.deadlineActivity()).toBeNull();
    }
  });

  test("names the exact pending Harness phase without changing the deadline", () => {
    const activity = new HarnessActivity();
    const token = activity.begin("runCli", "dispatch CLI command");
    let callback = (): void => {
      throw new Error("deadline callback was not scheduled");
    };
    let scheduledAt = 0;
    let cancelled = false;
    const messages: string[] = [];

    const cancel = scheduleScenarioDeadlineDiagnostic({
      timeoutMs: 30_000,
      activity: () => activity.snapshot(),
      write: (message) => messages.push(message),
      schedule: (scheduled, milliseconds) => {
        callback = scheduled;
        scheduledAt = milliseconds;
        return 1 as unknown as ScenarioDeadlineTimer;
      },
      cancel: () => {
        cancelled = true;
      },
    });

    expect(scheduledAt).toBe(29_000);
    callback();
    expect(messages).toEqual([
      "[scenario deadline] scenario is still running at 29000ms of 30000ms; "
        + "active owner: runCli / dispatch CLI command",
    ]);

    activity.end(token);
    cancel();
    expect(cancelled).toBe(true);
  });

  test("labels work outside a Harness operation as scenario-body ownership", () => {
    let callback = (): void => {
      throw new Error("deadline callback was not scheduled");
    };
    const messages: string[] = [];
    scheduleScenarioDeadlineDiagnostic({
      timeoutMs: 100,
      activity: () => null,
      write: (message) => messages.push(message),
      schedule: (scheduled) => {
        callback = scheduled;
        return 1 as unknown as ScenarioDeadlineTimer;
      },
    });

    callback();
    expect(messages[0]).toEndWith(
      "active owner: scenario body (no instrumented Harness operation active)",
    );
  });

  test("never writes caller-controlled labels to the diagnostic stream", () => {
    const sentinel = "private query text\r\nCAPTURE_SECRET";
    let callback = (): void => {
      throw new Error("deadline callback was not scheduled");
    };
    const messages: string[] = [];
    scheduleScenarioDeadlineDiagnostic({
      timeoutMs: 100,
      activity: () => ({
        operation: `runCli ${sentinel}`,
        phase: `dispatch CLI command ${sentinel}`,
      }),
      write: (message) => messages.push(message),
      schedule: (scheduled) => {
        callback = scheduled;
        return 1 as unknown as ScenarioDeadlineTimer;
      },
    });

    callback();
    expect(messages).toEqual([
      "[scenario deadline] scenario is still running at 90ms of 100ms; "
        + "active owner: unrecognized instrumented Harness operation",
    ]);
    expect(messages[0]).not.toContain(sentinel);
    expect(messages[0]).not.toContain("\n");
    expect(messages[0]).not.toContain("\r");
  });
});
