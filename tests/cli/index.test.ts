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
    const out = captured.out.join("\n");
    expect(out).toContain("Usage: dome");
    for (
      const command of [
        "init",
        "capture",
        "sync",
        "status",
        "check",
        "resolve",
        "query",
        "today",
        "log",
        "recipe",
        "export-context",
        "serve",
        "install",
        "uninstall",
      ]
    ) {
      expect(out).toContain(command);
    }
    for (
      const hiddenCommand of [
        "prep",
        "agenda",
        "inspect",
        "doctor",
        "lint",
        "answer",
        "run",
        "rebuild",
      ]
    ) {
      expect(out).not.toContain(hiddenCommand);
    }
  });

  test("subcommand -h exits 0 and does not run the command action", async () => {
    expect(await runCli(["status", "-h"])).toBe(0);
    const out = captured.out.join("\n");
    expect(out).toContain("Usage: dome status");
    expect(out).toContain("--json");
    expect(out).not.toContain("DOME status");
  });

  test("init help exposes the optional model-provider scaffold", async () => {
    expect(await runCli(["init", "-h"])).toBe(0);
    const out = captured.out.join("\n");
    expect(out).toContain("Usage: dome init");
    expect(out).toContain("--with-model-provider <provider>");
    expect(out).toContain("--json");
  });

  test("init rejects unknown model-provider scaffolds", async () => {
    expect(await runCli(["init", "--with-model-provider", "openai"])).toBe(64);
    const err = captured.err.join("\n");
    expect(err).toContain("invalid provider; expected one of: anthropic");
    expect(err).toContain("Usage: dome init");
  });

  test("init help exposes the repeatable source scaffold", async () => {
    expect(await runCli(["init", "-h"])).toBe(0);
    const out = captured.out.join("\n");
    expect(out).toContain("--with-source <kind>");
    expect(out).toContain("calendar");
    expect(out).toContain("slack");
  });

  test("init rejects unknown source kinds with the kind list", async () => {
    expect(await runCli(["init", "--with-source", "gmail"])).toBe(64);
    const err = captured.err.join("\n");
    expect(err).toContain("invalid source kind; expected one of: calendar, slack");
    expect(err).toContain("Usage: dome init");
  });

  test("compiler host help exposes quiet output mode", async () => {
    expect(await runCli(["sync", "-h"])).toBe(0);
    expect(await runCli(["serve", "-h"])).toBe(0);
    const out = captured.out.join("\n");
    expect(out).toContain("-q, --quiet");
    expect(out).toContain("--daemon");
    expect(out).toContain("--filter-processor <glob>");
    expect(out).toContain("Suppress non-error text output");
  });

  test("export-context help exposes limit and json options", async () => {
    expect(await runCli(["export-context", "-h"])).toBe(0);
    const out = captured.out.join("\n");
    expect(out).toContain("Usage: dome export-context");
    expect(out).toContain("--limit <n>");
    expect(out).toContain("--json");
  });

  test("lint help exposes fail threshold, limit, and json options", async () => {
    expect(await runCli(["lint", "-h"])).toBe(0);
    const out = captured.out.join("\n");
    expect(out).toContain("Usage: dome lint");
    expect(out).toContain("--fail-on <severity>");
    expect(out).toContain("--limit <n>");
    expect(out).toContain("--json");
  });

  test("inspect help names every shipped subject", async () => {
    expect(await runCli(["inspect", "-h"])).toBe(0);
    const out = captured.out.join("\n");
    expect(out).toContain("--model");
    expect(out).toContain("--predicate <predicate>");
    expect(out).toContain("--subject-kind <kind>");
    expect(out).toContain("--subject-id <id>");
    for (
      const subject of [
        "bundles",
        "processors",
        "runs",
        "patches",
        "facts",
        "diagnostics",
        "questions",
        "outbox",
        "quarantine",
      ]
    ) {
      expect(out).toContain(subject);
    }
  });

  test("unknown command exits 64 with Commander usage", async () => {
    expect(await runCli(["bogus"])).toBe(64);
    const err = captured.err.join("\n");
    expect(err).toContain("unknown command");
    expect(err).toContain("Usage: dome");
  });

  test("retired submit and reconcile commands point to sync", async () => {
    expect(await runCli(["submit"])).toBe(64);
    expect(await runCli(["reconcile"])).toBe(64);
    const err = captured.err.join("\n");
    expect(err).toContain("dome submit: retired. Use `dome sync` instead.");
    expect(err).toContain("dome reconcile: retired. Use `dome sync` instead.");
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
    expect(await runCli(["lint", "--fail-on", "oops"])).toBe(64);
    expect(await runCli(["inspect", "runs", "--limit", "0"])).toBe(64);
    expect(await runCli(["doctor", "--orphan-threshold-ms", "-1"])).toBe(64);
    expect(await runCli(["serve", "--poll-interval-ms", "500x"])).toBe(64);
    const err = captured.err.join("\n");
    expect(err).toContain("option '--limit <n>' argument '10x' is invalid");
    expect(err).toContain("option '--limit <n>' argument 'x' is invalid");
    expect(err).toContain("invalid lint severity 'oops'");
    expect(err).toContain("option '--limit <n>' argument '0' is invalid");
    expect(err).toContain(
      "option '--orphan-threshold-ms <n>' argument '-1' is invalid",
    );
    expect(err).toContain(
      "option '--poll-interval-ms <n>' argument '500x' is invalid",
    );
  });

  test("quiet and verbose are mutually exclusive compiler output modes", async () => {
    expect(await runCli(["sync", "--quiet", "--verbose"])).toBe(64);
    expect(await runCli(["serve", "--quiet", "--verbose"])).toBe(64);
    const err = captured.err.join("\n");
    expect(err).toContain("option '-q, --quiet' cannot be used with option '-v, --verbose'");
  });

  test("missing command exits 64 with top-level usage", async () => {
    expect(await runCli([])).toBe(64);
    expect(captured.err.join("\n")).toContain("Usage: dome");
  });
});
