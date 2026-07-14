import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../../src/cli/index";

const originalCwd = process.cwd();
const originalLog = console.log;
const originalError = console.error;
let roots: string[] = [];
let output: string[] = [];

beforeEach(() => {
  roots = [];
  output = [];
  console.log = (...parts: unknown[]) => output.push(parts.map(String).join(" "));
  console.error = (...parts: unknown[]) => output.push(parts.map(String).join(" "));
});

afterEach(() => {
  process.chdir(originalCwd);
  console.log = originalLog;
  console.error = originalError;
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("nested Home status forwards either position of the shared vault option", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dome-home-nested-options-")));
  roots.push(root);
  const vault = join(root, "vault");
  expect(await runCli(["init", vault, "--json"])).toBe(0);
  output = [];
  process.chdir(root);

  for (const args of [
    ["home", "status", "--vault", vault, "--json"],
    ["home", "--vault", vault, "status", "--json"],
  ]) {
    output = [];
    expect(await runCli(args)).toBe(0);
    const result = resultJson<{ readonly vault?: string; readonly status?: string }>();
    expect(result.vault).toBe(realpathSync(vault));
    expect(result.status).toBe("not-installed");
  }
});

test("nested Home install forwards vault and local options without mutating an invalid target", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dome-home-install-options-")));
  roots.push(root);
  const notVault = join(root, "not-vault");
  mkdirSync(notVault);
  process.chdir(root);

  for (const args of [
    ["home", "install", "--vault", notVault, "--env", "DOME_TEST=value", "--json"],
    ["home", "--vault", notVault, "install", "--env", "DOME_TEST=value", "--json"],
  ]) {
    output = [];
    expect(await runCli(args)).toBe(64);
    const result = resultJson<{ readonly action?: string; readonly vault?: string; readonly status?: string }>();
    expect(result).toMatchObject({ action: "install", vault: realpathSync(notVault), status: "error" });
  }
  expect(existsSync(join(notVault, ".dome"))).toBeFalse();
});

test("nested Home upgrade forwards the explicit vault before its non-artifact preflight", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dome-home-upgrade-options-")));
  roots.push(root);
  const notVault = join(root, "not-vault");
  mkdirSync(notVault);
  process.chdir(root);

  for (const args of [
    ["home", "upgrade", "--vault", notVault, "--json"],
    ["home", "--vault", notVault, "upgrade", "--json"],
  ]) {
    output = [];
    expect(await runCli(args)).toBe(64);
    const result = resultJson<{ readonly operation?: string; readonly vault?: string; readonly reason?: string }>();
    expect(result).toMatchObject({
      operation: "upgrade",
      vault: realpathSync(notVault),
      reason: "preflight-failed",
    });
  }
  expect(existsSync(join(notVault, ".dome"))).toBeFalse();
});

function resultJson<Result>(): Result {
  return JSON.parse(output.at(-1) ?? "{}") as Result;
}
