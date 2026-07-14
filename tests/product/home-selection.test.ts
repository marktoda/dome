import { describe, expect, test } from "bun:test";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  captureHomeSelection,
  classifyHomeSelection,
  homeSelectionPaths,
  publishHomeSelectionDocument,
  repairHomeSelection,
  renderHomeSelection,
} from "../../src/product-host/home-selection";

describe("Home release selection", () => {
  test("rejects secret-like environment before rendering selector or plist bytes", () => {
    const input = {
      vault: "/vault",
      artifact: { id: "a".repeat(64), version: "2.0.0", releasePath: `/support/releases/${"a".repeat(64)}` },
      environment: [{ name: "SERVICE_TOKEN", value: "must-not-persist" }],
    };
    expect(() => renderHomeSelection(input, { applicationSupportDir: "/support" })).toThrow("macOS Keychain");
    expect(renderHomeSelection({ ...input, environment: [{ name: "DOME_LOG_LEVEL", value: "debug" }] }, {
      applicationSupportDir: "/support",
    }).installation.bytes).toContain("DOME_LOG_LEVEL");
  });

  test("renders a closed candidate pair and classifies only exact old/candidate bytes", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "dome-home-selection-")));
    try {
      const vault = join(root, "vault");
      const support = join(root, "support");
      const launchAgentsDir = join(root, "LaunchAgents");
      await mkdir(join(vault, ".dome", "state"), { recursive: true });
      await mkdir(launchAgentsDir, { recursive: true });
      const deps = { applicationSupportDir: support, launchAgentsDir };
      const paths = homeSelectionPaths(vault, deps);
      await mkdir(join(support, "installations", paths.installation.split("/").at(-2)!), { recursive: true });
      await writeFile(paths.installation, "old installation\n", { mode: 0o600 });
      await writeFile(paths.plist, "old plist\n", { mode: 0o600 });
      const old = await captureHomeSelection(vault, deps);
      const candidate = renderHomeSelection({
        vault,
        artifact: { id: "a".repeat(64), version: "2.0.0", releasePath: join(support, "releases", "a".repeat(64)) },
        environment: [{ name: "DOME_TEST", value: "yes" }],
      }, deps);
      expect(candidate.installation.bytes).toContain('"version": "2.0.0"');
      expect(candidate.plist.bytes).toContain(join(support, "releases", "a".repeat(64)));
      expect(await classifyHomeSelection({ old, candidate })).toBe("old");

      await publishHomeSelectionDocument({ expected: old.plist, desired: candidate.plist });
      expect(await classifyHomeSelection({ old, candidate })).toBe("mixed");
      await publishHomeSelectionDocument({ expected: old.installation, desired: candidate.installation });
      expect(await classifyHomeSelection({ old, candidate })).toBe("candidate");

      await chmod(paths.plist, 0o644);
      expect(await classifyHomeSelection({ old, candidate })).toBe("invalid");
      expect(await readFile(paths.installation, "utf8")).toBe(candidate.installation.bytes);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("rejects forged publication and linked, missing, or partial selector states", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "dome-home-selection-defenses-")));
    try {
      const vault = join(root, "vault");
      const support = join(root, "support");
      const launchAgentsDir = join(root, "LaunchAgents");
      await mkdir(join(vault, ".dome", "state"), { recursive: true });
      await mkdir(launchAgentsDir, { recursive: true });
      const deps = { applicationSupportDir: support, launchAgentsDir };
      const paths = homeSelectionPaths(vault, deps);
      await mkdir(join(support, "installations", paths.installation.split("/").at(-2)!), { recursive: true });
      await writeFile(paths.installation, "old installation\n", { mode: 0o600 });
      await writeFile(paths.plist, "old plist\n", { mode: 0o600 });
      const old = await captureHomeSelection(vault, deps);
      const candidate = renderHomeSelection({
        vault,
        artifact: { id: "b".repeat(64), version: "2.0.0", releasePath: join(support, "releases", "b".repeat(64)) },
        environment: [],
      }, deps);

      await expect(publishHomeSelectionDocument({
        expected: old.plist,
        desired: { ...candidate.plist, bytes: `${candidate.plist.bytes}forged` },
      })).rejects.toThrow("does not match");
      expect(await readFile(paths.plist, "utf8")).toBe("old plist\n");

      await rm(paths.plist);
      expect(await classifyHomeSelection({ old, candidate })).toBe("invalid");
      await expect(publishHomeSelectionDocument({ expected: old.plist, desired: candidate.plist })).rejects.toThrow();
      await symlink(paths.installation, paths.plist);
      expect(await classifyHomeSelection({ old, candidate })).toBe("invalid");
      await rm(paths.plist);
      await link(paths.installation, paths.plist);
      expect(await classifyHomeSelection({ old, candidate })).toBe("invalid");
      await rm(paths.plist);
      await writeFile(paths.plist, "old plist\n", { mode: 0o600 });

      let publications = 0;
      await publishHomeSelectionDocument({ expected: old.plist, desired: candidate.plist }, {
        ...deps,
        beforeRename: async () => { publications += 1; throw new Error("injected publication failure"); },
      }).catch(() => {});
      expect(publications).toBe(1);
      expect(await classifyHomeSelection({ old, candidate })).toBe("old");

      for (const [expected, desired] of [
        [old.plist, candidate.plist],
        [old.installation, candidate.installation],
      ] as const) {
        await expect(publishHomeSelectionDocument({ expected, desired }, {
          ...deps,
          beforeRename: async () => { await writeFile(expected.path, "concurrent owner bytes\n"); },
        })).rejects.toThrow("expected bytes changed");
        expect(await readFile(expected.path, "utf8")).toBe("concurrent owner bytes\n");
        await writeFile(expected.path, expected.bytes, { mode: expected.mode });
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("forward repair inspects both paths before writing, then converges missing and corrupt selectors", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "dome-home-selection-repair-")));
    try {
      const vault = join(root, "vault");
      const support = join(root, "support");
      const launchAgentsDir = join(root, "LaunchAgents");
      await mkdir(join(vault, ".dome", "state"), { recursive: true });
      await mkdir(launchAgentsDir, { recursive: true });
      const deps = { applicationSupportDir: support, launchAgentsDir, platform: "darwin" as const };
      const paths = homeSelectionPaths(vault, deps);
      await mkdir(join(support, "installations", paths.installation.split("/").at(-2)!), { recursive: true });
      await writeFile(paths.installation, "old installation\n", { mode: 0o600 });
      await writeFile(paths.plist, "old plist\n", { mode: 0o600 });
      const candidate = renderHomeSelection({
        vault,
        artifact: { id: "c".repeat(64), version: "3.0.0", releasePath: join(support, "releases", "c".repeat(64)) },
        environment: [],
      }, deps);

      await writeFile(paths.plist, "bounded corrupt plist\n", { mode: 0o600 });
      await rm(paths.installation);
      const outside = join(root, "outside-selector");
      await writeFile(outside, "outside\n", { mode: 0o600 });
      await symlink(outside, paths.installation);
      await expect(repairHomeSelection(candidate, deps)).rejects.toThrow("redirected");
      expect(await readFile(paths.plist, "utf8")).toBe("bounded corrupt plist\n");
      expect(await readFile(outside, "utf8")).toBe("outside\n");

      await rm(paths.installation);
      const checkpoints: string[] = [];
      await repairHomeSelection(candidate, deps, async (name) => { checkpoints.push(name); });
      expect(checkpoints).toEqual(["plist-published", "installation-published"]);
      expect(await readFile(paths.plist, "utf8")).toBe(candidate.plist.bytes);
      expect(await readFile(paths.installation, "utf8")).toBe(candidate.installation.bytes);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("repair retry syncs and recaptures an ambiguous no-replace selector winner", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "dome-home-selection-durable-retry-")));
    try {
      const vault = join(root, "vault");
      const support = join(root, "support");
      const launchAgentsDir = join(root, "LaunchAgents");
      await mkdir(join(vault, ".dome", "state"), { recursive: true });
      await mkdir(launchAgentsDir, { recursive: true });
      const deps = { applicationSupportDir: support, launchAgentsDir, platform: "darwin" as const };
      const paths = homeSelectionPaths(vault, deps);
      await mkdir(join(support, "installations", paths.installation.split("/").at(-2)!), { recursive: true });
      const candidate = renderHomeSelection({
        vault,
        artifact: { id: "d".repeat(64), version: "4.0.0", releasePath: join(support, "releases", "d".repeat(64)) },
        environment: [],
      }, deps);
      await writeFile(paths.plist, candidate.plist.bytes, { mode: candidate.plist.mode });

      let installationParentSyncs = 0;
      await expect(repairHomeSelection(candidate, {
        ...deps,
        publishMissingPath: async (source, target) => {
          await rename(source, target);
          throw new Error("selector publisher lost rename completion");
        },
        syncParent: async (path) => {
          if (path === join(support, "installations", paths.installation.split("/").at(-2)!)) {
            installationParentSyncs++;
            throw new Error("selector parent sync failed");
          }
        },
      })).rejects.toThrow("selector parent sync failed");
      expect(await readFile(paths.installation, "utf8")).toBe(candidate.installation.bytes);
      expect(installationParentSyncs).toBe(1);

      await repairHomeSelection(candidate, {
        ...deps,
        syncParent: async (path) => {
          if (path === join(support, "installations", paths.installation.split("/").at(-2)!)) {
            installationParentSyncs++;
          }
        },
      });
      expect(installationParentSyncs).toBe(2);
      expect(await readFile(paths.installation, "utf8")).toBe(candidate.installation.bytes);
      expect(await readFile(paths.plist, "utf8")).toBe(candidate.plist.bytes);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
