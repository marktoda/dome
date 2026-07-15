import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertBoundedArchiveStatForTests,
  assertInstalledBackupRestoreCanaryForTests,
  canonicalizeInstalledScenarioRootForTests,
  classifyInstalledHomeDrainForTests,
  exerciseAbortableInstalledCommandForTests,
  exerciseInstalledUpgradeOrchestrationForTests,
  pairedDeviceIdForTests,
  predecessorHomeInstallInvocationForTests,
  retainedCheckpointOwnershipMatchesForTests,
  renderInstalledCoordinationErrorForTests,
  retainedCheckpointOwnershipSummaryForTests,
  resolveContainedArtifactRootForTests,
  type InstalledHomeUpgradeRehearsalInput,
  type InstalledHomeUpgradeScenario,
} from "../../scripts/home-installed-upgrade-rehearsal";
import {
  exerciseHomePwaChromiumAcceptanceForTests,
  parseHomePwaCaptureExportForTests,
} from "../../scripts/home-pwa-chromium-acceptance";

const INPUT: InstalledHomeUpgradeRehearsalInput = Object.freeze({
  predecessorArchive: "/synthetic/predecessor.tar.gz",
  candidateArchive: "/synthetic/candidate.tar.gz",
  frozenFixtureRoot: "/synthetic/fixture",
});

describe("installed Home upgrade portable orchestration (explicitly non-evidence)", () => {
  test("keeps the installed Chromium journey ordered, cleanup-closed, and non-evidence", async () => {
    const events: string[] = [];
    const operation = (name: string) => async (): Promise<void> => { events.push(name); };
    const result = await exerciseHomePwaChromiumAcceptanceForTests({
      launch: operation("launch"),
      pair: operation("pair"),
      assertReadiness: operation("readiness"),
      controlServiceWorker: operation("service-worker"),
      assertOfflineShell: operation("offline-shell"),
      saveLocalCapture: operation("local-capture"),
      revoke: operation("revoke"),
      repairAuthentication: operation("auth-repair"),
      assertReplay: operation("replay"),
      emergencyClose: operation("emergency-close"),
      close: operation("cleanup"),
    });
    expect(result).toEqual({ evidence: false });
    expect(events).toEqual([
      "launch", "pair", "readiness", "service-worker", "offline-shell",
      "local-capture", "revoke", "auth-repair", "replay", "cleanup",
    ]);

    events.length = 0;
    await expect(exerciseHomePwaChromiumAcceptanceForTests({
      launch: operation("launch"),
      pair: operation("pair"),
      assertReadiness: operation("readiness"),
      controlServiceWorker: operation("service-worker"),
      assertOfflineShell: operation("offline-shell"),
      saveLocalCapture: async () => {
        events.push("local-capture");
        throw new Error("dome_csrf.secret /private/vault");
      },
      revoke: operation("revoke"),
      repairAuthentication: operation("auth-repair"),
      assertReplay: operation("replay"),
      emergencyClose: operation("emergency-close"),
      close: operation("cleanup"),
    })).rejects.toThrow("installed Home Chromium acceptance failed at local-capture");
    expect(events).toEqual([
      "launch", "pair", "readiness", "service-worker", "offline-shell", "local-capture", "cleanup",
    ]);

    events.length = 0;
    await expect(exerciseHomePwaChromiumAcceptanceForTests({
      launch: async () => { events.push("partial-launch"); throw new Error("private Chrome path"); },
      pair: operation("pair"),
      assertReadiness: operation("readiness"),
      controlServiceWorker: operation("service-worker"),
      assertOfflineShell: operation("offline-shell"),
      saveLocalCapture: operation("local-capture"),
      revoke: operation("revoke"),
      repairAuthentication: operation("auth-repair"),
      assertReplay: operation("replay"),
      emergencyClose: operation("emergency-close"),
      close: operation("cleanup"),
    })).rejects.toThrow(
      "launch or initial shell failed; verify the installed Google Chrome stable channel and Home, then retry",
    );
    expect(events).toEqual(["partial-launch", "cleanup"]);

    events.length = 0;
    await expect(exerciseHomePwaChromiumAcceptanceForTests({
      launch: operation("launch"),
      pair: operation("pair"),
      assertReadiness: async () => { events.push("readiness"); throw new Error("secret readiness"); },
      controlServiceWorker: operation("service-worker"),
      assertOfflineShell: operation("offline-shell"),
      saveLocalCapture: operation("local-capture"),
      revoke: operation("revoke"),
      repairAuthentication: operation("auth-repair"),
      assertReplay: operation("replay"),
      emergencyClose: operation("emergency-close"),
      close: async () => { events.push("cleanup"); throw new Error("private cleanup path"); },
    })).rejects.toThrow("installed Home Chromium acceptance failed at readiness; cleanup also failed");
    expect(events).toEqual(["launch", "pair", "readiness", "cleanup"]);

    events.length = 0;
    await expect(exerciseHomePwaChromiumAcceptanceForTests({
      launch: operation("launch"),
      pair: async (signal) => await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          events.push("abort");
          queueMicrotask(() => {
            events.push("settled");
            resolve();
          });
        }, { once: true });
      }),
      assertReadiness: operation("readiness"),
      controlServiceWorker: operation("service-worker"),
      assertOfflineShell: operation("offline-shell"),
      saveLocalCapture: operation("local-capture"),
      revoke: operation("revoke"),
      repairAuthentication: operation("auth-repair"),
      assertReplay: operation("replay"),
      emergencyClose: operation("emergency-close"),
      close: operation("cleanup"),
    }, { phaseMs: 5, cleanupMs: 5 })).rejects.toThrow("installed Home Chromium acceptance failed at pair");
    expect(events).toEqual(["launch", "abort", "emergency-close", "settled", "cleanup"]);
  });

  test("SIGKILLs and drains an aborted installed Chromium child", async () => {
    const controller = new AbortController();
    const running = exerciseAbortableInstalledCommandForTests(controller.signal);
    setTimeout(() => controller.abort(), 10);
    await expect(running).rejects.toThrow("installed Chromium acceptance command aborted");
  });

  test("strictly binds the exported offline capture identity", () => {
    const captureId = "11111111-1111-4111-8111-111111111111";
    const text = "Dome installed Chromium offline capture canary";
    const exported = (capture: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      Buffer.from(JSON.stringify({
        schema: "dome.capture-queue/v1",
        exported_at: "2026-07-15T12:00:00.000Z",
        captures: [capture],
        ...extra,
      }));
    const capture = {
      id: captureId,
      text,
      createdAt: "2026-07-15T12:00:00.000Z",
      state: "saved-locally",
      attempts: 0,
    };
    expect(parseHomePwaCaptureExportForTests(exported(capture), text)).toBe(captureId);
    expect(() => parseHomePwaCaptureExportForTests(exported({ ...capture, id: "not-a-uuid" }), text))
      .toThrow("item is invalid");
    expect(() => parseHomePwaCaptureExportForTests(exported(capture, { secret: true }), text))
      .toThrow("fields are invalid");
    expect(() => parseHomePwaCaptureExportForTests(Buffer.alloc(64 * 1024 + 1), text))
      .toThrow("size is invalid");
  });

  test("refuses non-files, oversize input, and predecessor size drift before archive reads", () => {
    expect(() => assertBoundedArchiveStatForTests({ isFile: true, size: 10 }, 10, 10)).not.toThrow();
    expect(() => assertBoundedArchiveStatForTests({ isFile: false, size: 10 }, 10)).toThrow("bounded regular file");
    expect(() => assertBoundedArchiveStatForTests({ isFile: true, size: 11 }, 10)).toThrow("bounded regular file");
    expect(() => assertBoundedArchiveStatForTests({ isFile: true, size: 9 }, 10, 10)).toThrow("immutable receipt");
  });

  test("requires the launchd label, Home port, and Product Host ownership to drain", () => {
    expect(classifyInstalledHomeDrainForTests(0, 0, false, false)).toBe("pending");
    expect(classifyInstalledHomeDrainForTests(0, 113, false, false)).toBe("pending");
    expect(classifyInstalledHomeDrainForTests(0, 113, true, false)).toBe("pending");
    expect(classifyInstalledHomeDrainForTests(0, 113, true, true)).toBe("drained");
    expect(classifyInstalledHomeDrainForTests(3, 113, true, true)).toBe("drained");
    expect(() => classifyInstalledHomeDrainForTests(3, 0, false, false)).toThrow("without absent print proof");
    expect(() => classifyInstalledHomeDrainForTests(113, 113, false, false)).toThrow("bootout failed");
    expect(() => classifyInstalledHomeDrainForTests(0, 3, false, false)).toThrow("print failed");
  });

  test("renders bounded recursive coordination diagnostics without secrets", () => {
    const error = new AggregateError([
      new Error("terminal dome_csrf.abc- inner Bearer abc+DEF/ghi==, after"),
      new Error(
        "csrf dome_csrf.mUc9houYvJlhJBTZqI5tweTbcJFEucu_QUQTmKSqTZw " +
          "credential dome_cred.CTl4LDmCa7J6AvU4nnVtZQ.LJXJLpi2Hwpu0rMflghz6c10uRWJGKPSEu7W5J4y9N8 " +
          "x".repeat(3_000),
      ),
    ], "outer failure");
    const rendered = renderInstalledCoordinationErrorForTests(error);
    expect(rendered.startsWith(
      "AggregateError: outer failure | nested: Error: terminal [REDACTED] inner Bearer [REDACTED], after | " +
        "nested: Error: csrf [REDACTED] credential [REDACTED] ",
    )).toBeTrue();
    expect(rendered).not.toContain("dome_cred");
    expect(rendered).not.toContain("dome_csrf");
    expect(rendered).not.toContain("abc-");
    expect(rendered).not.toContain("abc+DEF/ghi==");
    expect(rendered.length).toBe(2_048);
    const embedded = Function(`return (${renderInstalledCoordinationErrorForTests.toString()});`)() as
      ((error: unknown) => string);
    expect(embedded(error)).toBe(rendered);
    expect(embedded(error)).not.toContain("dome_csrf");
    expect(embedded(error)).not.toContain("abc-");
    expect(embedded(error)).not.toContain("abc+DEF/ghi==");
    expect(renderInstalledCoordinationErrorForTests({ private: "value" }))
      .toBe("Non-Error coordination failure");
  });

  test("renders only bounded allowlisted retained ownership state", () => {
    const operationId = "11111111-1111-4111-8111-111111111111";
    expect(retainedCheckpointOwnershipSummaryForTests({
      lifecycle: {
        state: "active", phase: "suspended", purpose: "upgrade", operationId,
        error: "dome_csrf.must-not-leak",
      },
      upgrade: {
        state: "unavailable", operationId: "dome_cred.must-not-leak", outcome: null,
        nextAction: "inspect-home-status", error: "Bearer must-not-leak",
      },
    })).toBe(JSON.stringify({
      lifecycle: { state: "active", phase: "suspended", purpose: "upgrade", operationId },
      upgrade: { state: "unavailable", operationId: null, outcome: null, nextAction: "inspect-home-status" },
    }));
  });

  test("requires exact phase-specific retained lifecycle and upgrade ownership", () => {
    const transactionId = "11111111-1111-4111-8111-111111111111";
    const status = (
      state: "active" | "complete",
      outcome: null | "committed",
      nextAction: "retry-recovery" | "none",
    ) => ({
      lifecycle: {
        state: "active", phase: "suspended", purpose: "upgrade", operationId: transactionId,
      },
      upgrade: { state, operationId: transactionId, outcome, nextAction },
    });
    const switching = status("active", null, "retry-recovery");
    const committed = status("complete", "committed", "none");

    expect(retainedCheckpointOwnershipMatchesForTests(switching, "switching", transactionId)).toBeTrue();
    expect(retainedCheckpointOwnershipMatchesForTests(committed, "committed", transactionId)).toBeTrue();
    expect(retainedCheckpointOwnershipMatchesForTests(committed, "switching", transactionId)).toBeFalse();
    expect(retainedCheckpointOwnershipMatchesForTests(switching, "committed", transactionId)).toBeFalse();
    expect(retainedCheckpointOwnershipMatchesForTests({
      ...switching,
      lifecycle: { ...switching.lifecycle, operationId: "22222222-2222-4222-8222-222222222222" },
    }, "switching", transactionId)).toBeFalse();
    expect(retainedCheckpointOwnershipMatchesForTests({
      ...committed,
      upgrade: { ...committed.upgrade, nextAction: "retry-recovery" },
    }, "committed", transactionId)).toBeFalse();
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
