import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { renderLaunchAgentPlist } from "../../src/platform/launchd";
import {
  cleanupHomeCredentialResidue,
  HOME_CREDENTIAL_CLEANUP_AUTHORIZATION,
  inspectHomeCredentialResidue,
  inspectStoredHomeCredentialResidueForTests,
  type HomeCredentialResidueCleanupDeps,
} from "../../src/product-host/home-credential-residue";
import { homeInstallationPaths, releaseRoot } from "../../src/product-host/home-installation";
import {
  readHomeUpgradeCandidateReceipt,
  readLatestHomeUpgradeSummary,
} from "../../src/product-host/home-upgrade-history";
import { homeSelectionPaths } from "../../src/product-host/home-selection";
import {
  readHomeUpgradeHistory,
  type HomeUpgradeTransaction,
  type HomeUpgradeSnapshotEntry,
  HomeUpgradeSelectionEvidence,
  HomeUpgradeStoredSelectionDocument,
} from "../../src/product-host/home-upgrade-transaction";
import type { HomeSuspensionOperationContext } from "../../src/product-host/home-lifecycle-suspension";

const SECRET_NAME = "ANTHROPIC_API_KEY";
const SECRET_VALUE = "never-return-this-secret";
const VAULT_ID = "residue-vault-id";

describe("Home credential residue inspection", () => {
  test("reports only secret variable names and bounded live location categories", async () => {
    const fixture = await liveFixture();
    try {
      const inspection = await inspectHomeCredentialResidue(fixture.vault, fixture.deps);
      expect(inspection).toEqual({
        schema: "dome.home.credential-residue/v1",
        atRest: true,
        runtime: "unknown",
        state: "residue",
        findings: [
          { surface: "live", document: "installation", variableName: SECRET_NAME },
          { surface: "live", document: "plist", variableName: SECRET_NAME },
        ],
      });
      const publicBytes = JSON.stringify(inspection);
      expect(publicBytes).not.toContain(SECRET_VALUE);
      expect(publicBytes).not.toContain(fixture.root);
      expect(publicBytes).not.toContain("installation.json");
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  test("detects all four active and immutable-history copies through the shared strict scanner", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "dome-home-residue-stored-")));
    const vault = join(root, "vault");
    try {
      await mkdir(vault, { recursive: true });
      const selection = await storedSelectionFixture(root, vault);
      const active = await inspectStoredHomeCredentialResidueForTests({ root, selection, surface: "active", vault });
      const history = await inspectStoredHomeCredentialResidueForTests({ root, selection, surface: "history", vault });
      expect(active).toMatchObject({ state: "residue" });
      expect(history).toMatchObject({ state: "residue" });
      expect(active.state === "residue" && active.findings).toEqual([
        { surface: "active", document: "installation", variableName: SECRET_NAME },
        { surface: "active", document: "plist", variableName: SECRET_NAME },
      ]);
      expect(history.state === "residue" && history.findings).toEqual([
        { surface: "history", document: "installation", variableName: SECRET_NAME },
        { surface: "history", document: "plist", variableName: SECRET_NAME },
      ]);
      expect(JSON.stringify([active, history])).not.toContain(SECRET_VALUE);

      await link(join(root, "selectors", "old-installation.json"), join(root, "selectors", "alias"));
      expect(await inspectStoredHomeCredentialResidueForTests({ root, selection, surface: "active", vault }))
        .toMatchObject({ state: "indeterminate", reason: "verification-failed", findings: null });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("includes installation/plist temporary siblings and upgrade staging copies", async () => {
    const fixture = await liveFixture();
    try {
      const installation = homeInstallationPaths(fixture.vault, fixture.deps).record;
      const plist = homeSelectionPaths(fixture.vault, fixture.deps).plist;
      await writeFile(`${installation}.tmp-1-test`, installationBytes(fixture.vault, "a".repeat(64), "1.0.0"), {
        mode: 0o600,
      });
      await writeFile(`${plist}.tmp-1-test`, plistBytes("temporary"), { mode: 0o600 });
      expect(await inspectHomeCredentialResidue(fixture.vault, fixture.deps)).toMatchObject({ state: "residue" });
      const stagingSelectors = join(
        dirname(installation), "upgrade", ".staging-11111111-2222-4333-8444-555555555555", "selectors",
      );
      await mkdir(stagingSelectors, { recursive: true, mode: 0o700 });
      await writeFile(join(stagingSelectors, "old-installation.json"), installationBytes(
        fixture.vault, "a".repeat(64), "1.0.0",
      ), { mode: 0o600 });
      await writeFile(join(stagingSelectors, "old.plist"), plistBytes("staging"), { mode: 0o600 });
      const inspection = await inspectHomeCredentialResidue(fixture.vault, fixture.deps);
      expect(inspection).toMatchObject({ state: "residue" });
      expect(inspection.state === "residue" && inspection.findings.filter((row) => row.surface === "transient"))
        .toEqual([
          { surface: "transient", document: "installation", variableName: SECRET_NAME },
          { surface: "transient", document: "plist", variableName: SECRET_NAME },
        ]);
      await chmod(dirname(stagingSelectors), 0o755);
      expect(await inspectHomeCredentialResidue(fixture.vault, fixture.deps))
        .toMatchObject({ state: "indeterminate", reason: "verification-failed", findings: null });
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  test("fails closed without exposing paths for redirected and oversized live state", async () => {
    for (const fault of ["symlink", "oversized"] as const) {
      const fixture = await liveFixture();
      try {
        const plist = homeSelectionPaths(fixture.vault, fixture.deps).plist;
        await rm(plist);
        if (fault === "symlink") {
          const outside = join(fixture.root, "outside.plist");
          await writeFile(outside, plistBytes());
          await symlink(outside, plist);
        } else await writeFile(plist, "x".repeat(128 * 1024 + 1), { mode: 0o600 });
        expect(await inspectHomeCredentialResidue(fixture.vault, fixture.deps)).toEqual({
          schema: "dome.home.credential-residue/v1",
          atRest: true,
          runtime: "unknown",
          state: "indeterminate",
          findings: null,
          reason: "verification-failed",
        });
      } finally { await rm(fixture.root, { recursive: true, force: true }); }
    }
  });

  test("second full scan detects same-byte inode replacement and newly appeared staging selectors", async () => {
    for (const fault of ["inode", "selectors"] as const) {
      const fixture = await liveFixture();
      try {
        const installation = homeInstallationPaths(fixture.vault, fixture.deps).record;
        const plist = homeSelectionPaths(fixture.vault, fixture.deps).plist;
        const staging = join(dirname(installation), "upgrade", ".staging-race");
        if (fault === "selectors") await mkdir(staging, { recursive: true, mode: 0o700 });
        const inspection = await inspectHomeCredentialResidue(fixture.vault, {
          ...fixture.deps,
          credentialResidueBetweenScans: async () => {
            if (fault === "inode") {
              const bytes = await Bun.file(plist).text();
              await rm(plist);
              await writeFile(plist, bytes, { mode: 0o600 });
            } else {
              const selectors = join(staging, "selectors");
              await mkdir(selectors, { mode: 0o700 });
              await writeFile(join(selectors, "old-installation.json"), installationBytes(
                fixture.vault, "a".repeat(64), "1.0.0",
              ), { mode: 0o600 });
            }
          },
        });
        expect(inspection).toMatchObject({ state: "indeterminate", reason: "changed", findings: null });
      } finally { await rm(fixture.root, { recursive: true, force: true }); }
    }
  });

  test("rejects noncanonical numeric XML entities instead of reinterpreting environment names", async () => {
    const fixture = await liveFixture();
    try {
      const plist = homeSelectionPaths(fixture.vault, fixture.deps).plist;
      const bytes = (await Bun.file(plist).text()).replace(
        `<key>${SECRET_NAME}</key>`,
        "<key>ANTHROPIC&#95;API_KEY</key>",
      );
      await writeFile(plist, bytes, { mode: 0o600 });
      expect(await inspectHomeCredentialResidue(fixture.vault, fixture.deps))
        .toMatchObject({ state: "indeterminate", reason: "verification-failed", findings: null });
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });
});

describe("Home credential residue cleanup", () => {
  test("only the exact destructive authorization can enter apply mode", async () => {
    const fixture = await liveFixture();
    try {
      const result = await cleanupHomeCredentialResidue({
        vaultPath: fixture.vault,
        authorization: "almost-the-right-authorization" as never,
      }, cleanupDeps(fixture));
      expect(result).toMatchObject({ mode: "apply", status: "blocked", cleanup: "indeterminate",
        reason: "authorization-required", exitCode: 64 });
      expect(await inspectHomeCredentialResidue(fixture.vault, fixture.deps)).toMatchObject({ state: "residue" });
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  test("previews without mutation and apply removes the exact supported live pair", async () => {
    const fixture = await liveFixture();
    try {
      const preview = await cleanupHomeCredentialResidue({ vaultPath: fixture.vault }, cleanupDeps(fixture));
      expect(preview).toMatchObject({ mode: "preview", status: "residue", cleanup: "residue",
        reason: "authorization-required", nextAction: "rerun-with-apply" });
      expect(await inspectHomeCredentialResidue(fixture.vault, fixture.deps)).toMatchObject({ state: "residue" });
      const applied = await cleanupHomeCredentialResidue({
        vaultPath: fixture.vault,
        authorization: HOME_CREDENTIAL_CLEANUP_AUTHORIZATION,
      }, cleanupDeps(fixture));
      expect(applied).toMatchObject({ status: "cleaned", cleanup: "clean", home: "ready" });
      expect(await inspectHomeCredentialResidue(fixture.vault, fixture.deps)).toMatchObject({ state: "clean" });
      expect(JSON.stringify(applied)).not.toContain(fixture.root);
      expect(JSON.stringify(applied)).not.toContain(SECRET_VALUE);
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  test("unknown secret-like residue, active upgrade, and unreadable Keychain all block before suspension", async () => {
    for (const fault of ["unknown", "upgrade", "keychain"] as const) {
      const fixture = await liveFixture();
      let suspensions = 0;
      try {
        if (fault === "unknown") {
          const installation = homeInstallationPaths(fixture.vault, fixture.deps).record;
          const plist = homeSelectionPaths(fixture.vault, fixture.deps).plist;
          await writeFile(installation, installationBytes(fixture.vault, "a".repeat(64), "1.0.0")
            .replaceAll(SECRET_NAME, "A_SERVICE_TOKEN"), { mode: 0o600 });
          await writeFile(plist, plistBytes().replaceAll(SECRET_NAME, "A_SERVICE_TOKEN"), { mode: 0o600 });
        }
        const deps = cleanupDeps(fixture, {
          suspend: (async () => { suspensions += 1; throw new Error("must not suspend"); }) as never,
          ...(fault === "upgrade" ? { readUpgrade: async () => ({ phase: "committed" } as never) } : {}),
          ...(fault === "keychain" ? { resolveModel: async () => modelRuntime("missing", "unconfigured") } : {}),
        });
        const result = await cleanupHomeCredentialResidue({
          vaultPath: fixture.vault, authorization: HOME_CREDENTIAL_CLEANUP_AUTHORIZATION,
        }, deps);
        expect(result).toMatchObject({ status: "blocked", reason: fault === "unknown"
          ? "unsupported-residue" : fault === "upgrade" ? "recover-upgrade" : "configure-keychain" });
        expect(suspensions).toBe(0);
      } finally { await rm(fixture.root, { recursive: true, force: true }); }
    }
  });

  test("an installation-first crash is visible and retry converges without restoring plaintext", async () => {
    const fixture = await liveFixture();
    try {
      let crashed = false;
      const first = await cleanupHomeCredentialResidue({
        vaultPath: fixture.vault, authorization: HOME_CREDENTIAL_CLEANUP_AUTHORIZATION,
      }, cleanupDeps(fixture, { cleanupCheckpoint: async (name) => {
        if (name === "installation-published" && !crashed) { crashed = true; throw new Error("crash"); }
      } }));
      expect(first).toMatchObject({ status: "error", cleanup: "residue", home: "ready" });
      const partial = await inspectHomeCredentialResidue(fixture.vault, fixture.deps);
      expect(partial).toMatchObject({ state: "residue" });
      expect(partial.state === "residue" && partial.findings).toEqual([
        { surface: "live", document: "plist", variableName: SECRET_NAME },
      ]);
      const retried = await cleanupHomeCredentialResidue({
        vaultPath: fixture.vault, authorization: HOME_CREDENTIAL_CLEANUP_AUTHORIZATION,
      }, cleanupDeps(fixture));
      expect(retried).toMatchObject({ status: "cleaned", cleanup: "clean" });
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  test("a swapped or corrupt selected release is never blessed as sanitized resume evidence", async () => {
    const fixture = await liveFixture();
    try {
      const result = await cleanupHomeCredentialResidue({
        vaultPath: fixture.vault, authorization: HOME_CREDENTIAL_CLEANUP_AUTHORIZATION,
      }, cleanupDeps(fixture, {
        verifyArtifact: async () => ({ artifact: { id: "b".repeat(64) }, product: { version: "1.0.0" } } as never),
      }));
      expect(result).toMatchObject({ status: "error", cleanup: "residue", home: "ready" });
      expect(await inspectHomeCredentialResidue(fixture.vault, fixture.deps)).toMatchObject({ state: "residue" });
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  test("temp-file tombstones remain residue across a crash and any later operation id removes them", async () => {
    for (const kind of ["installation", "plist"] as const) {
      const fixture = await liveFixture();
      try {
        const installation = homeInstallationPaths(fixture.vault, fixture.deps).record;
        const plist = homeSelectionPaths(fixture.vault, fixture.deps).plist;
        await writeFile(kind === "installation" ? `${installation}.tmp-crash` : `${plist}.tmp-crash`,
          kind === "installation" ? installationBytes(fixture.vault, "a".repeat(64), "1.0.0") : plistBytes("temp"),
          { mode: 0o600 });
        let crashed = false;
        expect(await cleanupHomeCredentialResidue({
          vaultPath: fixture.vault, authorization: HOME_CREDENTIAL_CLEANUP_AUTHORIZATION,
        }, cleanupDeps(fixture, { operationId: () => "first-op", cleanupCheckpoint: async (name) => {
          if (name === "transient-renamed" && !crashed) { crashed = true; throw new Error("crash"); }
        } }))).toMatchObject({ status: "error", home: "ready" });
        expect(await inspectHomeCredentialResidue(fixture.vault, fixture.deps)).toMatchObject({ state: "residue" });
        expect(await cleanupHomeCredentialResidue({
          vaultPath: fixture.vault, authorization: HOME_CREDENTIAL_CLEANUP_AUTHORIZATION,
        }, cleanupDeps(fixture, { operationId: () => "second-op" }))).toMatchObject({ cleanup: "clean" });
      } finally { await rm(fixture.root, { recursive: true, force: true }); }
    }
  });

  test("installation-only cleanup tombstones remain visible and a later operation removes them", async () => {
    const fixture = await liveFixture();
    try {
      const installation = homeInstallationPaths(fixture.vault, fixture.deps).record;
      await rm(homeSelectionPaths(fixture.vault, fixture.deps).plist);
      await writeFile(`${installation}.tmp-install-only`, installationBytes(
        fixture.vault, "a".repeat(64), "1.0.0",
      ), { mode: 0o600 });
      let crashed = false;
      const first = await cleanupHomeCredentialResidue({
        vaultPath: fixture.vault, authorization: HOME_CREDENTIAL_CLEANUP_AUTHORIZATION,
      }, cleanupDeps(fixture, {
        isServiceLoaded: async () => false,
        operationId: () => "install-only-first",
        cleanupCheckpoint: async (name) => {
          if (name === "transient-renamed" && !crashed) { crashed = true; throw new Error("crash"); }
        },
      }));
      expect(first).toMatchObject({ status: "error", home: "not-run" });
      expect(await inspectHomeCredentialResidue(fixture.vault, fixture.deps)).toMatchObject({ state: "residue" });

      const retried = await cleanupHomeCredentialResidue({
        vaultPath: fixture.vault, authorization: HOME_CREDENTIAL_CLEANUP_AUTHORIZATION,
      }, cleanupDeps(fixture, {
        isServiceLoaded: async () => false,
        operationId: () => "install-only-second",
      }));
      expect(retried).toMatchObject({ status: "cleaned", cleanup: "clean", home: "stopped" });
      expect(await inspectHomeCredentialResidue(fixture.vault, fixture.deps)).toMatchObject({ state: "clean" });
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  test("clean bytes with an active cleanup row report and recover resume instead of fast-pathing", async () => {
    const fixture = await liveFixture();
    try {
      await cleanupHomeCredentialResidue({
        vaultPath: fixture.vault, authorization: HOME_CREDENTIAL_CLEANUP_AUTHORIZATION,
      }, cleanupDeps(fixture));
      const active = { kind: "active" as const, suspension: { purpose: "credential-cleanup" as const,
        operationId: "resume-op", phase: "resuming" as const } as never };
      const preview = await cleanupHomeCredentialResidue({ vaultPath: fixture.vault }, cleanupDeps(fixture, {
        inspectLifecycle: async () => active,
      }));
      expect(preview).toMatchObject({ status: "recovery-required", cleanup: "clean", nextAction: "retry-cleanup" });
      const modelBlocked = await cleanupHomeCredentialResidue({
        vaultPath: fixture.vault, authorization: HOME_CREDENTIAL_CLEANUP_AUTHORIZATION,
      }, cleanupDeps(fixture, {
        inspectLifecycle: async () => active,
        resolveModel: async () => modelRuntime("missing", "unconfigured"),
      }));
      expect(modelBlocked).toMatchObject({ status: "blocked", cleanup: "clean",
        reason: "configure-keychain", nextAction: "configure-model" });
      const apply = await cleanupHomeCredentialResidue({
        vaultPath: fixture.vault, authorization: HOME_CREDENTIAL_CLEANUP_AUTHORIZATION,
      }, cleanupDeps(fixture, { inspectLifecycle: async () => active }));
      expect(apply).toMatchObject({ status: "cleaned", cleanup: "clean", home: "ready" });
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  test("reports callback-not-run failure from fresh residue and retained Home truth", async () => {
    const fixture = await liveFixture();
    try {
      const result = await cleanupHomeCredentialResidue({
        vaultPath: fixture.vault, authorization: HOME_CREDENTIAL_CLEANUP_AUTHORIZATION,
      }, cleanupDeps(fixture, {
        suspend: (async () => ({ kind: "failed", error: "private supervisor detail",
          operationId: "not-run", recovered: true, operationRan: false })) as never,
      }));
      expect(result).toMatchObject({ status: "recovery-required", cleanup: "residue",
        home: "recovery-required", reason: "cleanup-incomplete" });
      expect(JSON.stringify(result)).not.toContain("private supervisor detail");
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  test("a pre-mutation cleanup failure can resume Home without claiming recovery is retained", async () => {
    const fixture = await liveFixture();
    try {
      const result = await cleanupHomeCredentialResidue({
        vaultPath: fixture.vault, authorization: HOME_CREDENTIAL_CLEANUP_AUTHORIZATION,
      }, cleanupDeps(fixture, {
        verifyArtifact: async () => { throw new Error("private artifact failure"); },
      }));
      expect(result).toMatchObject({ status: "error", cleanup: "residue", home: "ready",
        reason: "cleanup-incomplete" });
      expect(JSON.stringify(result)).not.toContain("private artifact failure");
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  test("a partial selector change plus failed resume retains recovery with residue truth", async () => {
    const fixture = await liveFixture();
    try {
      const result = await cleanupHomeCredentialResidue({
        vaultPath: fixture.vault, authorization: HOME_CREDENTIAL_CLEANUP_AUTHORIZATION,
      }, cleanupDeps(fixture, {
        cleanupCheckpoint: async (name) => {
          if (name === "installation-published") throw new Error("simulated selector crash");
        },
        suspend: (async (_input: never, operation: (context: HomeSuspensionOperationContext) => Promise<unknown>) => {
          const value = await operation({ operationId: "partial-op", purpose: "credential-cleanup",
            authorizeCurrentHomeForResume: async () => {} });
          return { kind: "failed", error: "resume retained", operationId: "partial-op",
            recovered: false, operationRan: true, value };
        }) as never,
      }));
      expect(result).toMatchObject({ status: "recovery-required", cleanup: "residue",
        home: "recovery-required", reason: "cleanup-incomplete" });
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  test("installation-only re-proves quiescence after lifecycle ownership before mutation", async () => {
    const fixture = await liveFixture();
    try {
      await rm(homeSelectionPaths(fixture.vault, fixture.deps).plist);
      const installation = homeInstallationPaths(fixture.vault, fixture.deps).record;
      const before = await readFile(installation, "utf8");
      let outerChecked = false;
      const result = await cleanupHomeCredentialResidue({
        vaultPath: fixture.vault, authorization: HOME_CREDENTIAL_CLEANUP_AUTHORIZATION,
      }, cleanupDeps(fixture, {
        isServiceLoaded: async () => { outerChecked = true; return false; },
        proveStopped: async () => {
          expect(outerChecked).toBeTrue();
          throw new Error("Home became live after the precheck");
        },
      }));
      expect(result).toMatchObject({ status: "error", cleanup: "residue", home: "not-run" });
      expect(await readFile(installation, "utf8")).toBe(before);
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  test("an absent live pair can prune transient residue while plist-only remains indeterminate", async () => {
    const absent = await liveFixture();
    try {
      const installation = homeInstallationPaths(absent.vault, absent.deps).record;
      await writeFile(`${installation}.tmp-orphan`, installationBytes(
        absent.vault, "a".repeat(64), "1.0.0",
      ), { mode: 0o600 });
      await rm(installation);
      await rm(homeSelectionPaths(absent.vault, absent.deps).plist);
      expect(await inspectHomeCredentialResidue(absent.vault, absent.deps)).toMatchObject({ state: "residue" });
      const result = await cleanupHomeCredentialResidue({
        vaultPath: absent.vault, authorization: HOME_CREDENTIAL_CLEANUP_AUTHORIZATION,
      }, cleanupDeps(absent, { isServiceLoaded: async () => false }));
      expect(result).toMatchObject({ status: "cleaned", cleanup: "clean", home: "stopped" });
    } finally { await rm(absent.root, { recursive: true, force: true }); }

    const invalid = await liveFixture();
    try {
      await rm(homeInstallationPaths(invalid.vault, invalid.deps).record);
      expect(await cleanupHomeCredentialResidue({
        vaultPath: invalid.vault, authorization: HOME_CREDENTIAL_CLEANUP_AUTHORIZATION,
      }, cleanupDeps(invalid))).toMatchObject({ status: "error", cleanup: "indeterminate",
        reason: "verification-failed" });
    } finally { await rm(invalid.root, { recursive: true, force: true }); }
  });

  test("staging and immutable history are pruned as whole roots with crash-visible cross-operation retry", async () => {
    for (const kind of ["staging", "history"] as const) {
      const fixture = await liveFixture();
      try {
        const upgrade = join(homeInstallationPaths(fixture.vault, fixture.deps).installations, "upgrade");
        const transactionId = "11111111-2222-4333-8444-555555555555";
        let original: string;
        if (kind === "staging") {
          original = join(upgrade, `.staging-${transactionId}`);
          await storedSelectionFixture(original, fixture.vault, liveSelectorPaths(fixture));
        } else {
          original = await terminalHistoryFixture(fixture, transactionId);
          expect(await readHomeUpgradeHistory(fixture.vault, transactionId, fixture.deps)).not.toBeNull();
          expect(await readLatestHomeUpgradeSummary(fixture.vault, fixture.deps)).toMatchObject({ operationId: transactionId });
          expect(await readHomeUpgradeCandidateReceipt(fixture.vault, "b".repeat(64), fixture.deps))
            .toMatchObject({ operationId: transactionId });
        }
        let crashed = false;
        const checkpoint = kind === "staging" ? "transient-renamed" : "history-renamed";
        const first = await cleanupHomeCredentialResidue({
          vaultPath: fixture.vault, authorization: HOME_CREDENTIAL_CLEANUP_AUTHORIZATION,
        }, cleanupDeps(fixture, { operationId: () => `${kind}-first`, cleanupCheckpoint: async (name) => {
          if (name === checkpoint && !crashed) { crashed = true; throw new Error("crash after root rename"); }
        } }));
        expect(first).toMatchObject({ status: "error", cleanup: "residue", home: "ready" });
        expect(await pathExistsForTest(original)).toBeFalse();
        expect((await readdir(kind === "staging" ? upgrade : join(upgrade, "history")))
          .some((name) => name.startsWith(".credential-cleanup-"))).toBeTrue();
        if (kind === "history") {
          expect(await readLatestHomeUpgradeSummary(fixture.vault, fixture.deps)).toBeNull();
          expect(await readHomeUpgradeCandidateReceipt(fixture.vault, "b".repeat(64), fixture.deps)).toBeNull();
        }
        expect(await cleanupHomeCredentialResidue({
          vaultPath: fixture.vault, authorization: HOME_CREDENTIAL_CLEANUP_AUTHORIZATION,
        }, cleanupDeps(fixture, { operationId: () => `${kind}-second` })))
          .toMatchObject({ status: "cleaned", cleanup: "clean" });
      } finally { await rm(fixture.root, { recursive: true, force: true }); }
    }
  });
});

function cleanupDeps(
  fixture: Awaited<ReturnType<typeof liveFixture>>,
  overrides: Partial<HomeCredentialResidueCleanupDeps> = {},
): HomeCredentialResidueCleanupDeps {
  return {
    ...fixture.deps,
    inspectLifecycle: async () => ({ kind: "inactive" }),
    readUpgrade: async () => null,
    resolveModel: async () => modelRuntime("present", "ready"),
    verifyArtifact: async () => ({
      artifact: { id: "a".repeat(64) },
      product: { version: "1.0.0" },
    } as never),
    suspend: (async (_input: never, operation: (context: HomeSuspensionOperationContext) => Promise<unknown>) => {
      const value = await operation({ operationId: "cleanup-op", purpose: "credential-cleanup",
        authorizeCurrentHomeForResume: async () => {} });
      return { kind: "ready", operationId: "cleanup-op", recovered: false, operationRan: true, value };
    }) as never,
    proveStopped: async () => {},
    ...overrides,
  };
}

function modelRuntime(
  credential: "present" | "missing",
  modelState: "ready" | "unconfigured",
) {
  return { configuration: "shipped-anthropic" as const, credential, modelState, probe: null, detail: null };
}

async function liveFixture(): Promise<{
  root: string;
  vault: string;
  deps: { applicationSupportDir: string; launchAgentsDir: string };
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dome-home-residue-live-")));
  const vault = join(root, "vault");
  const deps = { applicationSupportDir: join(root, "support"), launchAgentsDir: join(root, "LaunchAgents") };
  await mkdir(join(vault, ".dome", "state"), { recursive: true });
  await writeFile(join(vault, ".dome", "state", "product-host-id"), `${VAULT_ID}\n`, { mode: 0o600 });
  const installation = homeInstallationPaths(vault, deps).record;
  const plist = homeSelectionPaths(vault, deps).plist;
  await mkdir(join(installation, ".."), { recursive: true, mode: 0o700 });
  await mkdir(join(plist, ".."), { recursive: true, mode: 0o700 });
  await writeFile(installation, installationBytes(vault, "a".repeat(64), "1.0.0"), { mode: 0o600 });
  await writeFile(plist, plistBytes(), { mode: 0o600 });
  return { root, vault, deps };
}

async function storedSelectionFixture(
  root: string,
  vault: string,
  paths: { installation: string; plist: string } = {
    installation: "/live/installation.json",
    plist: "/live/home.plist",
  },
): Promise<HomeUpgradeSelectionEvidence> {
  const selectors = join(root, "selectors");
  await mkdir(selectors, { recursive: true, mode: 0o700 });
  const documents = {
    oldInstallation: installationBytes(vault, "a".repeat(64), "1.0.0"),
    oldPlist: plistBytes(),
    candidateInstallation: installationBytes(vault, "b".repeat(64), "2.0.0"),
    candidatePlist: plistBytes("candidate"),
  };
  const rows = [
    ["oldInstallation", "selectors/old-installation.json", paths.installation],
    ["oldPlist", "selectors/old.plist", paths.plist],
    ["candidateInstallation", "selectors/candidate-installation.json", paths.installation],
    ["candidatePlist", "selectors/candidate.plist", paths.plist],
  ] as const;
  const evidence = new Map<string, HomeUpgradeStoredSelectionDocument>();
  for (const [key, stored, path] of rows) {
    const bytes = documents[key];
    await writeFile(join(root, stored), bytes, { mode: 0o600 });
    evidence.set(key, {
      path,
      mode: 0o600,
      size: Buffer.byteLength(bytes),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      stored,
    });
  }
  return {
    old: { installation: evidence.get("oldInstallation")!, plist: evidence.get("oldPlist")! },
    candidate: {
      installation: evidence.get("candidateInstallation")!,
      plist: evidence.get("candidatePlist")!,
    },
  };
}

function liveSelectorPaths(fixture: Awaited<ReturnType<typeof liveFixture>>) {
  return {
    installation: homeInstallationPaths(fixture.vault, fixture.deps).record,
    plist: homeSelectionPaths(fixture.vault, fixture.deps).plist,
  };
}

async function terminalHistoryFixture(
  fixture: Awaited<ReturnType<typeof liveFixture>>,
  transactionId: string,
): Promise<string> {
  const paths = homeInstallationPaths(fixture.vault, fixture.deps);
  const upgrade = join(paths.installations, "upgrade");
  const history = join(upgrade, "history");
  const root = join(history, transactionId);
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const path of [upgrade, history, root]) await chmod(path, 0o700);
  const selection = await storedSelectionFixture(root, fixture.vault, liveSelectorPaths(fixture));
  const snapshot = join(root, "snapshot");
  await mkdir(snapshot, { mode: 0o700 });
  const metaTables = [
    ["answers.db", "answers_meta"],
    ["proposals.db", "proposals_meta"],
    ["outbox.db", "outbox_meta"],
    ["runs.db", "ledger_meta"],
    ["request-receipts.db", "request_receipts_meta"],
    ["device-authority.db", "device_authority_meta"],
  ] as const;
  const schemaHash = "e".repeat(64);
  const inventory: HomeUpgradeSnapshotEntry[] = [];
  for (const [name, meta] of metaTables) {
    const path = join(snapshot, name);
    const db = new Database(path);
    try {
      db.run(`CREATE TABLE ${meta} (schema_hash TEXT NOT NULL) STRICT`);
      db.query(`INSERT INTO ${meta} (schema_hash) VALUES (?)`).run(schemaHash);
    } finally { db.close(); }
    await chmod(path, 0o600);
    const bytes = await readFile(path);
    inventory.push({ name, kind: "sqlite", present: true, mode: 0o600, size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"), schemaHash });
  }
  for (const name of ["quarantined.json", "product-host-id"] as const) {
    inventory.push({ name, kind: "file", present: false, mode: null, size: null, sha256: null, schemaHash: null });
  }
  const now = "2026-07-15T12:00:00.000Z";
  const old = {
    artifactId: "a".repeat(64), version: "1.0.0", releasePath: releaseRoot(paths, "a".repeat(64)),
    manifestSha256: "c".repeat(64),
  };
  const candidate = {
    artifactId: "b".repeat(64), version: "2.0.0", releasePath: releaseRoot(paths, "b".repeat(64)),
    manifestSha256: "d".repeat(64),
  };
  const transaction = {
    schema: "dome.home-upgrade-transaction/v2",
    vault: fixture.vault,
    transactionId,
    phase: "restored",
    old,
    candidate,
    selectors: {
      installation: stripStored(selection.old.installation),
      plist: stripStored(selection.old.plist),
    },
    selection,
    probation: null,
    snapshot: { root: "snapshot", inventory },
    timestamps: { preparedAt: now, switchingAt: null, committedAt: null, restoredAt: now },
  } as HomeUpgradeTransaction;
  const summary = {
    schema: "dome.home-upgrade-terminal-summary/v1",
    operationId: transactionId,
    candidate: { artifactId: candidate.artifactId, productVersion: candidate.version },
    outcome: "restored",
    terminalAt: now,
  };
  await writeFile(join(root, "journal.json"), `${JSON.stringify(transaction)}\n`, { mode: 0o600 });
  await writeFile(join(root, "summary.json"), `${JSON.stringify(summary)}\n`, { mode: 0o600 });
  const receipts = join(upgrade, "receipts");
  const candidates = join(receipts, "candidates");
  await mkdir(candidates, { recursive: true, mode: 0o700 });
  await chmod(receipts, 0o700);
  await chmod(candidates, 0o700);
  await writeFile(join(receipts, "latest.json"), `${JSON.stringify(summary)}\n`, { mode: 0o600 });
  await writeFile(join(candidates, `${candidate.artifactId}.json`), `${JSON.stringify(summary)}\n`, { mode: 0o600 });
  return root;
}

function stripStored(value: HomeUpgradeStoredSelectionDocument) {
  const { stored: _stored, ...evidence } = value;
  return evidence;
}

async function pathExistsForTest(path: string): Promise<boolean> {
  try { await readFile(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EISDIR") return true;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function installationBytes(vault: string, artifactId: string, version: string): string {
  return `${JSON.stringify({
    schema: "dome.home.installation/v1",
    vault,
    artifact: { id: artifactId, version },
    environment: [
      { name: SECRET_NAME, value: SECRET_VALUE },
      { name: "DOME_LOG_LEVEL", value: "info" },
    ],
  }, null, 2)}\n`;
}

function plistBytes(label = "live"): string {
  return renderLaunchAgentPlist({
    label: `com.dome.home.${label}`,
    programArguments: ["/runtime/bun"],
    workingDirectory: "/vault",
    logPath: "/vault/home.log",
    environment: new Map([
      [SECRET_NAME, SECRET_VALUE],
      ["DOME_LOG_LEVEL", "info"],
    ]),
  });
}
