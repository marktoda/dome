import { describe, expect, test } from "bun:test";

import {
  HarnessActivity,
  scheduleScenarioDeadlineDiagnostic,
  type ScenarioDeadlineTimer,
} from "./activity";

describe("scenario deadline attribution", () => {
  test("names the exact pending Harness phase without changing the deadline", () => {
    const activity = new HarnessActivity();
    const token = activity.begin("runCli(run prep)", "dispatch CLI command");
    let callback = (): void => {
      throw new Error("deadline callback was not scheduled");
    };
    let scheduledAt = 0;
    let cancelled = false;
    const messages: string[] = [];

    const cancel = scheduleScenarioDeadlineDiagnostic({
      scenarioName: "generated open loops",
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
      "[scenario deadline] generated open loops is still running at 29000ms of 30000ms; "
        + "active owner: runCli(run prep) / dispatch CLI command",
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
      scenarioName: "assertion stall",
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
      "active owner: scenario body (no Harness operation active)",
    );
  });
});
