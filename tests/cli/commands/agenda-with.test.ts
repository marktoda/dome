// `dome agenda-with` — usage-error unit tests. Full dispatch coverage lives
// in tests/harness/scenarios/cli-surface/agenda-view.scenario.test.ts.

import { describe, expect, test } from "bun:test";

import { runAgendaWith } from "../../../src/cli/commands/agenda-with";

import { captured, installConsoleCapture } from "./fixture";

installConsoleCapture();

describe("runAgendaWith", () => {
  test("missing topic returns 64 before opening the runtime", async () => {
    expect(await runAgendaWith({})).toBe(64);
    expect(captured.err.join("\n")).toContain(
      "dome agenda-with: missing person or topic",
    );
  });

  test("whitespace-only topic is treated as missing", async () => {
    expect(await runAgendaWith({ topic: "   " })).toBe(64);
  });

  test("--json usage errors emit structured JSON", async () => {
    expect(await runAgendaWith({ json: true })).toBe(64);
    const payload = JSON.parse(captured.out.join("\n")) as {
      readonly status: string;
      readonly error: string;
    };
    expect(payload).toMatchObject({
      status: "error",
      error: "agenda-with-usage",
    });
    expect(captured.err).toEqual([]);
  });
});
