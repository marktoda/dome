import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HomeArtifactManifest } from "../../src/product-host/home-artifact";
import {
  ensureManagedRelease,
  homeInstallationPaths,
} from "../../src/product-host/home-installation";
import {
  HomeUpgradeSelectionChangedError,
  type HomeUpgradeCutoverResult,
} from "../../src/product-host/home-upgrade-cutover";
import {
  manageHomeUpgrade,
  type HomeUpgradeIntentDeps,
} from "../../src/product-host/home-upgrade";
import type { HomeUpgradeTransaction } from "../../src/product-host/home-upgrade-transaction";

const TX = "11111111-1111-4111-8111-111111111111";
const RETAINED_TX = "22222222-2222-4222-8222-222222222222";
const OLD = "a".repeat(64);
const REQUESTED = "b".repeat(64);
const OTHER = "c".repeat(64);

describe("Home upgrade intent", () => {
  test("runs one verified candidate in closed order and returns only the public v1 shape", async () => {
    const f = intentFixture();
    const result = await manageHomeUpgrade({ action: "run", vaultPath: "/vault" }, f.deps);
    expect(result).toMatchObject({
      schema: "dome.home.upgrade/v1",
      operation: "upgrade",
      status: "upgraded",
      exitCode: 0,
      requestedArtifact: { artifactId: REQUESTED, productVersion: "2.0.0" },
      transaction: { operationId: TX, outcome: "committed" },
      selectedArtifact: { artifactId: REQUESTED, productVersion: "2.0.0" },
      recovered: false,
      service: "ready",
      reason: null,
      nextAction: "none",
    });
    expect(f.calls).toEqual([
      "canonicalize", "verify", "read-installation", "inspect-lifecycle", "read-active",
      "read-installation", "list-history", "publish", "uuid", "cutover", "retire",
    ]);
    expect(Object.keys(result)).toEqual([
      "schema", "operation", "status", "exitCode", "vault", "requestedArtifact",
      "transaction", "selectedArtifact", "recovered", "service", "reason", "message", "nextAction",
    ]);
    expect(JSON.stringify(result)).not.toContain("releasePath");
    expect(JSON.stringify(result)).not.toContain("snapshot");
    expect(JSON.stringify(result)).not.toContain('"phase"');
  });

  test("usage failures, current selection, and prior exact rollback allocate no operation", async () => {
    const invalidArtifact = intentFixture({ verifyError: new Error("manifest missing") });
    expect(await manageHomeUpgrade({ action: "run", vaultPath: "/vault" }, invalidArtifact.deps)).toMatchObject({
      exitCode: 64,
      requestedArtifact: null,
      reason: "preflight-failed",
    });
    expect(invalidArtifact.calls).not.toContain("read-installation");

    const missing = intentFixture({ selected: null });
    expect((await manageHomeUpgrade({ action: "run", vaultPath: "/vault" }, missing.deps)).exitCode).toBe(64);
    expect(missing.calls).not.toContain("publish");
    expect(missing.calls).not.toContain("uuid");

    const current = intentFixture({ selected: installation(REQUESTED, "2.0.0") });
    expect((await manageHomeUpgrade({ action: "run", vaultPath: "/vault" }, current.deps)).status).toBe("already-current");
    expect(current.calls).not.toContain("publish");
    expect(current.calls).not.toContain("uuid");

    const restored = transaction("restored", TX, REQUESTED);
    const prior = intentFixture({ history: [restored] });
    const priorResult = await manageHomeUpgrade({ action: "run", vaultPath: "/vault" }, prior.deps);
    expect(priorResult).toMatchObject({ status: "rolled-back", exitCode: 1, recovered: true });
    expect(prior.calls).not.toContain("publish");
    expect(prior.calls).not.toContain("uuid");
  });

  test("recovers an orphan lifecycle intent by its durable id before any publication", async () => {
    const f = intentFixture({ suspension: activeSuspension(RETAINED_TX), active: null });
    const first = await manageHomeUpgrade({ action: "run", vaultPath: "/vault" }, f.deps);
    expect(first).toMatchObject({
      status: "recovered-rerun-required",
      exitCode: 1,
      recovered: true,
      reason: "prior-attempt-recovered",
      nextAction: "rerun-requested-upgrade",
    });
    expect(f.recoveredIds).toEqual([RETAINED_TX]);
    expect(f.calls).not.toContain("publish");
    expect(f.calls).not.toContain("uuid");
    expect(f.calls).not.toContain("cutover");
  });

  test("disposes a different retained attempt once and requires a rerun", async () => {
    const retained = transaction("prepared", RETAINED_TX, OTHER);
    const f = intentFixture({ active: retained });
    const result = await manageHomeUpgrade({ action: "run", vaultPath: "/vault" }, f.deps);
    expect(result).toMatchObject({
      status: "recovered-rerun-required",
      exitCode: 1,
      transaction: { operationId: RETAINED_TX, candidate: { artifactId: OTHER }, outcome: "restored" },
      nextAction: "rerun-requested-upgrade",
    });
    expect(f.calls).toContain("restore");
    expect(f.calls).toContain("retire");
    expect(f.calls).not.toContain("publish");
    expect(f.calls).not.toContain("uuid");
    expect(f.calls).not.toContain("cutover");
  });

  test("retires inactive terminal housekeeping before starting a different candidate", async () => {
    for (const phase of ["restored", "committed"] as const) {
      const retained = transaction(phase, RETAINED_TX, OTHER);
      const f = intentFixture({
        active: retained,
        selected: phase === "committed" ? installation(OTHER, "3.0.0") : installation(OLD, "1.0.0"),
      });
      const result = await manageHomeUpgrade({ action: "run", vaultPath: "/vault" }, f.deps);
      expect(result.status).toBe("upgraded");
      expect(f.calls.indexOf("retire")).toBeLessThan(f.calls.indexOf("publish"));
      expect(f.calls.filter((call) => call === "retire")).toHaveLength(2);
    }
  });

  test("classifies same-candidate and different-candidate selection races", async () => {
    for (const selectedId of [REQUESTED, OTHER] as const) {
      const selected = installation(selectedId, selectedId === REQUESTED ? "2.0.0" : "3.0.0");
      const f = intentFixture({
        cutoverError: new HomeUpgradeSelectionChangedError(OLD, selected),
      });
      const result = await manageHomeUpgrade({ action: "run", vaultPath: "/vault" }, f.deps);
      if (selectedId === REQUESTED) {
        expect(result).toMatchObject({ status: "already-current", exitCode: 0 });
      } else {
        expect(result).toMatchObject({
          status: "error",
          exitCode: 75,
          reason: "selection-changed",
          selectedArtifact: { artifactId: OTHER },
        });
      }
    }
  });

  test("same-artifact release publication loss converges on the verified winner", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "dome-release-race-")));
    try {
      const source = join(root, "artifact");
      const support = join(root, "support");
      await mkdir(source);
      await writeFile(join(source, "manifest.json"), `${JSON.stringify({ id: REQUESTED })}\n`);
      const value = manifest();
      const verify = async (path: string) => {
        const parsed = JSON.parse(await readFile(join(path, "manifest.json"), "utf8"));
        if (parsed.id !== REQUESTED) throw new Error("wrong artifact");
        return value;
      };
      const published = await ensureManagedRelease({
        source,
        manifest: value,
        paths: homeInstallationPaths("/vault", { applicationSupportDir: support }),
        platform: "darwin",
      }, {
        applicationSupportDir: support,
        verifyArtifact: verify,
        syncRelease: async () => {},
        publishRelease: async (staging, target) => {
          await rename(staging, target);
          throw new Error("publisher lost the success response");
        },
      });
      expect(published.published).toBeFalse();
      expect((await verify(published.root)).artifact.id).toBe(REQUESTED);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

function intentFixture(options: {
  readonly selected?: ReturnType<typeof installation> | null;
  readonly active?: HomeUpgradeTransaction | null;
  readonly history?: ReadonlyArray<HomeUpgradeTransaction>;
  readonly suspension?: ReturnType<typeof activeSuspension> | { readonly kind: "inactive" };
  readonly cutoverError?: Error;
  readonly verifyError?: Error;
} = {}) {
  const calls: string[] = [];
  const recoveredIds: string[] = [];
  let selected = options.selected === undefined ? installation(OLD, "1.0.0") : options.selected;
  let active = options.active ?? null;
  const operations: NonNullable<HomeUpgradeIntentDeps["intentOperations"]> = {
    canonicalizeVault: async () => { calls.push("canonicalize"); return "/vault"; },
    verifyInvokingArtifact: async () => {
      calls.push("verify");
      if (options.verifyError !== undefined) throw options.verifyError;
      return manifest();
    },
    readInstallation: async () => { calls.push("read-installation"); return selected; },
    inspectLifecycle: async () => {
      calls.push("inspect-lifecycle");
      return options.suspension ?? { kind: "inactive" };
    },
    readActive: async () => { calls.push("read-active"); return active; },
    listHistory: async () => { calls.push("list-history"); return options.history ?? []; },
    publishCandidate: async () => { calls.push("publish"); return { root: "/releases/requested", published: true }; },
    operationId: () => { calls.push("uuid"); return TX; },
    cutover: async (input) => {
      calls.push("cutover");
      if (options.cutoverError !== undefined) throw options.cutoverError;
      expect(input.expectedCurrentArtifactId).toBe(selected!.artifact.id);
      const committed = transaction("committed", input.transactionId, input.candidateArtifactId);
      selected = installation(input.candidateArtifactId, committed.candidate.version);
      active = committed;
      return cutoverResult(committed);
    },
    restore: async () => {
      calls.push("restore");
      if (active === null) throw new Error("missing retained transaction");
      active = transaction("restored", active.transactionId, active.candidate.artifactId);
      return active;
    },
    retire: async ({ transactionId }) => {
      calls.push("retire");
      const value = active ?? transaction("restored", transactionId, OTHER);
      active = null;
      return { transaction: value, retired: true };
    },
    recoverOrphan: async (_vault, operationId) => {
      calls.push("recover-orphan");
      recoveredIds.push(operationId);
      return { kind: "ready", operationId, recovered: true, operationRan: false };
    },
    inspectService: async () => { calls.push("inspect-service"); return "ready"; },
  };
  return {
    calls,
    recoveredIds,
    deps: {
      platform: "darwin" as const,
      artifactRoot: "/artifact",
      intentOperations: operations,
    } satisfies HomeUpgradeIntentDeps,
  };
}

function installation(id: string, version: string) {
  return {
    schema: "dome.home.installation/v1" as const,
    vault: "/vault",
    artifact: { id, version },
    environment: [],
  };
}

function manifest(): HomeArtifactManifest {
  return {
    artifact: { id: REQUESTED },
    product: { name: "Dome Home", version: "2.0.0" },
    writerBarrier: { protocol: 1 },
    durableState: { protocol: 1, stores: [] },
  } as unknown as HomeArtifactManifest;
}

function cutoverResult(value: HomeUpgradeTransaction): HomeUpgradeCutoverResult {
  return {
    status: "ready",
    transactionOutcome: { kind: "committed", transaction: value },
    handoffError: null,
    lifecycle: {
      kind: "ready",
      operationId: value.transactionId,
      recovered: false,
      operationRan: true,
      value: {
        transactionOutcome: { kind: "committed", transaction: value },
        handoffError: null,
      },
    },
  };
}

function transaction(
  phase: "prepared" | "switching" | "committed" | "restored",
  transactionId: string,
  candidateId: string,
): HomeUpgradeTransaction {
  return {
    schema: "dome.home-upgrade-transaction/v2",
    vault: "/vault",
    transactionId,
    phase,
    old: { artifactId: OLD, version: "1.0.0", releasePath: `/releases/${OLD}`, manifestSha256: "d".repeat(64) },
    candidate: {
      artifactId: candidateId,
      version: candidateId === REQUESTED ? "2.0.0" : "3.0.0",
      releasePath: `/releases/${candidateId}`,
      manifestSha256: "e".repeat(64),
    },
    selectors: {
      installation: { path: "/installation.json", mode: 0o600, size: 1, sha256: "1".repeat(64) },
      plist: { path: "/home.plist", mode: 0o600, size: 1, sha256: "2".repeat(64) },
    },
    selection: null,
    probation: null,
    snapshot: { root: "snapshot", inventory: [] },
    timestamps: {
      preparedAt: "2026-07-13T01:00:00.000Z",
      switchingAt: phase === "switching" || phase === "committed" ? "2026-07-13T01:01:00.000Z" : null,
      committedAt: phase === "committed" ? "2026-07-13T01:02:00.000Z" : null,
      restoredAt: phase === "restored" ? "2026-07-13T01:03:00.000Z" : null,
    },
  };
}

function activeSuspension(operationId: string) {
  return {
    kind: "active" as const,
    suspension: {
      schema: "dome.home-lifecycle-suspension/v1" as const,
      phase: "suspended" as const,
      purpose: "upgrade" as const,
      operationId,
      vault: "/vault",
      priorLoaded: true,
      installationPath: "/installation.json",
      installationSha256: "1".repeat(64),
      artifactId: OLD,
      artifactVersion: "1.0.0",
      plistPath: "/home.plist",
      plistSha256: "2".repeat(64),
      resumeInstallationPath: "/installation.json",
      resumeInstallationSha256: "1".repeat(64),
      resumeArtifactId: OLD,
      resumeArtifactVersion: "1.0.0",
      resumePlistPath: "/home.plist",
      resumePlistSha256: "2".repeat(64),
      requestedAt: "2026-07-13T01:00:00.000Z",
      phaseChangedAt: "2026-07-13T01:00:00.000Z",
      lastError: null,
    },
  };
}
