import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runHomeCleanup } from "../../src/cli/commands/home-cleanup";
import { runCli } from "../../src/cli/index";
import type { HomeReleaseCleanupResult } from "../../src/product-host/managed-release-gc";

const ARTIFACT = "b".repeat(64);
const originalLog = console.log;
const originalError = console.error;
const originalCwd = process.cwd();
const roots: string[] = [];
let logs: string[] = [];
let errors: string[] = [];

beforeEach(() => {
  logs = [];
  errors = [];
  console.log = (...parts: unknown[]) => logs.push(parts.map(String).join(" "));
  console.error = (...parts: unknown[]) => errors.push(parts.map(String).join(" "));
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  process.chdir(originalCwd);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("home cleanup CLI adapter", () => {
  test("defaults to inspect and emits the exact stable public JSON envelope", async () => {
    const expected = cleanupResult("inspect", "candidates");
    expect(await runHomeCleanup({ json: true }, {
      invokeCleanup: async (input) => {
        expect(input).toEqual({ apply: false });
        return expected;
      },
    })).toBe(0);
    const parsed = JSON.parse(logs[0] ?? "{}") as HomeReleaseCleanupResult;
    expect(parsed).toEqual(expected);
    expect(Object.keys(parsed)).toEqual([
      "schema", "operation", "mode", "status", "exitCode", "protectedReleaseCount",
      "candidateCount", "removedCount", "candidates", "reason", "message", "nextAction",
    ]);
    expect(JSON.stringify(parsed)).not.toContain("homeRoot");
    expect(JSON.stringify(parsed)).not.toContain("path");
    expect(JSON.stringify(parsed)).not.toContain("name");
    expect(JSON.stringify(parsed)).not.toContain("manifest");
    expect(errors).toEqual([]);
  });

  test("human inspection is actionable and apply reports exact removal without full hashes", async () => {
    expect(await runHomeCleanup({}, {
      invokeCleanup: async () => cleanupResult("inspect", "candidates"),
    })).toBe(0);
    expect(logs.join("\n")).toContain("1 unreachable managed release-store entry");
    expect(logs.join("\n")).toContain("release: 2.0.0 (bbbbbbbbbbbb)");
    expect(logs.join("\n")).toContain("next: rerun with --apply");
    expect(logs.join("\n")).not.toContain(ARTIFACT);

    logs = [];
    expect(await runHomeCleanup({ apply: true }, {
      invokeCleanup: async (input) => {
        expect(input).toEqual({ apply: true });
        return cleanupResult("apply", "removed");
      },
    })).toBe(0);
    expect(logs.join("\n")).toContain("removed 1 managed release-store entry");
  });

  test("missing Home is a successful host-wide no-op from a non-vault cwd", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "dome-home-cleanup-command-")));
    roots.push(root);
    process.chdir(root);
    expect(await runHomeCleanup({ json: true }, {
      applicationSupportDir: join(root, "missing-Home"),
    })).toBe(0);
    expect(JSON.parse(logs[0] ?? "{}")).toMatchObject({
      status: "not-installed",
      candidateCount: 0,
      removedCount: 0,
    });
  });

  test("rejects vault scope in either nested option position", async () => {
    for (const args of [
      ["home", "--vault", "/private/vault", "cleanup", "--json"],
      ["home", "cleanup", "--vault", "/private/vault", "--json"],
    ]) {
      logs = [];
      errors = [];
      expect(await runCli(args)).toBe(64);
      const usage = JSON.parse(logs.at(-1) ?? "{}") as HomeReleaseCleanupResult;
      expect(usage).toMatchObject({
        schema: "dome.home.cleanup/v1",
        operation: "cleanup",
        status: "usage-error",
        exitCode: 64,
        reason: "host-wide-command",
      });
      expect(JSON.stringify(usage)).not.toContain("/private/vault");
      expect(errors).toEqual([]);
    }
  });

  test("busy and fail-closed results use stderr without leaking unavailable internals", async () => {
    for (const result of [cleanupFailure("busy", 75), cleanupFailure("error", 1)] as const) {
      logs = [];
      errors = [];
      expect(await runHomeCleanup({}, { invokeCleanup: async () => result })).toBe(result.exitCode);
      expect(logs).toEqual([]);
      expect(errors.join("\n")).toContain(result.message);
      expect(errors.join("\n")).not.toContain("/secret");
    }
  });
});

function cleanupResult(
  mode: "inspect" | "apply",
  status: "candidates" | "removed",
): HomeReleaseCleanupResult {
  return {
    schema: "dome.home.cleanup/v1",
    operation: "cleanup",
    mode,
    status,
    exitCode: 0,
    protectedReleaseCount: 1,
    candidateCount: 1,
    removedCount: status === "removed" ? 1 : 0,
    candidates: [{ artifactId: ARTIFACT, version: "2.0.0", kind: "release" }],
    reason: null,
    message: status === "removed" ? "Managed Dome Home release-store cleanup completed." : "eligible",
    nextAction: status === "candidates" ? "rerun-with-apply" : "none",
  };
}

function cleanupFailure(status: "busy" | "error", exitCode: 1 | 75): HomeReleaseCleanupResult {
  return {
    schema: "dome.home.cleanup/v1",
    operation: "cleanup",
    mode: "inspect",
    status,
    exitCode,
    protectedReleaseCount: null,
    candidateCount: null,
    removedCount: null,
    candidates: null,
    reason: status === "busy" ? "release-store-busy" : "verification-failed",
    message: status === "busy" ? "busy safely" : "unavailable safely",
    nextAction: status === "busy" ? "rerun-inspect" : "inspect-home-store",
  };
}
