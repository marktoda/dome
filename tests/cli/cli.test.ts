import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { runCli, ExitCode } from "../../src/cli/cli";

describe("runCli", () => {
  test("--help exits 0 (POSIX convention: explicit help is success)", async () => {
    const code = await runCli(["--help"]);
    expect(code).toBe(ExitCode.Success);
  });

  test("per-command --help works (dome init --help)", async () => {
    const code = await runCli(["init", "--help"]);
    expect(code).toBe(ExitCode.Success);
  });

  test("no args prints help (Commander surfaces it as helpDisplayed -> Success)", async () => {
    // Commander signals empty-args via the same helpDisplayed channel as --help.
    // Both exit 0 per POSIX convention.
    const code = await runCli([]);
    expect(code).toBe(ExitCode.Success);
  });

  test("init <path> initializes vault", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-cli-"));
    const target = join(base, "v");
    try {
      const code = await runCli(["init", target]);
      expect(code).toBe(ExitCode.Success);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("unknown command returns Usage exit code", async () => {
    const code = await runCli(["nonsense"]);
    expect(code).toBe(ExitCode.Usage);
  });

  test("migrate <path> dispatches to domeMigrate (no API key needed for dispatch test)", async () => {
    // Test that the command routes; the workflow itself will fail without an
    // API key/openable target, but we should reach Failure (not Usage), which
    // proves the dispatch arm is wired.
    const code = await runCli(["migrate", "/nonexistent-vault-path-xyz"]);
    expect(code).toBe(ExitCode.Failure);
  });

  test("migrate without <path> returns Usage", async () => {
    const code = await runCli(["migrate"]);
    expect(code).toBe(ExitCode.Usage);
  });

  test("lint dispatches to domeLint (fails without vault openable)", async () => {
    // cwd is the dome repo root which is NOT a vault, so lint will fail with
    // Failure, not Usage — proving the dispatch arm is wired.
    const base = await mkdtemp(join(tmpdir(), "dome-cli-"));
    const origCwd = process.cwd();
    try {
      process.chdir(base);
      const code = await runCli(["lint"]);
      expect(code).toBe(ExitCode.Failure);
    } finally {
      process.chdir(origCwd);
      await rm(base, { recursive: true, force: true });
    }
  });

  test("lint --apply <id> parses without unknownOption (commander wiring)", async () => {
    // The cwd is a fresh non-vault dir, so the inner dispatch will fail at
    // vault-open (Failure). What we're pinning here is that commander
    // accepts --apply <id> as a known option; a Usage exit would mean
    // commander rejected the flag, which would surface the regression.
    const base = await mkdtemp(join(tmpdir(), "dome-cli-apply-"));
    const origCwd = process.cwd();
    try {
      process.chdir(base);
      const code = await runCli(["lint", "--apply", "H1"]);
      expect(code).toBe(ExitCode.Failure);
    } finally {
      process.chdir(origCwd);
      await rm(base, { recursive: true, force: true });
    }
  });

  test("lint --apply <id> --apply <id2> collects multiple ids (repeatable wiring)", async () => {
    // Repeated --apply must accumulate into an array via the collector;
    // if commander dropped repeats, the option would behave like a single
    // string and the test would still parse but the contract pinned in
    // tests/cli/lint.test.ts (TC3) would catch the misbehavior. This test
    // covers the runCli surface specifically — multi-id is accepted by
    // commander, not by domeLint.
    const base = await mkdtemp(join(tmpdir(), "dome-cli-multi-"));
    const origCwd = process.cwd();
    try {
      process.chdir(base);
      const code = await runCli(["lint", "--apply", "H1", "--apply", "H2"]);
      expect(code).toBe(ExitCode.Failure);
    } finally {
      process.chdir(origCwd);
      await rm(base, { recursive: true, force: true });
    }
  });

  test("export-context <topic> dispatches; missing topic returns Usage", async () => {
    const code = await runCli(["export-context"]);
    expect(code).toBe(ExitCode.Usage);
  });

  test("doctor --rebuild-index parses the flag", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-cli-"));
    const target = join(base, "v");
    const origCwd = process.cwd();
    try {
      await runCli(["init", target]);
      process.chdir(target);
      const code = await runCli(["doctor", "--rebuild-index"]);
      expect(code).toBe(ExitCode.Success);
    } finally {
      process.chdir(origCwd);
      await rm(base, { recursive: true, force: true });
    }
  });

  test("doctor --show workflows lists the known workflow names", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-cli-"));
    const target = join(base, "v");
    const origCwd = process.cwd();
    try {
      await runCli(["init", target]);
      process.chdir(target);
      const code = await runCli(["doctor", "--show", "workflows"]);
      expect(code).toBe(ExitCode.Success);
    } finally {
      process.chdir(origCwd);
      await rm(base, { recursive: true, force: true });
    }
  });

  test("doctor --show events lists known event kinds", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-cli-"));
    const target = join(base, "v");
    const origCwd = process.cwd();
    try {
      await runCli(["init", target]);
      process.chdir(target);
      const code = await runCli(["doctor", "--show", "events"]);
      expect(code).toBe(ExitCode.Success);
    } finally {
      process.chdir(origCwd);
      await rm(base, { recursive: true, force: true });
    }
  });

  test("doctor --drain-hooks is accepted as a no-op flag in v0.5", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-cli-"));
    const target = join(base, "v");
    const origCwd = process.cwd();
    try {
      await runCli(["init", target]);
      process.chdir(target);
      const code = await runCli(["doctor", "--drain-hooks"]);
      expect(code).toBe(ExitCode.Success);
    } finally {
      process.chdir(origCwd);
      await rm(base, { recursive: true, force: true });
    }
  });

  test("doctor with unknown flag returns Usage", async () => {
    const code = await runCli(["doctor", "--no-such-flag"]);
    expect(code).toBe(ExitCode.Usage);
  });
});
