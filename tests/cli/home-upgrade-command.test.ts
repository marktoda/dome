import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runHomeUpgrade } from "../../src/cli/commands/home-upgrade";
import type { HomeUpgradeResult } from "../../src/product-host/home-upgrade";

const CANDIDATE = "b".repeat(64);
const OLD = "a".repeat(64);
const OPERATION = "11111111-1111-4111-8111-111111111111";
let logs: string[] = [];
let errors: string[] = [];
const originalLog = console.log;
const originalError = console.error;
const originalCwd = process.cwd();
const roots: string[] = [];

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

describe("home upgrade CLI adapter", () => {
  test("emits the exact public JSON document and returns its exit code", async () => {
    for (const exitCode of [0, 1, 64, 75] as const) {
      const expected = upgradeResult(exitCode);
      logs = [];
      expect(await runHomeUpgrade({ vault: "/vault", json: true }, {
        invokeUpgrade: async (input) => {
          expect(input).toEqual({ action: "run", vaultPath: "/vault" });
          return expected;
        },
      })).toBe(exitCode);
      expect(JSON.parse(logs[0] ?? "{}")).toEqual(expected);
      expect(Object.keys(JSON.parse(logs[0] ?? "{}"))).toEqual([
        "schema", "operation", "status", "exitCode", "vault", "requestedArtifact",
        "transaction", "selectedArtifact", "recovered", "service", "reason", "message", "nextAction",
      ]);
      expect(errors).toEqual([]);
    }
  });

  test("keeps human output concise, actionable, and limited to sanitized result fields", async () => {
    const success = upgradeResult(0);
    expect(await runHomeUpgrade({}, { invokeUpgrade: async () => success })).toBe(0);
    expect(logs.join("\n")).toContain("Dome Home upgrade: upgraded");
    expect(logs.join("\n")).toContain(`requested: 2.0.0 (${CANDIDATE})`);
    expect(logs.join("\n")).toContain(`transaction: committed (operation ${OPERATION})`);
    expect(logs.join("\n")).toContain("next: none");

    logs = [];
    const failure = { ...upgradeResult(1), message: "exact invoking committed candidate is required for forward repair" };
    expect(await runHomeUpgrade({}, { invokeUpgrade: async () => failure })).toBe(1);
    expect(errors.join("\n")).toContain("Dome Home upgrade: recovery-required");
    expect(errors.join("\n")).toContain("next: supply-exact-candidate");
    expect(errors.join("\n")).not.toContain("releasePath");
    expect(errors.join("\n")).not.toContain("manifestSha256");
    expect(errors.join("\n")).not.toContain("phase");
  });

  test("uses standard upward vault discovery and canonicalizes explicit options", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "dome-home-upgrade-command-")));
    roots.push(root);
    const vault = join(root, "vault");
    const nested = join(vault, "wiki", "nested");
    mkdirSync(join(vault, ".dome"), { recursive: true });
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(vault, ".dome", "config.yaml"), "extensions: {}\n");
    process.chdir(nested);
    const seen: string[] = [];
    const invokeUpgrade = async (input: { readonly action: "run"; readonly vaultPath: string }) => {
      seen.push(input.vaultPath);
      return upgradeResult(0);
    };
    expect(await runHomeUpgrade({ json: true }, { invokeUpgrade })).toBe(0);
    expect(await runHomeUpgrade({ vault: join(vault, "wiki", ".."), json: true }, { invokeUpgrade })).toBe(0);
    expect(seen).toEqual([vault, vault]);
  });
});

function upgradeResult(exitCode: HomeUpgradeResult["exitCode"]): HomeUpgradeResult {
  const success = exitCode === 0;
  return {
    schema: "dome.home.upgrade/v1",
    operation: "upgrade",
    status: success ? "upgraded" : "recovery-required",
    exitCode,
    vault: "/vault",
    requestedArtifact: { artifactId: CANDIDATE, productVersion: "2.0.0" },
    transaction: { operationId: OPERATION, candidate: { artifactId: CANDIDATE, productVersion: "2.0.0" }, outcome: "committed" },
    selectedArtifact: { artifactId: success ? CANDIDATE : OLD, productVersion: success ? "2.0.0" : "1.0.0" },
    recovered: false,
    service: success ? "ready" : "deferred",
    reason: success ? null : "candidate-repair-required",
    message: success ? "Dome Home upgraded successfully." : "exact candidate required",
    nextAction: success ? "none" : "supply-exact-candidate",
  };
}
