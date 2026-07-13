import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { resolveHomeLifecycleEnvironment, runHomeLifecycle } from "../../src/cli/commands/home-lifecycle";
import type { HomeLifecycleDeps } from "../../src/product-host/home-lifecycle";
import { homeServiceLabelForVault } from "../../src/product-host/home-lifecycle";
import type { HomeArtifactManifest } from "../../src/product-host/home-artifact";
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

test("lifecycle CLI leaves environment undefined when install flags are absent", async () => {
  expect(await resolveHomeLifecycleEnvironment("install", {})).toBeUndefined();
  expect(await resolveHomeLifecycleEnvironment("status", { env: ["IGNORED=value"] })).toBeUndefined();
  expect(await resolveHomeLifecycleEnvironment("install", { env: [] })).toEqual(new Map());
});

test("runHomeLifecycle preserves stored environment when reinstall flags are absent", async () => {
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
    verifyArtifact: async () => ({ artifact: { id: "c".repeat(64) }, product: { name: "Dome Home", version: "1.0.0" } } as HomeArtifactManifest),
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
  expect(await runHomeLifecycle("install", { vault, env: ["DOME_SECRET=kept"], json: true }, d)).toBe(0);
  logs = [];
  expect(await runHomeLifecycle("install", { vault, json: true }, d)).toBe(0);
  const result = JSON.parse(logs.at(-1) ?? "{}") as { readonly installation: string };
  const record = JSON.parse(await readFile(result.installation, "utf8")) as { readonly environment: ReadonlyArray<{ readonly name: string; readonly value: string }> };
  expect(record.environment).toEqual([{ name: "DOME_SECRET", value: "kept" }]);
});
