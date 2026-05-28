// Phase 9 — unit tests for the hand-rolled argv parser.
//
// Covers the shape table documented in `src/cli/args.ts`:
//   - bare command
//   - command + positionals
//   - --flag (boolean)
//   - --flag=value (single-token)
//   - --flag value (separate-token)
//   - mixed flag forms
//   - empty argv

import { describe, expect, test } from "bun:test";

import { parseArgs } from "../../src/cli/args";

describe("parseArgs", () => {
  test("returns empty defaults for empty argv", () => {
    const a = parseArgs([]);
    expect(a.command).toBe("");
    expect(a.positionals).toEqual([]);
    expect(a.flags).toEqual({});
  });

  test("parses a bare command", () => {
    const a = parseArgs(["init"]);
    expect(a.command).toBe("init");
    expect(a.positionals).toEqual([]);
    expect(a.flags).toEqual({});
  });

  test("parses command + positionals", () => {
    const a = parseArgs(["init", "/tmp/v"]);
    expect(a.command).toBe("init");
    expect(a.positionals).toEqual(["/tmp/v"]);
  });

  test("parses boolean flag (--flag) at end of args", () => {
    const a = parseArgs(["status", "--json"]);
    expect(a.command).toBe("status");
    expect(a.flags["json"]).toBe(true);
  });

  test("parses --flag=value form", () => {
    const a = parseArgs(["serve", "--poll-interval-ms=500"]);
    expect(a.command).toBe("serve");
    expect(a.flags["poll-interval-ms"]).toBe("500");
  });

  test("parses --flag value form (separate tokens)", () => {
    const a = parseArgs(["serve", "--poll-interval-ms", "500"]);
    expect(a.command).toBe("serve");
    expect(a.flags["poll-interval-ms"]).toBe("500");
  });

  test("treats --flag --other as two boolean flags", () => {
    const a = parseArgs(["status", "--json", "--verbose"]);
    expect(a.flags["json"]).toBe(true);
    expect(a.flags["verbose"]).toBe(true);
  });

  test("preserves mixed positional + flag order in flags", () => {
    const a = parseArgs([
      "inspect",
      "diagnostics",
      "--limit",
      "5",
      "--json",
    ]);
    expect(a.command).toBe("inspect");
    expect(a.positionals).toEqual(["diagnostics"]);
    expect(a.flags["limit"]).toBe("5");
    expect(a.flags["json"]).toBe(true);
  });
});
