import { describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  assertInstalledBackupRestoreCanaryForTests,
  assertPredecessorReadyObserverForTests,
  awaitPredecessorInstallForTests,
  canonicalizeInstalledScenarioRootForTests,
  classifyPredecessorInstallForTests,
  classifyInstalledHomeDrainForTests,
  exerciseAbortableInstalledCommandForTests,
  exerciseInstalledUpgradeOrchestrationForTests,
  exercisePredecessorInstallTimeoutForTests,
  hasExactHomePwaCaptureIdentityForTests,
  pairedDeviceIdForTests,
  parseHomePwaRevisionGrepPathsForTests,
  predecessorHomeInstallInvocationForTests,
  retainedCheckpointOwnershipMatchesForTests,
  renderInstalledCoordinationErrorForTests,
  removeInstalledScenarioRootForTests,
  removeInstalledTemporaryRootForTests,
  retainedCheckpointOwnershipSummaryForTests,
  type InstalledHomeUpgradeRehearsalInput,
  type InstalledHomeUpgradeScenario,
} from "../../scripts/home-installed-upgrade-rehearsal";
import { renderInstalledFunctionalCanary } from "../../scripts/home-installed-functional-closure";
import {
  assertInstalledHomeConnectionEvidenceForTests,
  classifyHomePwaReplayOutboxForTests,
  exerciseHomePwaLocalCaptureStageForTests,
  exerciseHomePwaReplayStageForTests,
  exerciseHomePwaTaskSettlementStageForTests,
  exerciseHomePwaChromiumAcceptanceForTests,
  installedHomeConnectionEvidenceFailureForTests,
  parseHomePwaCaptureExportForTests,
  parseHomePwaSettlementReceiptForTests,
} from "../../scripts/home-pwa-chromium-acceptance";

const INSTALLED_READINESS = Object.freeze({
  schema: "dome.product.readiness/v1",
  productVersion: "0.4.0",
  artifactId: "artifact-test",
  writesAdmitted: true,
  contractVersions: Object.freeze(["dome.product.readiness/v1"]),
  assetVersion: "asset-test",
  vault: Object.freeze({ id: "vault-test", name: "work" }),
  device: Object.freeze({
    id: "device-test",
    name: "Dome installed Chromium acceptance",
    capabilities: Object.freeze(["read", "capture", "resolve"]),
  }),
  host: Object.freeze({ state: "ready", since: "2026-07-16T12:00:00.000Z" }),
  adoption: Object.freeze({
    state: "current",
    head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    adopted: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    lastSuccessAt: "2026-07-16T12:00:00.000Z",
  }),
  model: Object.freeze({ state: "unconfigured" }),
  transcription: Object.freeze({ state: "unconfigured" }),
  nextActions: Object.freeze([]),
});

describe("installed Chromium core-readiness evidence", () => {
  const expected = Object.freeze({
    productVersion: "0.4.0",
    vaultName: "work",
    deviceName: "Dome installed Chromium acceptance",
  });

  test("accepts an honest limited label when only the optional model is unconfigured", () => {
    expect(assertInstalledHomeConnectionEvidenceForTests({
      summaryText: "Connection · limited",
      readiness: INSTALLED_READINESS,
      expected,
    })).toBe(INSTALLED_READINESS);
  });

  test("rejects false green, non-current core state, and identity drift", () => {
    expect(() => assertInstalledHomeConnectionEvidenceForTests({
      summaryText: "Connection · ready",
      readiness: INSTALLED_READINESS,
      expected,
    })).toThrow("does not match ready core truth");
    expect(installedHomeConnectionEvidenceFailureForTests({
      summaryText: "Connection · ready",
      readiness: INSTALLED_READINESS,
      expected,
    })).toBe("summary");
    expect(installedHomeConnectionEvidenceFailureForTests({
      summaryText: "Connection · limited",
      readiness: { ...INSTALLED_READINESS, adoption: { ...INSTALLED_READINESS.adoption, state: "pending" } },
      expected,
    })).toBe("core-state");
    expect(() => assertInstalledHomeConnectionEvidenceForTests({
      summaryText: "Connection · limited",
      readiness: { ...INSTALLED_READINESS, adoption: { ...INSTALLED_READINESS.adoption, state: "pending" } },
      expected,
    })).toThrow("does not match ready core truth");
    expect(() => assertInstalledHomeConnectionEvidenceForTests({
      summaryText: "Connection · limited",
      readiness: INSTALLED_READINESS,
      expected: { ...expected, vaultName: "wrong" },
    })).toThrow("does not match ready core truth");
  });
});

const INPUT: InstalledHomeUpgradeRehearsalInput = Object.freeze({
  predecessorArchive: "/synthetic/predecessor.tar.gz",
  candidateArchive: "/synthetic/candidate.tar.gz",
  frozenFixtureRoot: "/synthetic/fixture",
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

describe("installed rehearsal temporary-root removal", () => {
  test("removes one validated owned root and verifies absence", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-installed-upgrade-"));
    await mkdir(join(root, "nested", "payload"), { recursive: true });

    await removeInstalledTemporaryRootForTests(root);

    expect(await pathExists(root)).toBe(false);
  });

  test("rejects wrong-prefix, nested, path-trick, and symlink roots", async () => {
    const wrongPrefix = await mkdtemp(join(tmpdir(), "dome-installed-upgrades-"));
    const container = await mkdtemp(join(tmpdir(), "dome-installed-upgrade-"));
    const nested = await mkdtemp(join(container, "dome-installed-upgrade-"));
    const direct = await mkdtemp(join(tmpdir(), "dome-installed-upgrade-"));
    const detour = await mkdtemp(join(tmpdir(), "dome-cleanup-detour-"));
    const target = await mkdtemp(join(tmpdir(), "dome-cleanup-target-"));
    const alias = join(tmpdir(), `dome-installed-upgrade-alias-${Date.now()}`);
    await symlink(target, alias);
    try {
      for (const unsafe of [
        wrongPrefix,
        nested,
        `${detour}/../${basename(direct)}`,
        alias,
      ]) {
        await expect(removeInstalledTemporaryRootForTests(unsafe)).rejects.toThrow(
          "installed rehearsal temporary root is unsafe",
        );
      }
      expect(await pathExists(wrongPrefix)).toBe(true);
      expect(await pathExists(nested)).toBe(true);
      expect(await pathExists(direct)).toBe(true);
      expect(await pathExists(alias)).toBe(true);
    } finally {
      await rm(alias, { force: true });
      await rm(wrongPrefix, { recursive: true, force: true });
      await rm(container, { recursive: true, force: true });
      await rm(direct, { recursive: true, force: true });
      await rm(detour, { recursive: true, force: true });
      await rm(target, { recursive: true, force: true });
    }
  });

  test("retains the root when the bounded remover fails, lies, is missing, or times out", async () => {
    const nonzeroRoot = await mkdtemp(join(tmpdir(), "dome-installed-upgrade-"));
    const unchangedRoot = await mkdtemp(join(tmpdir(), "dome-installed-upgrade-"));
    const missingRoot = await mkdtemp(join(tmpdir(), "dome-installed-upgrade-"));
    const timeoutRoot = await mkdtemp(join(tmpdir(), "dome-installed-upgrade-"));
    try {
      await expect(removeInstalledTemporaryRootForTests(nonzeroRoot, {
        command: ["/usr/bin/false"],
        timeoutMs: 500,
      })).rejects.toThrow("installed rehearsal temporary cleanup command failed");
      expect(await pathExists(nonzeroRoot)).toBe(true);

      await expect(removeInstalledTemporaryRootForTests(unchangedRoot, {
        command: ["/usr/bin/true"],
        timeoutMs: 500,
      })).rejects.toThrow("installed rehearsal temporary cleanup command left the root present");
      expect(await pathExists(unchangedRoot)).toBe(true);

      await expect(removeInstalledTemporaryRootForTests(missingRoot, {
        command: [join(missingRoot, "missing-remover")],
        timeoutMs: 500,
      })).rejects.toThrow("installed rehearsal temporary cleanup command failed");
      expect(await pathExists(missingRoot)).toBe(true);

      await expect(removeInstalledTemporaryRootForTests(timeoutRoot, {
        command: ["/bin/sleep", "2"],
        timeoutMs: 20,
      })).rejects.toThrow("installed rehearsal temporary cleanup command timed out");
      expect(await pathExists(timeoutRoot)).toBe(true);
    } finally {
      await rm(nonzeroRoot, { recursive: true, force: true });
      await rm(unchangedRoot, { recursive: true, force: true });
      await rm(missingRoot, { recursive: true, force: true });
      await rm(timeoutRoot, { recursive: true, force: true });
    }
  });

  test("accepts a release-scale cleanup bound and rejects an unbounded one", async () => {
    const acceptedRoot = await mkdtemp(join(tmpdir(), "dome-installed-upgrade-"));
    const rejectedRoot = await mkdtemp(join(tmpdir(), "dome-installed-upgrade-"));
    try {
      await expect(removeInstalledTemporaryRootForTests(acceptedRoot, {
        command: ["/usr/bin/true"],
        timeoutMs: 30_001,
      })).rejects.toThrow("installed rehearsal temporary cleanup command left the root present");
      await expect(removeInstalledTemporaryRootForTests(rejectedRoot, {
        command: ["/usr/bin/true"],
        timeoutMs: 120_001,
      })).rejects.toThrow("installed rehearsal temporary cleanup timeout is invalid");
      expect(await pathExists(acceptedRoot)).toBe(true);
      expect(await pathExists(rejectedRoot)).toBe(true);
    } finally {
      await rm(acceptedRoot, { recursive: true, force: true });
      await rm(rejectedRoot, { recursive: true, force: true });
    }
  });
});

describe("installed rehearsal scenario-root removal", () => {
  test("removes one validated direct scenario child and verifies absence", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "dome-installed-upgrade-"));
    const scenario = await realpath(await mkdtemp(join(temporary, "ready-success-")));
    await mkdir(join(scenario, "nested", "payload"), { recursive: true });

    await removeInstalledScenarioRootForTests(scenario, temporary, "ready-success");

    expect(await pathExists(scenario)).toBe(false);
    await rm(temporary, { recursive: true, force: true });
  });

  test("rejects wrong-parent, nested, wrong-prefix, mismatched, path-trick, and symlink roots", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "dome-installed-upgrade-"));
    const otherTemporary = await mkdtemp(join(tmpdir(), "dome-installed-upgrade-"));
    const valid = await realpath(await mkdtemp(join(temporary, "ready-success-")));
    const nested = await realpath(await mkdtemp(join(valid, "ready-success-")));
    const wrongPrefix = join(await realpath(temporary), "ready-successes-abcdef");
    await mkdir(wrongPrefix);
    const alias = join(await realpath(temporary), "ready-success-alias");
    await symlink(valid, alias, "dir");
    const parentAlias = join(tmpdir(), `dome-installed-upgrade-parent-alias-${Date.now()}`);
    await symlink(temporary, parentAlias, "dir");
    const pathTrick = join(temporary, "..", basename(temporary), basename(valid));
    try {
      for (const [root, parent, scenario] of [
        [valid, otherTemporary, "ready-success"],
        [valid, parentAlias, "ready-success"],
        [nested, temporary, "ready-success"],
        [wrongPrefix, temporary, "ready-success"],
        [valid, temporary, "stopped-precommit-crash"],
        [pathTrick, temporary, "ready-success"],
        [alias, temporary, "ready-success"],
      ] as const) {
        await expect(removeInstalledScenarioRootForTests(root, parent, scenario)).rejects.toThrow(
          "installed rehearsal scenario root is unsafe",
        );
      }
      expect(await pathExists(valid)).toBe(true);
      expect(await pathExists(nested)).toBe(true);
      expect(await pathExists(wrongPrefix)).toBe(true);
      expect(await pathExists(alias)).toBe(true);
    } finally {
      await rm(alias, { force: true });
      await rm(parentAlias, { force: true });
      await rm(temporary, { recursive: true, force: true });
      await rm(otherTemporary, { recursive: true, force: true });
    }
  });

  test("retains a validated scenario root when the remover fails, lies, or times out", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "dome-installed-upgrade-"));
    const nonzero = await realpath(await mkdtemp(join(temporary, "ready-success-")));
    const unchanged = await realpath(await mkdtemp(join(temporary, "stopped-precommit-crash-")));
    const timeout = await realpath(await mkdtemp(join(temporary, "committed-exact-repair-")));
    const removerPid = join(timeout, "remover.pid");
    try {
      await expect(removeInstalledScenarioRootForTests(nonzero, temporary, "ready-success", {
        command: ["/usr/bin/false"],
        timeoutMs: 500,
      })).rejects.toThrow("installed rehearsal scenario cleanup command failed");
      expect(await pathExists(nonzero)).toBe(true);

      await expect(removeInstalledScenarioRootForTests(unchanged, temporary, "stopped-precommit-crash", {
        command: ["/usr/bin/true"],
        timeoutMs: 500,
      })).rejects.toThrow("installed rehearsal scenario cleanup command left the root present");
      expect(await pathExists(unchanged)).toBe(true);

      await expect(removeInstalledScenarioRootForTests(timeout, temporary, "committed-exact-repair", {
        command: [
          "/bin/sh",
          "-c",
          'echo "$$" > "$1"; exec /bin/sleep 60',
          "dome-remover-test",
          removerPid,
        ],
        timeoutMs: 200,
      })).rejects.toThrow("installed rehearsal scenario cleanup command timed out");
      expect(await pathExists(timeout)).toBe(true);
      const pidText = (await Bun.file(removerPid).text()).trim();
      expect(pidText).toMatch(/^[1-9][0-9]*$/);
      let probeError: unknown;
      try { process.kill(Number(pidText), 0); }
      catch (error) { probeError = error; }
      expect((probeError as NodeJS.ErrnoException | undefined)?.code).toBe("ESRCH");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});

describe("frozen predecessor install process bound", () => {
  test("kills, drains, and classifies its own command timeout", async () => {
    let failure: unknown;
    try {
      await exercisePredecessorInstallTimeoutForTests(
        [process.execPath, "-e", "await Bun.sleep(60_000)"],
        20,
      );
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    const message = failure instanceof Error ? failure.message : "";
    expect(message).toBe("frozen predecessor Home install command timed out");
    expect(message).not.toContain("installed Chromium acceptance command aborted");
  });
});

const PREDECESSOR_EXPECTED = Object.freeze({
  vault: "/scenario/vault",
  label: "com.dome.home.vault-12345678",
  plist: "/scenario/home/Library/LaunchAgents/com.dome.home.vault-12345678.plist",
  log: "/scenario/vault/.dome/state/home.log",
  program: "/scenario/releases/911d/app/bin/dome",
  installation: "/scenario/installations/vault-12345678/installation.json",
  release: "/scenario/releases/911d",
  artifactId: "911d5219bd5888f8a45fbfb0bbcf6da57b54e3a0ffcf8077bd2d843327747096",
  productVersion: "0.1.0",
});

function predecessorInstallDocument(kind: "ready" | "late-readiness"): Record<string, unknown> {
  return {
    schema: "dome.home.lifecycle/v1",
    action: "install",
    ...PREDECESSOR_EXPECTED,
    status: kind === "ready" ? "installed" : "error",
    installed: true,
    loaded: true,
    ready: kind === "ready",
    exitCode: kind === "ready" ? 0 : 1,
    replaced: false,
    releasePublished: true,
    ...(kind === "ready" ? {} : {
      error: "Dome Home did not become ready at http://127.0.0.1:3663/pair/status",
    }),
  };
}

function predecessorObserverDocument(): Record<string, unknown> {
  return {
    schema: "dome.home.lifecycle/v1",
    action: "status",
    ...PREDECESSOR_EXPECTED,
    status: "ready",
    installed: true,
    loaded: true,
    ready: true,
    exitCode: 0,
    lifecycle: { state: "inactive" },
    upgrade: { state: "inactive", candidate: null, operationId: null, outcome: null, nextAction: "none" },
  };
}

describe("installed Home upgrade portable orchestration (explicitly non-evidence)", () => {
  test("keeps the installed Chromium journey ordered, cleanup-closed, and non-evidence", async () => {
    const events: string[] = [];
    const operation = (name: string) => async (): Promise<void> => { events.push(name); };
    const result = await exerciseHomePwaChromiumAcceptanceForTests({
      launch: operation("launch"),
      assertInstallIdentity: operation("install-identity"),
      pair: operation("pair"),
      assertReadiness: operation("readiness"),
      assertAdaptiveAccessibility: operation("adaptive-accessibility"),
      controlServiceWorker: operation("service-worker"),
      assertActivitySource: operation("activity-source"),
      assertTaskSettlement: operation("task-settlement"),
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
      "launch", "install-identity", "pair", "readiness", "adaptive-accessibility", "service-worker", "activity-source", "task-settlement", "offline-shell",
      "local-capture", "revoke", "auth-repair", "replay", "cleanup",
    ]);

    events.length = 0;
    await expect(exerciseHomePwaChromiumAcceptanceForTests({
      launch: operation("launch"),
      assertInstallIdentity: operation("install-identity"),
      pair: operation("pair"),
      assertReadiness: operation("readiness"),
      assertAdaptiveAccessibility: operation("adaptive-accessibility"),
      controlServiceWorker: operation("service-worker"),
      assertActivitySource: async () => {
        events.push("activity-source");
        throw new Error("private source path");
      },
      assertTaskSettlement: operation("task-settlement"),
      assertOfflineShell: operation("offline-shell"),
      saveLocalCapture: operation("local-capture"),
      revoke: operation("revoke"),
      repairAuthentication: operation("auth-repair"),
      assertReplay: operation("replay"),
      emergencyClose: operation("emergency-close"),
      close: operation("cleanup"),
    })).rejects.toThrow("installed Home Chromium acceptance failed at activity-source");
    expect(events).toEqual([
      "launch", "install-identity", "pair", "readiness", "adaptive-accessibility", "service-worker", "activity-source", "cleanup",
    ]);

    events.length = 0;
    await expect(exerciseHomePwaChromiumAcceptanceForTests({
      launch: async () => { events.push("partial-launch"); throw new Error("private Chrome path"); },
      assertInstallIdentity: operation("install-identity"),
      pair: operation("pair"),
      assertReadiness: operation("readiness"),
      assertAdaptiveAccessibility: operation("adaptive-accessibility"),
      controlServiceWorker: operation("service-worker"),
      assertActivitySource: operation("activity-source"),
      assertTaskSettlement: operation("task-settlement"),
      assertOfflineShell: operation("offline-shell"),
      saveLocalCapture: operation("local-capture"),
      revoke: operation("revoke"),
      repairAuthentication: operation("auth-repair"),
      assertReplay: operation("replay"),
      emergencyClose: operation("emergency-close"),
      close: operation("cleanup"),
    })).rejects.toThrow(
      "launch failed; verify the installed Google Chrome stable channel, then retry",
    );
    expect(events).toEqual(["partial-launch", "cleanup"]);

    events.length = 0;
    let installError: unknown;
    try {
      await exerciseHomePwaChromiumAcceptanceForTests({
        launch: operation("launch"),
        assertInstallIdentity: async () => {
          events.push("install-identity");
          throw new Error("private shell path");
        },
        pair: operation("pair"),
        assertReadiness: operation("readiness"),
        assertAdaptiveAccessibility: operation("adaptive-accessibility"),
        controlServiceWorker: operation("service-worker"),
        assertActivitySource: operation("activity-source"),
        assertTaskSettlement: operation("task-settlement"),
        assertOfflineShell: operation("offline-shell"),
        saveLocalCapture: operation("local-capture"),
        revoke: operation("revoke"),
        repairAuthentication: operation("auth-repair"),
        assertReplay: operation("replay"),
        emergencyClose: operation("emergency-close"),
        close: operation("cleanup"),
      });
    } catch (error) { installError = error; }
    expect(installError).toBeInstanceOf(Error);
    expect((installError as Error).message).toBe("installed Home Chromium acceptance failed at install-identity");
    expect((installError as Error).message).not.toContain("private shell path");
    expect(events).toEqual(["launch", "install-identity", "cleanup"]);

    events.length = 0;
    await exerciseHomePwaChromiumAcceptanceForTests({
      launch: operation("launch"),
      assertInstallIdentity: operation("install-identity"),
      pair: operation("pair"),
      assertReadiness: operation("readiness"),
      assertAdaptiveAccessibility: operation("adaptive-accessibility"),
      controlServiceWorker: operation("service-worker"),
      assertActivitySource: operation("activity-source"),
      assertTaskSettlement: async () => { events.push("task-settlement"); await Bun.sleep(20); },
      assertOfflineShell: operation("offline-shell"),
      saveLocalCapture: operation("local-capture"),
      revoke: operation("revoke"),
      repairAuthentication: operation("auth-repair"),
      assertReplay: operation("replay"),
      emergencyClose: operation("emergency-close"),
      close: operation("cleanup"),
    }, { phaseMs: 5, taskSettlementPhaseMs: 100, cleanupMs: 50 });
    expect(events).toEqual([
      "launch", "install-identity", "pair", "readiness", "adaptive-accessibility", "service-worker", "activity-source", "task-settlement", "offline-shell",
      "local-capture", "revoke", "auth-repair", "replay", "cleanup",
    ]);

    events.length = 0;
    await expect(exerciseHomePwaChromiumAcceptanceForTests({
      launch: operation("launch"),
      assertInstallIdentity: operation("install-identity"),
      pair: operation("pair"),
      assertReadiness: async () => { events.push("readiness"); throw new Error("secret readiness"); },
      assertAdaptiveAccessibility: operation("adaptive-accessibility"),
      controlServiceWorker: operation("service-worker"),
      assertActivitySource: operation("activity-source"),
      assertTaskSettlement: operation("task-settlement"),
      assertOfflineShell: operation("offline-shell"),
      saveLocalCapture: operation("local-capture"),
      revoke: operation("revoke"),
      repairAuthentication: operation("auth-repair"),
      assertReplay: operation("replay"),
      emergencyClose: operation("emergency-close"),
      close: async () => { events.push("cleanup"); throw new Error("private cleanup path"); },
    })).rejects.toThrow("installed Home Chromium acceptance failed at readiness; cleanup also failed");
    expect(events).toEqual(["launch", "install-identity", "pair", "readiness", "cleanup"]);

    events.length = 0;
    await expect(exerciseHomePwaChromiumAcceptanceForTests({
      launch: operation("launch"),
      assertInstallIdentity: operation("install-identity"),
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
      assertAdaptiveAccessibility: operation("adaptive-accessibility"),
      controlServiceWorker: operation("service-worker"),
      assertActivitySource: operation("activity-source"),
      assertTaskSettlement: operation("task-settlement"),
      assertOfflineShell: operation("offline-shell"),
      saveLocalCapture: operation("local-capture"),
      revoke: operation("revoke"),
      repairAuthentication: operation("auth-repair"),
      assertReplay: operation("replay"),
      emergencyClose: operation("emergency-close"),
      close: operation("cleanup"),
    }, { phaseMs: 5, taskSettlementPhaseMs: 100, cleanupMs: 5 })).rejects.toThrow("installed Home Chromium acceptance failed at pair");
    expect(events).toEqual(["launch", "install-identity", "abort", "emergency-close", "settled", "cleanup"]);
  });

  test("reports only allowlisted adaptive diagnostics and distinguishes a bounded timeout", async () => {
    const operation = async (): Promise<void> => {};
    const journey = (adaptive: (signal: AbortSignal) => Promise<void>) => ({
      launch: operation,
      assertInstallIdentity: operation,
      pair: operation,
      assertReadiness: operation,
      assertAdaptiveAccessibility: adaptive,
      controlServiceWorker: operation,
      assertActivitySource: operation,
      assertTaskSettlement: operation,
      assertOfflineShell: operation,
      saveLocalCapture: operation,
      revoke: operation,
      repairAuthentication: operation,
      assertReplay: operation,
      emergencyClose: operation,
      close: operation,
    });
    const failure = async (
      adaptive: (signal: AbortSignal) => Promise<void>,
      deadlines?: { phaseMs: number; cleanupMs: number },
    ): Promise<string> => {
      try {
        await exerciseHomePwaChromiumAcceptanceForTests(journey(adaptive), deadlines);
        throw new Error("expected adaptive acceptance failure");
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };

    const classified = await failure(async () => {
      throw new Error("installed PWA connection diagnostics did not receive keyboard focus at 320x568");
    });
    expect(classified).toBe(
      "installed Home Chromium acceptance failed at adaptive-accessibility [diagnostics-focus@320x568]",
    );

    const collapsed = await failure(async () => {
      throw new Error("installed PWA connection diagnostics are not visibly usable at 844x390");
    });
    expect(collapsed).toBe(
      "installed Home Chromium acceptance failed at adaptive-accessibility [diagnostics-viewport@844x390]",
    );

    const secret = "private pairing code and vault path";
    const hidden = await failure(async () => { throw new Error(secret); });
    expect(hidden).toBe("installed Home Chromium acceptance failed at adaptive-accessibility [unclassified]");
    expect(hidden).not.toContain(secret);

    const timedOut = await failure(async (signal) => await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    }), { phaseMs: 5, cleanupMs: 50 });
    expect(timedOut).toBe("installed Home Chromium acceptance failed at adaptive-accessibility [phase-timeout]");
  });

  test("reports only fixed task-settlement stages and hides underlying failures", async () => {
    const operation = async (): Promise<void> => {};
    const journey = (settle: (signal: AbortSignal) => Promise<void>) => ({
      launch: operation,
      assertInstallIdentity: operation,
      pair: operation,
      assertReadiness: operation,
      assertAdaptiveAccessibility: operation,
      controlServiceWorker: operation,
      assertActivitySource: operation,
      assertTaskSettlement: settle,
      assertOfflineShell: operation,
      saveLocalCapture: operation,
      revoke: operation,
      repairAuthentication: operation,
      assertReplay: operation,
      emergencyClose: operation,
      close: operation,
    });
    const failure = async (
      settle: (signal: AbortSignal) => Promise<void>,
      deadlines?: { phaseMs: number; taskSettlementPhaseMs: number; cleanupMs: number },
    ): Promise<string> => {
      try {
        await exerciseHomePwaChromiumAcceptanceForTests(journey(settle), deadlines);
        throw new Error("expected task settlement failure");
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };

    const secret = "private task text and vault path";
    for (const stage of ["submit", "closure", "reload", "removal"] as const) {
      const message = await failure(async () => {
        await exerciseHomePwaTaskSettlementStageForTests(stage, async () => {
          throw new Error(secret);
        });
      });
      expect(message).toBe(
        `installed Home Chromium acceptance failed at task-settlement [${stage}]`,
      );
      expect(message).not.toContain(secret);
    }

    const maliciousStage = await failure(async () => {
      await exerciseHomePwaTaskSettlementStageForTests(secret as never, async () => {
        throw new Error(secret);
      });
    });
    expect(maliciousStage).toBe(
      "installed Home Chromium acceptance failed at task-settlement [unclassified]",
    );
    expect(maliciousStage).not.toContain(secret);

    const unclassified = await failure(async () => { throw new Error(secret); });
    expect(unclassified).toBe(
      "installed Home Chromium acceptance failed at task-settlement [unclassified]",
    );
    expect(unclassified).not.toContain(secret);

    const timedOut = await failure(async (signal) => await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    }), { phaseMs: 50, taskSettlementPhaseMs: 5, cleanupMs: 50 });
    expect(timedOut).toBe(
      "installed Home Chromium acceptance failed at task-settlement [phase-timeout]",
    );
  });

  test("reports only fixed local-capture stages and hides underlying failures", async () => {
    const operation = async (): Promise<void> => {};
    const journey = (capture: (signal: AbortSignal) => Promise<void>) => ({
      launch: operation,
      assertInstallIdentity: operation,
      pair: operation,
      assertReadiness: operation,
      assertAdaptiveAccessibility: operation,
      controlServiceWorker: operation,
      assertActivitySource: operation,
      assertTaskSettlement: operation,
      assertOfflineShell: operation,
      saveLocalCapture: capture,
      revoke: operation,
      repairAuthentication: operation,
      assertReplay: operation,
      emergencyClose: operation,
      close: operation,
    });
    const failure = async (
      capture: (signal: AbortSignal) => Promise<void>,
      deadlines?: { phaseMs: number; cleanupMs: number },
    ): Promise<string> => {
      try {
        await exerciseHomePwaChromiumAcceptanceForTests(journey(capture), deadlines);
        throw new Error("expected local capture failure");
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };

    const secret = "private capture text and downloaded bytes";
    for (const stage of ["save", "outbox", "export"] as const) {
      const message = await failure(async () => {
        await exerciseHomePwaLocalCaptureStageForTests(stage, async () => {
          throw new Error(secret);
        });
      });
      expect(message).toBe(
        `installed Home Chromium acceptance failed at local-capture [${stage}]`,
      );
      expect(message).not.toContain(secret);
    }

    const maliciousStage = await failure(async () => {
      await exerciseHomePwaLocalCaptureStageForTests(secret as never, async () => {
        throw new Error(secret);
      });
    });
    expect(maliciousStage).toBe(
      "installed Home Chromium acceptance failed at local-capture [unclassified]",
    );
    expect(maliciousStage).not.toContain(secret);

    const unclassified = await failure(async () => { throw new Error(secret); });
    expect(unclassified).toBe(
      "installed Home Chromium acceptance failed at local-capture [unclassified]",
    );
    expect(unclassified).not.toContain(secret);
    const nonError = await failure(async () => { throw secret; });
    expect(nonError).toBe(
      "installed Home Chromium acceptance failed at local-capture [unclassified]",
    );
    expect(nonError).not.toContain(secret);

    const timedOut = await failure(async (signal) => await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    }), { phaseMs: 5, cleanupMs: 50 });
    expect(timedOut).toBe(
      "installed Home Chromium acceptance failed at local-capture [phase-timeout]",
    );
  });

  test("reports only fixed replay stages and hides underlying failures", async () => {
    const operation = async (): Promise<void> => {};
    const journey = (replay: (signal: AbortSignal) => Promise<void>) => ({
      launch: operation,
      assertInstallIdentity: operation,
      pair: operation,
      assertReadiness: operation,
      assertAdaptiveAccessibility: operation,
      controlServiceWorker: operation,
      assertActivitySource: operation,
      assertTaskSettlement: operation,
      assertOfflineShell: operation,
      saveLocalCapture: operation,
      revoke: operation,
      repairAuthentication: operation,
      assertReplay: replay,
      emergencyClose: operation,
      close: operation,
    });
    const failure = async (
      replay: (signal: AbortSignal) => Promise<void>,
      deadlines?: { phaseMs: number; cleanupMs: number },
    ): Promise<string> => {
      try {
        await exerciseHomePwaChromiumAcceptanceForTests(journey(replay), deadlines);
        throw new Error("expected replay failure");
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };

    const secret = "private capture text, identity, and vault path";
    for (const stage of ["outbox", "logical-capture"] as const) {
      const message = await failure(async () => {
        await exerciseHomePwaReplayStageForTests(stage, async () => {
          throw new Error(secret);
        });
      });
      expect(message).toBe(`installed Home Chromium acceptance failed at replay [${stage}]`);
      expect(message).not.toContain(secret);
    }

    const observed = await failure(async () => {
      await exerciseHomePwaReplayStageForTests("outbox", async () => {
        throw new Error(secret);
      }, "outbox:sending:one:request-started:no-response");
    });
    expect(observed).toBe(
      "installed Home Chromium acceptance failed at replay [outbox:sending:one:request-started:no-response]",
    );
    expect(observed).not.toContain(secret);

    const malicious = await failure(async () => {
      await exerciseHomePwaReplayStageForTests("outbox", async () => {
        throw new Error(secret);
      }, secret as never);
    });
    expect(malicious).toBe("installed Home Chromium acceptance failed at replay [unclassified]");
    expect(malicious).not.toContain(secret);

    const maliciousStage = await failure(async () => {
      await exerciseHomePwaReplayStageForTests(secret as never, async () => {
        throw new Error(secret);
      });
    });
    expect(maliciousStage).toBe("installed Home Chromium acceptance failed at replay [unclassified]");
    expect(maliciousStage).not.toContain(secret);

    const unclassified = await failure(async () => { throw new Error(secret); });
    expect(unclassified).toBe("installed Home Chromium acceptance failed at replay [unclassified]");
    expect(unclassified).not.toContain(secret);
    const nonError = await failure(async () => { throw secret; });
    expect(nonError).toBe("installed Home Chromium acceptance failed at replay [unclassified]");
    expect(nonError).not.toContain(secret);

    const timedOut = await failure(async (signal) => await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    }), { phaseMs: 5, cleanupMs: 50 });
    expect(timedOut).toBe("installed Home Chromium acceptance failed at replay [phase-timeout]");
  });

  test("classifies replay outbox evidence with closed content-free categories", () => {
    expect(classifyHomePwaReplayOutboxForTests({
      state: "sending",
      attemptCategory: "one",
      requests: 1,
      responses: 0,
    })).toBe("outbox:sending:one:request-started:no-response");
    expect(classifyHomePwaReplayOutboxForTests({
      state: "private capture text",
      attemptCategory: "private id",
      requests: 0,
      responses: 0,
    })).toBe("outbox:unknown:unknown:no-request:no-response");
    expect(classifyHomePwaReplayOutboxForTests({
      state: null,
      attemptCategory: null,
      requests: 0,
      responses: 2,
    })).toBe("outbox:absent:unknown:no-request:response-received");
  });

  test("parses one immutable-revision grep path without treating the revision as a directory", () => {
    const revision = "a".repeat(40);
    expect(parseHomePwaRevisionGrepPathsForTests(
      `${revision}:inbox/raw/replayed capture.md\0`,
      revision,
    )).toEqual(["inbox/raw/replayed capture.md"]);
    expect(parseHomePwaRevisionGrepPathsForTests("", revision)).toEqual([]);
    expect(parseHomePwaRevisionGrepPathsForTests(
      `${revision}:inbox/raw/one.md\0${revision}:inbox/raw/two.md\0`,
      revision,
    )).toEqual(["inbox/raw/one.md", "inbox/raw/two.md"]);
    expect(() => parseHomePwaRevisionGrepPathsForTests(
      `HEAD:inbox/raw/replayed.md\0`,
      revision,
    )).toThrow("path inventory is malformed");
    expect(() => parseHomePwaRevisionGrepPathsForTests(`${revision}:\0`, revision))
      .toThrow("path inventory is malformed");
    expect(() => parseHomePwaRevisionGrepPathsForTests(
      `${revision}:inbox/raw/replayed.md\n`,
      revision,
    )).toThrow("path inventory is malformed");
    expect(() => parseHomePwaRevisionGrepPathsForTests("", "HEAD"))
      .toThrow("revision is invalid");
  });

  test("SIGKILLs and drains an aborted installed Chromium child", async () => {
    const controller = new AbortController();
    const running = exerciseAbortableInstalledCommandForTests(controller.signal);
    setTimeout(() => controller.abort(), 10);
    await expect(running).rejects.toThrow("installed Chromium acceptance command aborted");
  });

  test("accepts one capture identity across canonical YAML quote removal", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(hasExactHomePwaCaptureIdentityForTests(`---\ncapture_id: ${JSON.stringify(id)}\n---\n`, id)).toBe(true);
    expect(hasExactHomePwaCaptureIdentityForTests(`---\ncapture_id: ${id}\n---\n`, id)).toBe(true);
    expect(hasExactHomePwaCaptureIdentityForTests(`---\ncapture_id: ${id}\ncapture_id: ${id}\n---\n`, id)).toBe(false);
    expect(hasExactHomePwaCaptureIdentityForTests("capture_id: another-id\n", id)).toBe(false);
    expect(hasExactHomePwaCaptureIdentityForTests(`capture_id: ${id}\n`, "not-a-uuid")).toBe(false);
    expect(hasExactHomePwaCaptureIdentityForTests(`---\nsource: pwa\n---\ncapture_id: ${id}\n`, id)).toBe(false);
    expect(hasExactHomePwaCaptureIdentityForTests(
      `---\ncapture_id: ${id}\n---\nbody\ncapture_id: ${id}\n`,
      id,
    )).toBe(true);
    expect(hasExactHomePwaCaptureIdentityForTests(`---\ncapture_id: ${id}\n`, id)).toBe(false);
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
      vaultId: null,
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

  test("renders one deterministic due-today functional canary with an ordinary stable anchor", () => {
    const canary = renderInstalledFunctionalCanary("2026-07-15");
    expect(canary).toEqual({
      path: "notes/installed-functional-canary.md",
      title: "Installed functional closure canary",
      taskText: "Close the installed functional closure canary",
      blockId: "tinstalledfunctional",
      sourceMarker: "Dome installed functional source marker",
      content: [
        "# Installed functional closure canary",
        "",
        "Dome installed functional source marker",
        "",
        "- [ ] #task Close the installed functional closure canary 📅 2026-07-15 ^tinstalledfunctional",
        "",
      ].join("\n"),
    });
    expect(() => renderInstalledFunctionalCanary("July 15"))
      .toThrow("functional canary date is invalid");
  });

  test("strictly binds the installed settlement receipt to one close commit", () => {
    const commit = "a".repeat(40);
    const blockId = "tinstalledfunctional";
    const receipt = {
      schema: "dome.settle/v1",
      status: "settled",
      block_id: blockId,
      disposition: "close",
      commit,
    };
    expect(parseHomePwaSettlementReceiptForTests(receipt, blockId)).toBe(commit);
    for (const hostile of [
      { ...receipt, block_id: "tother" },
      { ...receipt, disposition: "keep" },
      { ...receipt, commit: "not-a-commit" },
      { schema: receipt.schema, status: receipt.status, block_id: blockId, disposition: "close" },
      { ...receipt, extra: true },
    ]) {
      expect(() => parseHomePwaSettlementReceiptForTests(hostile, blockId))
        .toThrow("settlement receipt is not exact");
    }
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

  test("classifies only exact immediate and immutable-N-1 late install outcomes", () => {
    expect(classifyPredecessorInstallForTests(
      { exitCode: 0, document: predecessorInstallDocument("ready") },
      PREDECESSOR_EXPECTED,
    )).toBe("ready");
    expect(classifyPredecessorInstallForTests(
      { exitCode: 1, document: predecessorInstallDocument("late-readiness") },
      PREDECESSOR_EXPECTED,
    )).toBe("late-readiness");
  });

  test("rejects mismatched process/document exits, identity, paths, and document shape", () => {
    const ready = predecessorInstallDocument("ready");
    const late = predecessorInstallDocument("late-readiness");
    for (const outcome of [
      { exitCode: 1, document: ready },
      { exitCode: 0, document: late },
      { exitCode: 1, document: { ...late, exitCode: 0 } },
      { exitCode: 1, document: { ...late, artifactId: "a".repeat(64) } },
      { exitCode: 1, document: { ...late, plist: "/other/LaunchAgent.plist" } },
      { exitCode: 1, document: { ...late, unexpected: true } },
      { exitCode: 1, document: Object.fromEntries(Object.entries(late).filter(([key]) => key !== "program")) },
    ]) {
      expect(() => classifyPredecessorInstallForTests(outcome, PREDECESSOR_EXPECTED))
        .toThrow("unsupported lifecycle outcome");
    }
    const wrongVersion = { ...PREDECESSOR_EXPECTED, productVersion: "0.1.1" };
    expect(() => classifyPredecessorInstallForTests(
      { exitCode: 1, document: { ...late, productVersion: "0.1.1" } },
      wrongVersion,
    )).toThrow("unsupported lifecycle outcome");
  });

  test("skips observation after exact normal readiness", async () => {
    let observed = false;
    await awaitPredecessorInstallForTests({
      classification: "ready",
      observe: async () => { observed = true; return true; },
    });
    expect(observed).toBeFalse();
  });

  test("bounds late readiness, retries nonready, and closes its abort signal", async () => {
    let attempts = 0;
    let observedSignal: AbortSignal | undefined;
    await awaitPredecessorInstallForTests({
      classification: "late-readiness",
      timeoutMs: 1_000,
      observe: async (signal) => {
        attempts++;
        observedSignal = signal;
        return attempts === 2;
      },
    });
    expect(attempts).toBe(2);
    expect(observedSignal?.aborted).toBeTrue();

    await expect(awaitPredecessorInstallForTests({
      classification: "late-readiness",
      timeoutMs: 10,
      observe: async () => false,
    })).rejects.toThrow("did not reach bounded late readiness");
    await expect(awaitPredecessorInstallForTests({
      classification: "late-readiness",
      timeoutMs: 10,
      observe: async () => await new Promise<boolean>(() => {}),
    })).rejects.toThrow("did not reach bounded late readiness");
    await expect(awaitPredecessorInstallForTests({
      classification: "late-readiness",
      timeoutMs: 30_001,
      observe: async () => true,
    })).rejects.toThrow("timeout is invalid");
  });

  test("requires the current observer to bind exact predecessor terminal truth", async () => {
    expect(() => assertPredecessorReadyObserverForTests(
      { exitCode: 0, document: predecessorObserverDocument() },
      PREDECESSOR_EXPECTED,
    )).not.toThrow();
    for (const outcome of [
      { exitCode: 1, document: predecessorObserverDocument() },
      { exitCode: 0, document: { ...predecessorObserverDocument(), artifactId: "a".repeat(64) } },
      { exitCode: 0, document: { ...predecessorObserverDocument(), label: "com.dome.home.wrong" } },
      { exitCode: 0, document: { ...predecessorObserverDocument(), ready: false } },
      { exitCode: 0, document: { ...predecessorObserverDocument(), lifecycle: { state: "active" } } },
      { exitCode: 0, document: { ...predecessorObserverDocument(), upgrade: { state: "active" } } },
    ]) {
      expect(() => assertPredecessorReadyObserverForTests(outcome, PREDECESSOR_EXPECTED)).toThrow();
    }

    await expect(awaitPredecessorInstallForTests({
      classification: "late-readiness",
      timeoutMs: 1_000,
      observe: async () => {
        assertPredecessorReadyObserverForTests(
          { exitCode: 0, document: { ...predecessorObserverDocument(), productVersion: "wrong" } },
          PREDECESSOR_EXPECTED,
        );
        return true;
      },
    })).rejects.toThrow("expected productVersion");
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

  test("preserves run, scenario-cleanup, and global-cleanup evidence in one bounded envelope", async () => {
    const events: string[] = [];
    let failure: unknown;
    try {
      await exerciseInstalledUpgradeOrchestrationForTests(INPUT, {
        prepare: async () => ({ token: "synthetic" }),
        runScenario: async (name) => {
          events.push(`run:${name}`);
          throw new Error(`run-fragment dome_cred.run-secret ${"r".repeat(3_000)}`);
        },
        cleanupScenario: async (name) => {
          events.push(`scenario-clean:${name}`);
          throw new Error(`scenario-cleanup-fragment Bearer scenario-secret ${"s".repeat(3_000)}`);
        },
        cleanup: async () => {
          events.push("clean:retained");
          throw new Error(`global-cleanup-fragment dome_csrf.global-secret ${"g".repeat(3_000)}`);
        },
      });
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    const message = failure instanceof Error ? failure.message : "";
    const run = message.indexOf("run-fragment");
    const scenarioCleanup = message.indexOf("scenario-cleanup-fragment");
    const globalCleanup = message.indexOf("global-cleanup-fragment");
    expect(run).toBeGreaterThanOrEqual(0);
    expect(scenarioCleanup).toBeGreaterThan(run);
    expect(globalCleanup).toBeGreaterThan(scenarioCleanup);
    expect(message).not.toContain("run-secret");
    expect(message).not.toContain("scenario-secret");
    expect(message).not.toContain("global-secret");
    expect(message.length).toBeLessThanOrEqual(2_048);
    const outer = failure instanceof Error ? failure.cause : null;
    expect(outer).toBeInstanceOf(AggregateError);
    const primary = outer instanceof AggregateError ? outer.errors[0] : null;
    expect(primary).toBeInstanceOf(AggregateError);
    expect(primary instanceof AggregateError ? primary.errors.map((error) => (error as Error).message.slice(0, 12)) : [])
      .toEqual(["run-fragment", "scenario-cle"]);
    expect(events).toEqual(["run:ready-success", "scenario-clean:ready-success", "clean:retained"]);
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
