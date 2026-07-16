import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { resolveHomeLifecycleEnvironment, runHomeLifecycle } from "../../src/cli/commands/home-lifecycle";
import type { HomeLifecycleDeps } from "../../src/product-host/home-lifecycle";
import { homeServiceLabelForVault } from "../../src/product-host/home-lifecycle";
import {
  homeLifecycleCoordinatorPath,
  withHomeLifecycleMutation,
} from "../../src/product-host/home-lifecycle-suspension";
import type { HomeArtifactManifest } from "../../src/product-host/home-artifact";
import type { HomeUpgradeTransaction } from "../../src/product-host/home-upgrade-transaction";
import { initRepo } from "../../src/git";

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
  const vault = await initializedVault();
  expect(await runHomeLifecycle("status", { vault, json: true }, d)).toBe(0);
  const status = JSON.parse(logs.at(-1) ?? "{}") as Record<string, unknown>;
  expect(status["schema"]).toBe("dome.home.lifecycle/v1");
  expect(status["status"]).toBe("not-installed");
  expect(status["program"]).toBeString();
  expect(status["lifecycle"]).toEqual({ state: "inactive" });
  expect(status["upgrade"]).toEqual({
    state: "inactive",
    candidate: null,
    operationId: null,
    outcome: null,
    nextAction: "none",
  });

  logs = [];
  expect(await runHomeLifecycle("status", { vault }, d)).toBe(0);
  expect(logs.join("\n")).toContain("lifecycle: inactive");
  expect(logs.join("\n")).toContain("upgrade: inactive; next none");

  logs = [];
  expect(await runHomeLifecycle("start", { vault, json: true }, d)).toBe(64);
  const start = JSON.parse(logs.at(-1) ?? "{}") as Record<string, unknown>;
  expect(start["status"]).toBe("error");
  expect(start["exitCode"]).toBe(64);
});

test("lifecycle status turns broken committed upgrade truth into phase-free recovery guidance", async () => {
  const base = deps();
  const vault = await initializedVault();
  const active = committedUpgrade(vault);
  const d: HomeLifecycleDeps = {
    ...base,
    upgradeStatusOperations: {
      readDisposition: async () => active,
      readForward: async () => { throw new Error("/private/release/missing"); },
    },
  };
  expect(await runHomeLifecycle("status", { vault, json: true }, d)).toBe(1);
  const status = JSON.parse(logs.at(-1) ?? "{}") as Record<string, unknown>;
  expect(status["upgrade"]).toEqual({
    state: "recovery-required",
    candidate: { artifactId: "b".repeat(64), productVersion: "2.0.0" },
    operationId: "11111111-1111-4111-8111-111111111111",
    outcome: "committed",
    nextAction: "supply-exact-candidate",
  });
  expect(status["error"]).toBe("Home upgrade requires the exact committed candidate for forward recovery");
  expect(JSON.stringify(status["upgrade"])).not.toContain("private");
  expect(String(status["error"])).not.toContain("private");
  expect(JSON.stringify(status)).not.toContain('"phase"');
});

test("lifecycle status makes active and unavailable upgrade coordination nonzero", async () => {
  const vault = await initializedVault();
  const prepared = { ...committedUpgrade(vault), phase: "prepared" as const };
  const cases = [
    {
      operations: { readDisposition: async () => prepared, readForward: async () => prepared },
      state: "active",
      error: "Home upgrade recovery is in progress",
    },
    {
      operations: {
        readDisposition: async () => { throw new Error("/private/journal/corrupt"); },
        readForward: async () => null,
      },
      state: "unavailable",
      error: "Home upgrade status is unavailable",
    },
  ] as const;
  for (const scenario of cases) {
    logs = [];
    const d: HomeLifecycleDeps = { ...deps(), upgradeStatusOperations: scenario.operations };
    expect(await runHomeLifecycle("status", { vault, json: true }, d)).toBe(1);
    const status = JSON.parse(logs.at(-1) ?? "{}") as {
      readonly upgrade: { readonly state: string };
      readonly error: string;
    };
    expect(status.upgrade.state).toBe(scenario.state);
    expect(status.error).toBe(scenario.error);
    expect(JSON.stringify(status.upgrade)).not.toContain("phase");
    expect(status.error).not.toContain("private");
  }
});

test("lifecycle CLI error output prints structured recovery detail", async () => {
  const d = deps();
  const vault = await initializedVault();
  expect((await withHomeLifecycleMutation(vault, async () => {})).kind).toBe("owned");
  await writeFile(homeLifecycleCoordinatorPath(vault), "corrupt lifecycle\n");
  expect(await runHomeLifecycle("status", { vault }, d)).toBe(1);
  expect(errors.join("\n")).toContain("lifecycle: invalid");
});

async function initializedVault(): Promise<string> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dome-home-command-vault-")));
  roots.push(root);
  const vault = join(root, "vault");
  await initRepo(vault);
  await mkdir(join(vault, ".dome"), { recursive: true });
  await writeFile(join(vault, ".dome", "config.yaml"), "extensions: {}\n");
  return vault;
}

function committedUpgrade(vault: string): HomeUpgradeTransaction {
  return {
    schema: "dome.home-upgrade-transaction/v2",
    vault,
    transactionId: "11111111-1111-4111-8111-111111111111",
    phase: "committed",
    old: { artifactId: "a".repeat(64), version: "1.0.0", releasePath: "/old", manifestSha256: "c".repeat(64) },
    candidate: { artifactId: "b".repeat(64), version: "2.0.0", releasePath: "/candidate", manifestSha256: "d".repeat(64) },
    selectors: {
      installation: { path: "/installation.json", mode: 0o600, size: 1, sha256: "1".repeat(64) },
      plist: { path: "/home.plist", mode: 0o600, size: 1, sha256: "2".repeat(64) },
    },
    selection: null,
    probation: null,
    snapshot: { root: "snapshot", inventory: [] },
    timestamps: {
      preparedAt: "2026-07-13T00:00:00.000Z",
      switchingAt: "2026-07-13T00:01:00.000Z",
      committedAt: "2026-07-13T00:02:00.000Z",
      restoredAt: null,
    },
  };
}

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

test("lifecycle CLI leaves environment undefined when install flags are absent", async () => {
  expect(await resolveHomeLifecycleEnvironment("install", {})).toBeUndefined();
  expect(await resolveHomeLifecycleEnvironment("status", { env: ["IGNORED=value"] })).toBeUndefined();
  expect(await resolveHomeLifecycleEnvironment("install", { env: [] })).toEqual(new Map());
});

test("runHomeLifecycle rejects secret persistence before coordination and preserves stored non-secret environment", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dome-home-command-install-")));
  roots.push(root);
  const vault = join(root, "vault");
  await initRepo(vault);
  await mkdir(join(vault, ".dome"), { recursive: true });
  await writeFile(join(vault, ".dome", "config.yaml"), "extensions: {}\n");
  const artifact = join(root, "artifact");
  await mkdir(join(artifact, "runtime"), { recursive: true });
  await mkdir(join(artifact, "app", "bin"), { recursive: true });
  await mkdir(join(artifact, "app", "pwa", "dist"), { recursive: true });
  await writeFile(join(artifact, "runtime", "bun"), "runtime", { mode: 0o755 });
  await writeFile(join(artifact, "app", "bin", "dome"), "program", { mode: 0o755 });
  await chmod(join(artifact, "runtime", "bun"), 0o755);
  await chmod(join(artifact, "app", "bin", "dome"), 0o755);
  await writeFile(join(artifact, "app", "pwa", "dist", "index.html"), "home");
  const loaded = new Set<string>();
  const d: HomeLifecycleDeps = {
    platform: "darwin", uid: 501, launchAgentsDir: join(root, "agents"),
    artifactRoot: artifact, applicationSupportDir: join(root, "support"),
    verifyArtifact: async () => legacyManifest("c".repeat(64), "1.0.0", "runtime", "0755"),
    publishRelease: rename, syncRelease: async () => {},
    launchctl: async (args) => {
      const target = args.at(-1) ?? "";
      if (args[0] === "print") return { exitCode: loaded.has(target) ? 0 : 113, stdout: "", stderr: "" };
      if (args[0] === "bootout") loaded.delete(target);
      if (args[0] === "bootstrap") loaded.add(`${args[1]}/${basename(args[2] ?? "").replace(/\.plist$/, "")}`);
      if (args[0] === "kickstart") loaded.add(target);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    readiness: async () => loaded.has(`gui/501/${homeServiceLabelForVault(vault)}`),
    legacyServeRunning: async () => false,
    readinessTimeoutMs: 10,
  };
  expect(await runHomeLifecycle("install", { vault, env: ["DOME_SECRET=must-not-persist"], json: true }, d)).toBe(64);
  expect(JSON.parse(logs.at(-1) ?? "{}")).toMatchObject({
    status: "credential-migration-required",
    exitCode: 64,
  });
  expect(existsSync(dirname(homeLifecycleCoordinatorPath(vault)))).toBeFalse();
  expect(existsSync(join(root, "support"))).toBeFalse();
  expect(existsSync(join(root, "agents"))).toBeFalse();
  expect(loaded.size).toBe(0);

  logs = [];
  expect(await runHomeLifecycle("install", { vault, env: ["DOME_SETTING=kept"], json: true }, d)).toBe(0);
  logs = [];
  expect(await runHomeLifecycle("install", { vault, json: true }, d)).toBe(0);
  const result = JSON.parse(logs.at(-1) ?? "{}") as { readonly installation: string };
  const record = JSON.parse(await readFile(result.installation, "utf8")) as { readonly environment: ReadonlyArray<{ readonly name: string; readonly value: string }> };
  expect(record.environment).toEqual([{ name: "DOME_SETTING", value: "kept" }]);
});

function legacyManifest(
  artifactId: string,
  version: string,
  runtimeBytes: string,
  runtimeMode: string,
): HomeArtifactManifest {
  const runtimeSha256 = createHash("sha256").update(runtimeBytes).digest("hex");
  return {
    schema: "dome.home-artifact/v1",
    product: { name: "Dome Home", version },
    target: { os: "darwin", arch: "arm64" },
    build: { gitCommit: "fixture" },
    artifact: { id: artifactId },
    runtime: {
      name: "bun",
      version: "1.2.13",
      sourceUrl: "https://example.invalid/bun.zip",
      archiveSha256: "0".repeat(64),
      sha256: runtimeSha256,
    },
    tools: [],
    entrypoint: "bin/dome",
    pwa: "app/pwa/dist",
    distribution: { signed: false, notarized: false, upgradeSupported: false },
    entries: [{
      type: "file",
      path: "runtime/bun",
      bytes: Buffer.byteLength(runtimeBytes),
      sha256: runtimeSha256,
      mode: runtimeMode,
    }],
  };
}
