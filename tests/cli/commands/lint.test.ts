// `dome lint` — usage-error tests (split from tests/cli/commands.test.ts; shared setup lives in ./fixture.ts).

import { describe, expect, test } from "bun:test";

import { runLint } from "../../../src/cli/commands/lint";


import {
  captured,
  installConsoleCapture,
} from "./fixture";

installConsoleCapture();

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
