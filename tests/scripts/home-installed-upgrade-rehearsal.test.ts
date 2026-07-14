import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertBoundedArchiveStatForTests,
  assertInstalledBackupRestoreCanaryForTests,
  canonicalizeInstalledScenarioRootForTests,
  classifyInstalledHomeDrainForTests,
  exerciseInstalledUpgradeOrchestrationForTests,
  pairedDeviceIdForTests,
  predecessorHomeInstallInvocationForTests,
  resolveContainedArtifactRootForTests,
  type InstalledHomeUpgradeRehearsalInput,
  type InstalledHomeUpgradeScenario,
} from "../../scripts/home-installed-upgrade-rehearsal";

const INPUT: InstalledHomeUpgradeRehearsalInput = Object.freeze({
  predecessorArchive: "/synthetic/predecessor.tar.gz",
  candidateArchive: "/synthetic/candidate.tar.gz",
  frozenFixtureRoot: "/synthetic/fixture",
});

describe("installed Home upgrade portable orchestration (explicitly non-evidence)", () => {
  test("refuses non-files, oversize input, and predecessor size drift before archive reads", () => {
    expect(() => assertBoundedArchiveStatForTests({ isFile: true, size: 10 }, 10, 10)).not.toThrow();
    expect(() => assertBoundedArchiveStatForTests({ isFile: false, size: 10 }, 10)).toThrow("bounded regular file");
    expect(() => assertBoundedArchiveStatForTests({ isFile: true, size: 11 }, 10)).toThrow("bounded regular file");
    expect(() => assertBoundedArchiveStatForTests({ isFile: true, size: 9 }, 10, 10)).toThrow("immutable receipt");
  });

  test("requires both a drained launchd label and a free Home port", () => {
    expect(classifyInstalledHomeDrainForTests(0, 0, false)).toBe("pending");
    expect(classifyInstalledHomeDrainForTests(0, 113, false)).toBe("pending");
    expect(classifyInstalledHomeDrainForTests(0, 113, true)).toBe("drained");
    expect(classifyInstalledHomeDrainForTests(3, 113, true)).toBe("drained");
    expect(() => classifyInstalledHomeDrainForTests(3, 0, false)).toThrow("without absent print proof");
    expect(() => classifyInstalledHomeDrainForTests(113, 113, false)).toThrow("bootout failed");
    expect(() => classifyInstalledHomeDrainForTests(0, 3, false)).toThrow("print failed");
  });

  test("canonicalizes an aliased extraction destination and still rejects a sibling escape", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-installed-extraction-alias-"));
    try {
      const destination = join(root, "destination");
      const alias = join(root, "destination-alias");
      const artifact = join(destination, "artifact");
      await mkdir(artifact, { recursive: true });
      await symlink(destination, alias, "dir");
      const canonicalDestination = await realpath(alias);

      expect(await resolveContainedArtifactRootForTests(canonicalDestination, "artifact"))
        .toBe(await realpath(artifact));

      await rm(artifact, { recursive: true });
      const sibling = join(root, "sibling");
      await mkdir(sibling);
      await symlink("../sibling", artifact, "dir");
      await expect(resolveContainedArtifactRootForTests(canonicalDestination, "artifact"))
        .rejects.toThrow("escaped extraction directory");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("installs the exact pre-fix predecessor through cwd discovery without nested --vault", () => {
    const invocation = predecessorHomeInstallInvocationForTests({
      dome: "/artifact-0.1/bin/dome",
      vault: "/scenario/vault",
      home: "/scenario/home",
    });
    expect(invocation).toEqual({
      command: [
        "/artifact-0.1/bin/dome",
        "home",
        "install",
        "--env",
        "HOME=/scenario/home",
        "--json",
      ],
      cwd: "/scenario/vault",
    });
    expect(invocation.command).not.toContain("--vault");
  });

  test("reads the paired identity from the nested device response", () => {
    expect(pairedDeviceIdForTests({
      schema: "dome.device.pairing/v1",
      status: "paired",
      id: "top-level-decoy",
      device: { id: "device_exact", name: "Upgrade canary" },
    })).toBe("device_exact");
    expect(() => pairedDeviceIdForTests({
      schema: "dome.device.pairing/v1",
      status: "paired",
      id: "top-level-decoy",
      device: { name: "Upgrade canary" },
    })).toThrow("id must be a nonempty string");
    expect(() => pairedDeviceIdForTests({
      schema: "dome.device.pairing/v1",
      status: "paired",
      id: "top-level-decoy",
    })).toThrow("device must be an object");
  });

  test("captures an aliased scenario root once before deriving owned descendants", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-installed-scenario-alias-"));
    try {
      const physicalParent = join(root, "physical-parent");
      const redirectedParent = join(root, "redirected-parent");
      const alias = join(root, "scenario-parent-alias");
      await mkdir(physicalParent);
      await mkdir(redirectedParent);
      await symlink(physicalParent, alias, "dir");
      const lexical = await mkdtemp(join(alias, "scenario-"));
      const canonical = await canonicalizeInstalledScenarioRootForTests(lexical);
      expect(canonical.startsWith(`${await realpath(physicalParent)}/scenario-`)).toBeTrue();

      await rm(alias);
      await symlink(redirectedParent, alias, "dir");
      expect(join(canonical, "home")).toStartWith(`${await realpath(physicalParent)}/`);
      expect(join(canonical, "vault")).not.toStartWith(`${await realpath(redirectedParent)}/`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires the installed backup canary to restore and invalidate authority", () => {
    const restored = {
      schema: "dome.backup/v1",
      operation: "restore",
      status: "restored",
      exitCode: 0,
      authority: "invalidated",
      durability: "durable",
    };
    const ownerSha256 = "a".repeat(64);
    expect(() => assertInstalledBackupRestoreCanaryForTests(
      restored,
      "# Core\n",
      ownerSha256,
      ownerSha256,
    )).not.toThrow();
    expect(() => assertInstalledBackupRestoreCanaryForTests(
      { ...restored, authority: "absent" },
      "# Core\n",
      ownerSha256,
      ownerSha256,
    )).toThrow('expected authority="invalidated"');
    expect(() => assertInstalledBackupRestoreCanaryForTests(
      restored,
      "# Other\n",
      ownerSha256,
      ownerSha256,
    ))
      .toThrow("lost core.md content");
    expect(() => assertInstalledBackupRestoreCanaryForTests(
      restored,
      "# Core\n",
      "b".repeat(64),
      ownerSha256,
    )).toThrow("changed the owner canary");
  });

  test("runs the three scenarios sequentially and cleans each boundary", async () => {
    const events: string[] = [];
    let active = false;
    const result = await exerciseInstalledUpgradeOrchestrationForTests(INPUT, {
      prepare: async (input) => {
        events.push(`prepare:${input.candidateArchive}`);
        return Object.freeze({ token: "synthetic" });
      },
      runScenario: async (name, prepared) => {
        expect(prepared.token).toBe("synthetic");
        expect(active).toBeFalse();
        active = true;
        events.push(`run:${name}`);
      },
      cleanupScenario: async (name) => {
        expect(active).toBeTrue();
        active = false;
        events.push(`scenario-clean:${name}`);
      },
      cleanup: async (prepared) => { events.push(`clean:${prepared?.token ?? "null"}`); },
    });

    expect(result).toEqual({
      evidence: false,
      scenarios: ["ready-success", "stopped-precommit-crash", "committed-exact-repair"],
    });
    expect("schema" in result).toBeFalse();
    expect(events).toEqual([
      "prepare:/synthetic/candidate.tar.gz",
      "run:ready-success",
      "scenario-clean:ready-success",
      "run:stopped-precommit-crash",
      "scenario-clean:stopped-precommit-crash",
      "run:committed-exact-repair",
      "scenario-clean:committed-exact-repair",
      "clean:synthetic",
    ]);
  });

  test("cleans the failing scenario and global preparation without emitting evidence", async () => {
    const events: string[] = [];
    const failure: InstalledHomeUpgradeScenario = "stopped-precommit-crash";
    await expect(exerciseInstalledUpgradeOrchestrationForTests(INPUT, {
      prepare: async () => ({ token: "synthetic" }),
      runScenario: async (name) => {
        events.push(`run:${name}`);
        if (name === failure) throw new Error("synthetic failure");
      },
      cleanupScenario: async (name) => { events.push(`scenario-clean:${name}`); },
      cleanup: async (prepared) => { events.push(`clean:${prepared?.token ?? "null"}`); },
    })).rejects.toThrow("synthetic failure");
    expect(events).toEqual([
      "run:ready-success",
      "scenario-clean:ready-success",
      "run:stopped-precommit-crash",
      "scenario-clean:stopped-precommit-crash",
      "clean:synthetic",
    ]);
  });

  test("runs global cleanup with null when preparation itself fails", async () => {
    const events: string[] = [];
    await expect(exerciseInstalledUpgradeOrchestrationForTests(INPUT, {
      prepare: async () => { throw new Error("synthetic prepare failure"); },
      runScenario: async () => { throw new Error("unreachable"); },
      cleanupScenario: async () => { throw new Error("unreachable"); },
      cleanup: async (prepared) => { events.push(prepared === null ? "clean:null" : "bad"); },
    })).rejects.toThrow("synthetic prepare failure");
    expect(events).toEqual(["clean:null"]);
  });
});
