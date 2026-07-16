import { describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertHomeArtifactActivationIdentityBindingForTests,
  exerciseHomeArtifactActivationForTests,
  homeArtifactReleaseClaimForTests,
  inspectHomeArtifactTar as inspectHomeArtifactTarFromBuilder,
  stageAndPublishHomeArtifactCandidate,
  type HomeArtifactActivationIdentityBinding,
} from "../../scripts/home-artifact";
import { inspectHomeArtifactTar as inspectHomeArtifactTarFromLeaf } from "../../scripts/home-artifact-tar";

const identityMutations: ReadonlyArray<readonly [string, (value: MutableBinding) => void]> = [
  ["predecessor.artifactId", (value) => { value.predecessor.artifactId = "changed"; }],
  ["predecessor.version", (value) => { value.predecessor.version = "changed"; }],
  ["predecessor.buildCommit", (value) => { value.predecessor.buildCommit = "changed"; }],
  ["predecessor.archiveSha256", (value) => { value.predecessor.archiveSha256 = "changed"; }],
  ["predecessor.manifestSha256", (value) => { value.predecessor.manifestSha256 = "changed"; }],
  ["candidate.artifactId", (value) => { value.candidate.artifactId = "changed"; }],
  ["candidate.version", (value) => { value.candidate.version = "changed"; }],
  ["candidate.buildCommit", (value) => { value.candidate.buildCommit = "changed"; }],
  ["candidate.archiveSha256", (value) => { value.candidate.archiveSha256 = "changed"; }],
  ["candidate.manifestSha256", (value) => { value.candidate.manifestSha256 = "changed"; }],
  ["fixture.releaseId", (value) => { value.fixture.releaseId = "changed"; }],
  ["fixture.sourceCommit", (value) => { value.fixture.sourceCommit = "changed"; }],
  ["fixture.canaryDigest", (value) => { value.fixture.canaryDigest = "changed"; }],
];

describe("Dome Home 0.3 activation", () => {
  test("keeps one closed activation order while portable execution emits no evidence", async () => {
    const events: string[] = [];
    const result = await exerciseHomeArtifactActivationForTests(operations(events));
    expect(result).toEqual({ evidence: false });
    expect(events).toEqual([
      "admit-candidate",
      "reconstruct-predecessor",
      "run-installed-gate",
      "bind-identity",
      "write-receipt",
      "reprove-candidate",
      "reprove-source",
      "cleanup",
      "reprove-final-source",
      "reprove-final-receipt",
    ]);
  });

  test("candidate replacement after ordinary rehearsal is refused before predecessor work", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-home-activation-admission-"));
    const events: string[] = [];
    let publishCalled = false;
    try {
      await expect(stageAndPublishHomeArtifactCandidate({
        outputDir: join(root, "dist"),
        artifactName: "dome-home-0.3.0-darwin-arm64",
        assemble: async ({ directory, archive }) => {
          await mkdir(directory);
          await writeFile(archive, "original candidate\n");
        },
        verifyArtifact: async () => {},
        rehearseArchive: async ({ archive }) => {
          await writeFile(archive, "replacement candidate\n");
          await exerciseHomeArtifactActivationForTests(operations(events, {
            admitCandidate: async () => {
              events.push("admit-candidate");
              throw new Error("staged candidate changed after ordinary archive rehearsal");
            },
          }));
        },
      }, async () => { publishCalled = true; })).rejects.toThrow("changed after ordinary archive rehearsal");

      expect(publishCalled).toBeFalse();
      expect(events).toEqual(["admit-candidate"]);
      expect(await exists(join(root, "dist"))).toBeFalse();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("installed gate failure publishes nothing and still cleans private predecessor state", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-home-activation-gate-"));
    const events: string[] = [];
    let publishCalled = false;
    try {
      await expect(stageAndPublishHomeArtifactCandidate({
        outputDir: join(root, "dist"),
        artifactName: "dome-home-0.3.0-darwin-arm64",
        assemble: async ({ directory, archive }) => {
          await mkdir(directory);
          await writeFile(archive, "candidate\n");
        },
        verifyArtifact: async () => {},
        rehearseArchive: async () => {
          await exerciseHomeArtifactActivationForTests(operations(events, {
            runInstalledGate: async () => {
              events.push("run-installed-gate");
              throw new Error("installed rehearsal rejected");
            },
          }));
        },
      }, async () => { publishCalled = true; })).rejects.toThrow("installed rehearsal rejected");

      expect(publishCalled).toBeFalse();
      expect(events).toEqual(["admit-candidate", "reconstruct-predecessor", "run-installed-gate", "cleanup"]);
      expect(await exists(join(root, "dist"))).toBeFalse();
      expect((await readdir(root)).filter((name) => name.startsWith(".dome-home-candidate-"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("final source drift occurs after candidate reproof and prevents publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-home-activation-source-"));
    const events: string[] = [];
    let publishCalled = false;
    try {
      await expect(stageAndPublishHomeArtifactCandidate({
        outputDir: join(root, "dist"),
        artifactName: "dome-home-0.3.0-darwin-arm64",
        assemble: async ({ directory, archive }) => {
          await mkdir(directory);
          await writeFile(archive, "candidate\n");
        },
        verifyArtifact: async () => {},
        rehearseArchive: async () => {
          await exerciseHomeArtifactActivationForTests(operations(events, {
            reproveSource: async () => {
              events.push("reprove-source");
              throw new Error("source HEAD changed during artifact build");
            },
          }));
        },
      }, async (source, target) => {
        publishCalled = true;
        await rename(source, target);
      })).rejects.toThrow("source HEAD changed");

      expect(publishCalled).toBeFalse();
      expect(events).toEqual([
        "admit-candidate",
        "reconstruct-predecessor",
        "run-installed-gate",
        "bind-identity",
        "write-receipt",
        "reprove-candidate",
        "reprove-source",
        "cleanup",
      ]);
      expect(await exists(join(root, "dist"))).toBeFalse();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("evidence replacement after cleanup and final source proof prevents publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-home-activation-evidence-"));
    const events: string[] = [];
    let publishCalled = false;
    try {
      await expect(stageAndPublishHomeArtifactCandidate({
        outputDir: join(root, "dist"),
        artifactName: "dome-home-0.3.0-darwin-arm64",
        assemble: async ({ directory, archive }) => {
          await mkdir(directory);
          await writeFile(archive, "candidate\n");
        },
        verifyArtifact: async () => {},
        rehearseArchive: async () => {
          await exerciseHomeArtifactActivationForTests(operations(events, {
            reproveFinalReceipt: async () => {
              events.push("reprove-final-receipt");
              throw new Error("installed evidence changed after final source proof");
            },
          }));
        },
      }, async () => { publishCalled = true; })).rejects.toThrow("evidence changed after final source proof");

      expect(publishCalled).toBeFalse();
      expect(events).toEqual([
        "admit-candidate",
        "reconstruct-predecessor",
        "run-installed-gate",
        "bind-identity",
        "write-receipt",
        "reprove-candidate",
        "reprove-source",
        "cleanup",
        "reprove-final-source",
        "reprove-final-receipt",
      ]);
      expect(await exists(join(root, "dist"))).toBeFalse();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("accepts the exact predecessor, candidate, and frozen fixture identity", () => {
    const expected = binding();
    assertHomeArtifactActivationIdentityBindingForTests(expected, structuredClone(expected));
  });

  test.each(identityMutations)("rejects an installed identity mismatch at %s", (_field, mutate) => {
    const expected = binding();
    const observed = structuredClone(expected) as MutableBinding;
    mutate(observed);
    expect(() => assertHomeArtifactActivationIdentityBindingForTests(expected, observed))
      .toThrow("identity does not match the staged release");
  });

  test("fixes the official release claim at package 0.3.6 and upgrade support true", async () => {
    const pkg = JSON.parse(await readFile(join(import.meta.dir, "..", "..", "package.json"), "utf8")) as {
      readonly version: string;
    };
    expect(homeArtifactReleaseClaimForTests()).toEqual({ version: "0.3.6", upgradeSupported: true });
    expect(pkg.version).toBe(homeArtifactReleaseClaimForTests().version);
  });

  test("the installed rehearsal consumes only the shared tar leaf, not its gated builder", async () => {
    const installed = await readFile(
      join(import.meta.dir, "..", "..", "scripts", "home-installed-upgrade-rehearsal.ts"),
      "utf8",
    );
    expect(installed).toContain('from "./home-artifact-tar"');
    expect(installed).not.toContain('from "./home-artifact"');
    expect(inspectHomeArtifactTarFromBuilder).toBe(inspectHomeArtifactTarFromLeaf);
  });

  test("ordinary rehearsal never backs up an uninstalled vault; installed ready-success owns the full canary", async () => {
    const ordinarySource = await readFile(
      join(import.meta.dir, "..", "..", "scripts", "home-artifact.ts"),
      "utf8",
    );
    const ordinary = sourceFunction(
      ordinarySource,
      "export async function rehearseHomeArtifact",
      "export async function createDeterministicTar",
    );
    expect(ordinary).toContain('"backup", "keygen"');
    expect(ordinary).toContain('"backup", "restore", "--help"');
    expect(ordinary).not.toContain('"backup", "create"');
    expect(ordinary).not.toContain('"backup", "verify"');
    expect(ordinary).not.toContain('"backup", "restore", backup');

    const installedSource = await readFile(
      join(import.meta.dir, "..", "..", "scripts", "home-installed-upgrade-rehearsal.ts"),
      "utf8",
    );
    const readySuccess = sourceFunction(
      installedSource,
      "async function readySuccess",
      "async function stoppedPrecommitCrash",
    );
    const packagedBackup = sourceFunction(
      installedSource,
      "async function packagedBackup",
      "/** Portable assertion",
    );
    expect(readySuccess).toContain("await packagedBackup(context, prepared.candidateRoot)");
    expect(readySuccess).toContain("await runHomePwaChromiumAcceptance(");
    expect(readySuccess).toContain("await runHomePwaUpdateRehearsal(");
    expect(readySuccess.indexOf("await runHomePwaChromiumAcceptance("))
      .toBeLessThan(readySuccess.indexOf("await runHomePwaUpdateRehearsal("));
    expect(readySuccess).toContain('staticRoot: join(prepared.candidateRoot, "app", "pwa", "dist")');
    expect(readySuccess).toContain("await prepareInstalledFunctionalClosure(functionalClosure)");
    expect(readySuccess.indexOf("await prepareInstalledFunctionalClosure(functionalClosure)"))
      .toBeLessThan(readySuccess.indexOf("await runHomePwaChromiumAcceptance("));
    expect(readySuccess).toContain("assertTaskSettlement: async (commit, signal)");
    expect(readySuccess).toContain("assertInstalledFunctionalClosure(functionalClosure, functionalCanary, commit, signal)");
    expect(installedSource).toContain("readFunctionalHomeJson(response, signal)");
    expect(installedSource).toContain('signal.aborted) throw new Error("functional acceptance Home read exceeded its bound"');
    expect(packagedBackup).toContain('"backup", "create"');
    expect(packagedBackup).toContain('"backup", "verify"');
    expect(packagedBackup).toContain('"backup", "restore"');
    expect(packagedBackup).toContain("HOME: blankHome");
    expect(packagedBackup).toContain('join(restoredVault, "core.md")');
    expect(packagedBackup).toContain('join(restoredVault, "owner-upgrade-canary.md")');

    const chromiumSource = await readFile(
      join(import.meta.dir, "..", "..", "scripts", "home-pwa-chromium-acceptance.ts"),
      "utf8",
    );
    expect(chromiumSource).toContain('channel: "chrome"');
    expect(chromiumSource).toContain('headless: true');
    expect(chromiumSource).toContain("RESPONSIVE_VIEWPORTS");
    expect(chromiumSource).toContain("{ width: 320, height: 568 }");
    expect(chromiumSource).toContain("{ width: 390, height: 844 }");
    expect(chromiumSource).toContain("{ width: 844, height: 390 }");
    expect(chromiumSource).toContain('reducedMotion: "reduce"');
    expect(chromiumSource).toContain("rect.width < 43.5 || rect.height < 43.5");
    expect(chromiumSource).toContain('a[href]:not(.wl)');
    expect(chromiumSource).not.toContain("recordHar:");
    expect(chromiumSource).not.toContain("recordVideo:");
    expect(chromiumSource).not.toContain("storageState:");
    expect(chromiumSource).not.toContain("screenshot(");
    expect(installedSource).toContain('"--grant", "read,capture,resolve"');
    expect(chromiumSource).toContain('["activity-source", operations.assertActivitySource]');
    expect(chromiumSource).toContain('["task-settlement", operations.assertTaskSettlement]');
    expect(chromiumSource).toContain("const TASK_SETTLEMENT_PHASE_TIMEOUT_MS = 120_000;");
    expect(chromiumSource).toContain("/pwa-64x64.png");
    expect(chromiumSource).not.toContain("favicon.ico");
    const chromiumRunner = sourceFunction(
      chromiumSource,
      "export async function runHomePwaChromiumAcceptance",
      "const RESPONSIVE_VIEWPORTS",
    );
    expect(chromiumRunner).toContain("await assertActivitySource(requirePage(), input.expected.functionalCanary)");
    expect(chromiumRunner).toContain("await settleFunctionalTask(activePage, input.expected.functionalCanary)");
    expect(chromiumSource).toContain("async function assertActivitySource(");
    expect(chromiumSource).toContain("await row.waitFor({ timeout: WAIT_MS })");
    expect(chromiumSource).toContain('getByRole("region", { name: "You\'re offline", exact: true })');
    expect(chromiumSource).not.toContain('getByText("Offline", { exact: true })');
    expect(chromiumSource).toContain('getByRole("button", { name: "Raw", exact: true })');
    expect(chromiumSource).toContain("did not switch to exact Raw content");
    expect(chromiumSource).toContain("`- [ ] #task ${canary.taskText}`");
    expect(chromiumSource).toContain("async function settleFunctionalTask(");

    const updateSource = await readFile(
      join(import.meta.dir, "..", "..", "scripts", "home-pwa-update-rehearsal.ts"),
      "utf8",
    );
    expect(updateSource).toContain('channel: "chrome"');
    expect(updateSource).toContain('headless: true');
    expect(updateSource).toContain('name: "dome_csrf"');
    expect(updateSource).toContain("synthetic-predecessor");
    expect(updateSource).toContain("registration.update()");
    expect(updateSource).toContain('name: "Update now"');
    expect(updateSource).toContain('sessionStorage.setItem("dome-rehearsal-controllerchange", "observed")');
    const updateActivation = sourceFunction(
      updateSource,
      "activateUpdate: async",
      "assertSurvival: async",
    );
    expect(updateActivation).toContain("const reloaded = activePage.waitForNavigation(");
    expect(updateActivation.indexOf("const reloaded = activePage.waitForNavigation("))
      .toBeLessThan(updateActivation.indexOf('name: "Update now"'));
    expect(updateActivation).toContain("await Promise.all([");
    expect(updateActivation).not.toContain("waitForFunction(");
    expect(updateActivation).toContain('activated.controllerchange !== "observed" || activated.marked');
    expect(updateSource).toContain("browser-fetched candidate bytes do not match the extracted artifact");
    expect(updateSource).toContain("local capture row changed during activation");
    expect(updateSource).toContain("JSON.stringify(survived) !== JSON.stringify(capture)");
    expect(updateSource).toContain("createdAt: value.createdAt");
    expect(updateSource).not.toContain("recordHar:");
    expect(updateSource).not.toContain("recordVideo:");
    expect(updateSource).not.toContain("storageState:");
    expect(updateSource).not.toContain("launchPersistentContext");
    expect(updateSource).not.toContain("screenshot(");

    const functionalSource = await readFile(
      join(import.meta.dir, "..", "..", "scripts", "home-installed-functional-closure.ts"),
      "utf8",
    );
    expect(functionalSource).toContain("export async function prepareInstalledFunctionalClosure(");
    expect(functionalSource).toContain("export async function assertInstalledFunctionalClosure(");
    expect(functionalSource).toContain('gitOk(boundary, ["add", "--", rendered.path]');
    expect(functionalSource).toContain('"commit", "-m", "add installed functional canary", "--", rendered.path');
  });

  test.each(["--skip-installed-gate", "--fixture", "--version"])(
    "the artifact CLI rejects the unsupported release override %s before building",
    async (argument) => {
      const child = Bun.spawn([
        process.execPath,
        join(import.meta.dir, "..", "..", "scripts", "home-artifact.ts"),
        argument,
      ], { stdout: "pipe", stderr: "pipe" });
      expect(await child.exited).toBe(1);
      expect(await new Response(child.stderr).text()).toContain(`unknown option: ${argument}`);
    },
  );
});

function operations(
  events: string[],
  overrides: Partial<Parameters<typeof exerciseHomeArtifactActivationForTests>[0]> = {},
): Parameters<typeof exerciseHomeArtifactActivationForTests>[0] {
  return {
    admitCandidate: async () => { events.push("admit-candidate"); },
    reconstructPredecessor: async () => { events.push("reconstruct-predecessor"); },
    runInstalledGate: async () => { events.push("run-installed-gate"); },
    bindIdentity: async () => { events.push("bind-identity"); },
    writeReceipt: async () => { events.push("write-receipt"); },
    reproveCandidate: async () => { events.push("reprove-candidate"); },
    reproveSource: async () => { events.push("reprove-source"); },
    cleanup: async () => { events.push("cleanup"); },
    reproveFinalSource: async () => { events.push("reprove-final-source"); },
    reproveFinalReceipt: async () => { events.push("reprove-final-receipt"); },
    ...overrides,
  };
}

function binding(): HomeArtifactActivationIdentityBinding {
  return {
    predecessor: {
      artifactId: "a".repeat(64),
      version: "0.1.0",
      buildCommit: "b".repeat(40),
      archiveSha256: "c".repeat(64),
      manifestSha256: "d".repeat(64),
    },
    candidate: {
      artifactId: "e".repeat(64),
      version: "0.3.0",
      buildCommit: "f".repeat(40),
      archiveSha256: "1".repeat(64),
      manifestSha256: "2".repeat(64),
    },
    fixture: {
      releaseId: "0.1.0-eb644dc2",
      sourceCommit: "b".repeat(40),
      canaryDigest: "3".repeat(64),
    },
  };
}

type MutableBinding = {
  -readonly [Key in keyof HomeArtifactActivationIdentityBinding]: {
    -readonly [Child in keyof HomeArtifactActivationIdentityBinding[Key]]:
      HomeArtifactActivationIdentityBinding[Key][Child];
  };
};

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function sourceFunction(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from === -1 || to === -1) throw new Error(`source boundary not found: ${start}`);
  return source.slice(from, to);
}
