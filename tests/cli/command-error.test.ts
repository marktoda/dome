// The agent-facing failure contract: every command invoked with `--json`
// puts a structured document on STDOUT for every outcome — including its
// vault-open failure path. Before this contract, status/check/inspect/
// doctor printed to stderr only and exited 1, so `dome status --json`
// (the AGENTS.md session-start command) returned empty stdout on the most
// common failure mode.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runStatus } from "../../src/cli/commands/status";
import { runCheck } from "../../src/cli/commands/check";
import { runInspect } from "../../src/cli/commands/inspect";
import { runDoctor } from "../../src/cli/commands/doctor";
import { COMMAND_ERROR_SCHEMA } from "../../src/cli/command-error";
import { commit, initRepo } from "../../src/git";

let capturedOut: string[];
let capturedErr: string[];
let origLog: typeof console.log;
let origErr: typeof console.error;

beforeEach(() => {
  capturedOut = [];
  capturedErr = [];
  origLog = console.log;
  origErr = console.error;
  console.log = (...parts: unknown[]) => {
    capturedOut.push(parts.map((p) => String(p)).join(" "));
  };
  console.error = (...parts: unknown[]) => {
    capturedErr.push(parts.map((p) => String(p)).join(" "));
  };
});

afterEach(() => {
  console.log = origLog;
  console.error = origErr;
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

/**
 * A git repo whose `.dome/config.yaml` is corrupt — the deterministic
 * openVaultRuntime failure (config loading is fail-loud). A missing config
 * is NOT a failure (the runtime falls back to shipped defaults), so a
 * corrupt one is the canonical wrong-state fixture for this contract.
 */
async function uninitializedVaultDir(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "dome-cmd-error-"));
  cleanups.push(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  await initRepo(dir);
  await Bun.write(join(dir, "readme.md"), "not a vault\n");
  await commit({ path: dir, message: "init\n", files: ["readme.md"] });
  await Bun.write(join(dir, ".dome", "config.yaml"), "{not: [valid yaml\n");
  return dir;
}

const COMMANDS: ReadonlyArray<{
  readonly name: string;
  readonly run: (opts: {
    vault: string;
    json: boolean;
    subject?: string;
  }) => Promise<number>;
}> = [
  { name: "status", run: (o) => runStatus(o) },
  { name: "check", run: (o) => runCheck(o) },
  { name: "inspect", run: (o) => runInspect({ ...o, subject: "runs" }) },
  { name: "doctor", run: (o) => runDoctor(o) },
];

describe("vault-open failure --json contract", () => {
  for (const command of COMMANDS) {
    test(`${command.name} --json emits a dome.command-error/v1 envelope on stdout`, async () => {
      const dir = await uninitializedVaultDir();
      const exitCode = await command.run({ vault: dir, json: true });

      expect(exitCode).toBe(1);
      expect(capturedOut.length).toBe(1);
      const payload = JSON.parse(capturedOut[0]!) as Record<string, unknown>;
      expect(payload.schema).toBe(COMMAND_ERROR_SCHEMA);
      expect(payload.status).toBe("error");
      expect(payload.command).toBe(command.name);
      expect(typeof payload.error).toBe("string");
      expect(String(payload.message)).toContain("openVaultRuntime failed");
    });

    test(`${command.name} without --json keeps the human stderr message`, async () => {
      const dir = await uninitializedVaultDir();
      const exitCode = await command.run({ vault: dir, json: false });

      expect(exitCode).toBe(1);
      expect(capturedOut).toEqual([]);
      expect(capturedErr.join("\n")).toContain("openVaultRuntime failed");
    });
  }
});
