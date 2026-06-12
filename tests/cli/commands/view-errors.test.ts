// Structured view command errors (`dome query` / `dome export-context` --json usage errors; split from tests/cli/commands.test.ts).

import { describe, expect, test } from "bun:test";

import { runExportContext } from "../../../src/cli/commands/export-context";
import { runQuery } from "../../../src/cli/commands/query";


import {
  captured,
  installConsoleCapture,
} from "./fixture";

installConsoleCapture();

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
