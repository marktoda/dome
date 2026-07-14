import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { chmod, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { renderLaunchAgentPlist } from "../../src/platform/launchd";
import {
  inspectHomeCredentialResidue,
  inspectStoredHomeCredentialResidueForTests,
} from "../../src/product-host/home-credential-residue";
import { homeInstallationPaths } from "../../src/product-host/home-installation";
import { homeSelectionPaths } from "../../src/product-host/home-selection";
import type {
  HomeUpgradeSelectionEvidence,
  HomeUpgradeStoredSelectionDocument,
} from "../../src/product-host/home-upgrade-transaction";

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

async function storedSelectionFixture(root: string, vault: string): Promise<HomeUpgradeSelectionEvidence> {
  const selectors = join(root, "selectors");
  await mkdir(selectors, { mode: 0o700 });
  const documents = {
    oldInstallation: installationBytes(vault, "a".repeat(64), "1.0.0"),
    oldPlist: plistBytes(),
    candidateInstallation: installationBytes(vault, "b".repeat(64), "2.0.0"),
    candidatePlist: plistBytes("candidate"),
  };
  const rows = [
    ["oldInstallation", "selectors/old-installation.json", "/live/installation.json"],
    ["oldPlist", "selectors/old.plist", "/live/home.plist"],
    ["candidateInstallation", "selectors/candidate-installation.json", "/live/installation.json"],
    ["candidatePlist", "selectors/candidate.plist", "/live/home.plist"],
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
