import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runHomeLifecycle } from "../../src/cli/commands/home-lifecycle";
import type { HomeLifecycleDeps } from "../../src/product-host/home-lifecycle";

let logs: string[] = [];
let errors: string[] = [];
const originalLog = console.log;
const originalError = console.error;
const roots: string[] = [];

beforeEach(() => {
  logs = [];
  errors = [];
  console.log = (...parts: unknown[]) => logs.push(parts.map(String).join(" "));
  console.error = (...parts: unknown[]) => errors.push(parts.map(String).join(" "));
});

afterEach(async () => {
  console.log = originalLog;
  console.error = originalError;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function deps(): HomeLifecycleDeps {
  const root = mkdtempSync(join(tmpdir(), "dome-home-command-"));
  roots.push(root);
  return {
    platform: "darwin",
    uid: 501,
    launchAgentsDir: join(root, "agents"),
    launchctl: async () => ({ exitCode: 113, stdout: "", stderr: "not found" }),
    legacyServeRunning: async () => false,
    readiness: async () => false,
    drainTimeoutMs: 1,
  };
}

test("lifecycle CLI JSON preserves schema and absent start maps to usage", async () => {
  const d = deps();
  expect(await runHomeLifecycle("status", { vault: "/tmp/source-vault", json: true }, d)).toBe(0);
  const status = JSON.parse(logs.at(-1) ?? "{}") as Record<string, unknown>;
  expect(status["schema"]).toBe("dome.home.lifecycle/v1");
  expect(status["status"]).toBe("not-installed");
  expect(status["program"]).toBeString();

  logs = [];
  expect(await runHomeLifecycle("start", { vault: "/tmp/source-vault", json: true }, d)).toBe(64);
  const start = JSON.parse(logs.at(-1) ?? "{}") as Record<string, unknown>;
  expect(start["status"]).toBe("error");
  expect(start["exitCode"]).toBe(64);
});

test("lifecycle CLI rejects malformed install env before launchd", async () => {
  let calls = 0;
  const d = { ...deps(), launchctl: async () => {
    calls += 1;
    return { exitCode: 113, stdout: "", stderr: "not found" };
  } };
  expect(await runHomeLifecycle("install", { vault: "/tmp/source-vault", env: ["NO_PAIR"] }, d)).toBe(64);
  expect(errors.join("\n")).toContain("KEY=VALUE");
  expect(calls).toBe(0);
});
