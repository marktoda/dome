// Tests for the Commander-owned CLI entrypoint.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runCli } from "../../src/cli/index";

type Captured = {
  out: string[];
  err: string[];
};

let captured: Captured;
let origLog: typeof console.log;
let origErr: typeof console.error;

beforeEach(() => {
  captured = { out: [], err: [] };
  origLog = console.log;
  origErr = console.error;
  console.log = (...parts: unknown[]) => {
    captured.out.push(parts.map((p) => String(p)).join(" "));
  };
  console.error = (...parts: unknown[]) => {
    captured.err.push(parts.map((p) => String(p)).join(" "));
  };
});

afterEach(() => {
  console.log = origLog;
  console.error = origErr;
});

describe("runCli", () => {
  test("top-level --help exits 0 and prints command usage", async () => {
    expect(await runCli(["--help"])).toBe(0);
    expect(captured.out.join("\n")).toContain("Usage: dome");
    expect(captured.out.join("\n")).toContain("status");
  });

  test("subcommand -h exits 0 and does not run the command action", async () => {
    expect(await runCli(["status", "-h"])).toBe(0);
    const out = captured.out.join("\n");
    expect(out).toContain("Usage: dome status");
    expect(out).toContain("--json");
    expect(out).not.toContain("DOME status");
  });

  test("today help exposes date and json options", async () => {
    expect(await runCli(["today", "-h"])).toBe(0);
    const out = captured.out.join("\n");
    expect(out).toContain("Usage: dome today");
    expect(out).toContain("--date <YYYY-MM-DD>");
    expect(out).toContain("--json");
  });

  test("today rejects invalid dates before opening a vault", async () => {
    expect(await runCli(["today", "--date", "2026-99-99"])).toBe(64);
    expect(captured.err.join("\n")).toContain("invalid --date");
  });

  test("export-context help exposes limit and json options", async () => {
    expect(await runCli(["export-context", "-h"])).toBe(0);
    const out = captured.out.join("\n");
    expect(out).toContain("Usage: dome export-context");
    expect(out).toContain("--limit <n>");
    expect(out).toContain("--json");
  });

  test("inspect help names every shipped subject", async () => {
    expect(await runCli(["inspect", "-h"])).toBe(0);
    const out = captured.out.join("\n");
    expect(out).toContain("runs, diagnostics, questions, outbox, or quarantine");
  });

  test("unknown command exits 64 with Commander usage", async () => {
    expect(await runCli(["bogus"])).toBe(64);
    const err = captured.err.join("\n");
    expect(err).toContain("unknown command");
    expect(err).toContain("Usage: dome");
  });

  test("unknown option exits 64 before invoking the command", async () => {
    expect(await runCli(["status", "--bogus"])).toBe(64);
    const err = captured.err.join("\n");
    expect(err).toContain("unknown option '--bogus'");
    expect(err).toContain("Usage: dome status");
    expect(captured.out.join("\n")).not.toContain("DOME status");
  });

  test("numeric options are validated by Commander before actions run", async () => {
    expect(await runCli(["query", "alpha", "--limit", "10x"])).toBe(64);
    expect(await runCli(["export-context", "alpha", "--limit", "x"])).toBe(64);
    expect(await runCli(["inspect", "runs", "--limit", "0"])).toBe(64);
    expect(await runCli(["doctor", "--orphan-threshold-ms", "-1"])).toBe(64);
    expect(await runCli(["serve", "--poll-interval-ms", "500x"])).toBe(64);
    const err = captured.err.join("\n");
    expect(err).toContain("option '--limit <n>' argument '10x' is invalid");
    expect(err).toContain("option '--limit <n>' argument 'x' is invalid");
    expect(err).toContain("option '--limit <n>' argument '0' is invalid");
    expect(err).toContain(
      "option '--orphan-threshold-ms <n>' argument '-1' is invalid",
    );
    expect(err).toContain(
      "option '--poll-interval-ms <n>' argument '500x' is invalid",
    );
  });

  test("missing command exits 64 with top-level usage", async () => {
    expect(await runCli([])).toBe(64);
    expect(captured.err.join("\n")).toContain("Usage: dome");
  });
});
