import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HOME_ARTIFACT_SCHEMA,
  HOME_ARTIFACT_TARGET,
  PINNED_AGE_ARCHIVE_SHA256,
  PINNED_AGE_ARCHIVE_URL,
  PINNED_AGE_BINARY_SHA256,
  PINNED_AGE_KEYGEN_BINARY_SHA256,
  PINNED_AGE_LICENSE_SHA256,
  PINNED_AGE_VERSION,
  PINNED_BUN_ARCHIVE_SHA256,
  PINNED_BUN_ARCHIVE_URL,
  PINNED_BUN_BINARY_SHA256,
  PINNED_BUN_VERSION,
  type HomeArtifactManifest,
} from "../../src/product-host/home-artifact";
import {
  ensureManagedRelease,
  homeInstallationPaths,
  repairManagedRelease,
  releaseRoot,
} from "../../src/product-host/home-installation";
import { HOME_DURABLE_STATE_PROTOCOL, HOME_STORE_MIGRATIONS } from "../../src/product-host/home-store-migrations";

const ARTIFACT_ID = "b".repeat(64);

const semanticMismatches = [
  {
    name: "build identity",
    value: (base: HomeArtifactManifest): HomeArtifactManifest => ({
      ...base,
      build: { gitCommit: "2".repeat(40) },
    }),
  },
  {
    name: "writer-barrier protocol",
    value: (base: HomeArtifactManifest): HomeArtifactManifest => ({
      ...base,
      writerBarrier: { protocol: 2 as 1 },
    }),
  },
  {
    name: "durable-state protocol",
    value: (base: HomeArtifactManifest): HomeArtifactManifest => ({
      ...base,
      durableState: { ...base.durableState!, protocol: 2 as 1 },
    }),
  },
  {
    name: "distribution metadata",
    value: (base: HomeArtifactManifest): HomeArtifactManifest => ({
      ...base,
      distribution: { ...base.distribution, upgradeSupported: true },
    }),
  },
  {
    name: "runtime metadata",
    value: (base: HomeArtifactManifest): HomeArtifactManifest => ({
      ...base,
      runtime: { ...base.runtime, sourceUrl: "https://example.invalid/bun.zip" },
    }),
  },
] as const;

describe("immutable Dome Home release publication", () => {
  test("preexisting convergence is independent of manifest object key order", async () => {
    const fixture = await releaseFixture("dome-existing-release-");
    try {
      const expected = manifest();
      await mkdir(releaseRoot(fixture.paths, expected.artifact.id), { recursive: true });
      const result = await ensureManagedRelease({
        source: fixture.source,
        manifest: expected,
        paths: fixture.paths,
        platform: "darwin",
      }, {
        verifyArtifact: async () => reverseObjectKeys(expected) as HomeArtifactManifest,
      });
      expect(result).toEqual({ root: releaseRoot(fixture.paths, ARTIFACT_ID), published: false });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("concurrent publication convergence is independent of manifest object key order", async () => {
    const fixture = await releaseFixture("dome-concurrent-release-");
    try {
      const expected = manifest();
      const target = releaseRoot(fixture.paths, expected.artifact.id);
      const result = await ensureManagedRelease({
        source: fixture.source,
        manifest: expected,
        paths: fixture.paths,
        platform: "darwin",
      }, {
        verifyArtifact: async (root) => root === target
          ? reverseObjectKeys(expected) as HomeArtifactManifest
          : expected,
        syncRelease: async () => {},
        publishRelease: async (_staging, destination) => {
          await mkdir(destination);
          throw new Error("publisher lost the success response");
        },
      });
      expect(result).toEqual({ root: target, published: false });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  for (const mismatch of semanticMismatches) {
    test(`preexisting release rejects a ${mismatch.name} mismatch`, async () => {
      const fixture = await releaseFixture("dome-existing-release-mismatch-");
      try {
        const expected = manifest();
        await mkdir(releaseRoot(fixture.paths, expected.artifact.id), { recursive: true });
        expect(ensureManagedRelease({
          source: fixture.source,
          manifest: expected,
          paths: fixture.paths,
          platform: "darwin",
        }, {
          verifyArtifact: async () => mismatch.value(expected),
        })).rejects.toThrow("managed release identity mismatch");
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    });

    test(`concurrent publication winner rejects a ${mismatch.name} mismatch`, async () => {
      const fixture = await releaseFixture("dome-concurrent-release-mismatch-");
      try {
        const expected = manifest();
        const target = releaseRoot(fixture.paths, expected.artifact.id);
        expect(ensureManagedRelease({
          source: fixture.source,
          manifest: expected,
          paths: fixture.paths,
          platform: "darwin",
        }, {
          verifyArtifact: async (root) => root === target ? mismatch.value(expected) : expected,
          syncRelease: async () => {},
          publishRelease: async (_staging, destination) => {
            await mkdir(destination);
            throw new Error("concurrent publisher won");
          },
        })).rejects.toThrow("managed release publication conflicted");
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
  }

  test("repairs missing and corrupt releases while retaining atomic quarantine evidence", async () => {
    for (const fault of ["missing", "corrupt"] as const) {
      const fixture = await repairFixture(`dome-release-repair-${fault}-`);
      try {
        const target = releaseRoot(fixture.paths, ARTIFACT_ID);
        if (fault === "corrupt") {
          await mkdir(target, { recursive: true });
          await writeFile(join(target, "manifest.json"), "corrupt\n");
        }
        const result = await repairManagedRelease(fixture.input, fixture.deps);
        expect(result).toMatchObject({ root: target, published: true });
        expect(await fixture.verify(target)).toEqual(fixture.expected);
        const quarantines = (await readdir(fixture.paths.releases))
          .filter((name) => name.startsWith(`.quarantine-${ARTIFACT_ID}-`));
        expect(quarantines).toHaveLength(fault === "corrupt" ? 1 : 0);
      } finally { await rm(fixture.root, { recursive: true, force: true }); }
    }
  });

  test("repair retries converge across stage, quarantine, and publication crash windows", async () => {
    for (const checkpoint of [
      "replacement-staged",
      "corrupt-release-quarantined",
      "candidate-release-published",
    ] as const) {
      const fixture = await repairFixture(`dome-release-repair-${checkpoint}-`);
      try {
        const target = releaseRoot(fixture.paths, ARTIFACT_ID);
        await mkdir(target, { recursive: true });
        await writeFile(join(target, "manifest.json"), "corrupt\n");
        let crashed = false;
        await expect(repairManagedRelease(fixture.input, {
          ...fixture.deps,
          repairReleaseCheckpoint: async (name) => {
            if (!crashed && name === checkpoint) {
              crashed = true;
              throw new Error(`crash at ${name}`);
            }
          },
        })).rejects.toThrow(`crash at ${checkpoint}`);
        expect(crashed).toBeTrue();
        const names = await readdir(fixture.paths.releases);
        if (checkpoint === "replacement-staged") {
          expect(await readFile(join(target, "manifest.json"), "utf8")).toBe("corrupt\n");
          expect(names.some((name) => name.startsWith(".quarantine-"))).toBeFalse();
        } else if (checkpoint === "corrupt-release-quarantined") {
          await expect(readFile(join(target, "manifest.json"))).rejects.toThrow();
          expect(names.some((name) => name.startsWith(".quarantine-"))).toBeTrue();
        } else {
          expect(await fixture.verify(target)).toEqual(fixture.expected);
        }
        const retry = await repairManagedRelease(fixture.input, fixture.deps);
        expect(retry.root).toBe(target);
        expect(await fixture.verify(target)).toEqual(fixture.expected);
      } finally { await rm(fixture.root, { recursive: true, force: true }); }
    }
  });

  test("valid same-id manifest collision fails without quarantine", async () => {
    const fixture = await repairFixture("dome-release-valid-collision-");
    try {
      const target = releaseRoot(fixture.paths, ARTIFACT_ID);
      const collision = semanticMismatches[0].value(fixture.expected);
      await mkdir(target, { recursive: true });
      const collisionBytes = `${JSON.stringify(collision)}\n`;
      await writeFile(join(target, "manifest.json"), collisionBytes);
      await expect(repairManagedRelease(fixture.input, fixture.deps)).rejects.toThrow(
        "valid managed release collision is not quarantineable",
      );
      expect(await readFile(join(target, "manifest.json"), "utf8")).toBe(collisionBytes);
      expect((await readdir(fixture.paths.releases)).some((name) => name.startsWith(".quarantine-"))).toBeFalse();
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  test("wrong source fingerprints and invalid staged copies never displace the target", async () => {
    const wrongSource = await repairFixture("dome-release-wrong-source-");
    try {
      await writeFile(join(wrongSource.source, "manifest.json"), `${JSON.stringify(wrongSource.expected)} \n`);
      await expect(repairManagedRelease(wrongSource.input, wrongSource.deps)).rejects.toThrow(
        "invoking repair candidate manifest fingerprint mismatch",
      );
      await expect(readdir(wrongSource.paths.releases)).rejects.toThrow();
    } finally { await rm(wrongSource.root, { recursive: true, force: true }); }

    const invalidStage = await repairFixture("dome-release-invalid-stage-");
    try {
      const target = releaseRoot(invalidStage.paths, ARTIFACT_ID);
      await mkdir(target, { recursive: true });
      await writeFile(join(target, "manifest.json"), "corrupt\n");
      await expect(repairManagedRelease(invalidStage.input, {
        ...invalidStage.deps,
        verifyArtifact: async (path) => path.includes(".repair-staging-")
          ? semanticMismatches[0].value(invalidStage.expected)
          : invalidStage.verify(path),
      })).rejects.toThrow("staged repair candidate semantic identity mismatch");
      expect(await readFile(join(target, "manifest.json"), "utf8")).toBe("corrupt\n");
      expect((await readdir(invalidStage.paths.releases)).some((name) => name.startsWith(".quarantine-"))).toBeFalse();
    } finally { await rm(invalidStage.root, { recursive: true, force: true }); }
  });

  test("concurrent exact repairs converge to one publication and one quarantine", async () => {
    const fixture = await repairFixture("dome-release-concurrent-repair-");
    try {
      const target = releaseRoot(fixture.paths, ARTIFACT_ID);
      await mkdir(target, { recursive: true });
      await writeFile(join(target, "manifest.json"), "corrupt\n");
      const repaired = await Promise.all([
        repairManagedRelease(fixture.input, fixture.deps),
        repairManagedRelease(fixture.input, fixture.deps),
      ]);
      expect(repaired.filter((result) => result.published)).toHaveLength(1);
      expect(repaired.filter((result) => !result.published)).toHaveLength(1);
      expect((await readdir(fixture.paths.releases))
        .filter((name) => name.startsWith(".quarantine-"))).toHaveLength(1);
      expect(await fixture.verify(target)).toEqual(fixture.expected);
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  test("retry closes ambiguous release publication and parent-sync failure gaps", async () => {
    const fixture = await repairFixture("dome-release-durable-retry-");
    try {
      let parentSyncs = 0;
      await expect(repairManagedRelease(fixture.input, {
        ...fixture.deps,
        publishRelease: async (source, target) => {
          await rename(source, target);
          throw new Error("publisher lost rename completion");
        },
        syncReleaseParent: async () => {
          parentSyncs++;
          throw new Error("release parent sync failed");
        },
      })).rejects.toThrow("release parent sync failed");
      expect(await fixture.verify(releaseRoot(fixture.paths, ARTIFACT_ID))).toEqual(fixture.expected);
      expect(parentSyncs).toBe(1);

      const retry = await repairManagedRelease(fixture.input, {
        ...fixture.deps,
        syncReleaseParent: async () => { parentSyncs++; },
      });
      expect(retry).toEqual({
        root: releaseRoot(fixture.paths, ARTIFACT_ID),
        published: false,
        quarantined: null,
      });
      expect(parentSyncs).toBe(2);
      expect(await fixture.verify(retry.root)).toEqual(fixture.expected);

      let ordinarySyncs = 0;
      await expect(ensureManagedRelease({
        source: fixture.source,
        manifest: fixture.expected,
        paths: fixture.paths,
        platform: "darwin",
      }, {
        ...fixture.deps,
        syncReleaseParent: async () => {
          ordinarySyncs++;
          throw new Error("ordinary parent sync failed");
        },
      })).rejects.toThrow("ordinary parent sync failed");
      expect((await ensureManagedRelease({
        source: fixture.source,
        manifest: fixture.expected,
        paths: fixture.paths,
        platform: "darwin",
      }, {
        ...fixture.deps,
        syncReleaseParent: async () => { ordinarySyncs++; },
      })).published).toBeFalse();
      expect(ordinarySyncs).toBe(2);
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  test("normal publisher waits for same-artifact repair and observes its valid winner", async () => {
    const fixture = await repairFixture("dome-release-publish-repair-race-");
    try {
      const target = releaseRoot(fixture.paths, ARTIFACT_ID);
      await mkdir(target, { recursive: true });
      await writeFile(join(target, "manifest.json"), "corrupt\n");
      let entered!: () => void;
      const quarantineEntered = new Promise<void>((resolve) => { entered = resolve; });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const repair = repairManagedRelease(fixture.input, {
        ...fixture.deps,
        quarantineRelease: async (source, destination) => {
          entered();
          await gate;
          await rename(source, destination);
        },
      });
      await quarantineEntered;
      const publisher = ensureManagedRelease({
        source: fixture.source,
        manifest: fixture.expected,
        paths: fixture.paths,
        platform: "darwin",
      }, fixture.deps);
      release();
      expect(await repair).toMatchObject({ published: true });
      expect(await publisher).toEqual({ root: target, published: false });
      expect(await fixture.verify(target)).toEqual(fixture.expected);
      expect((await readdir(fixture.paths.releases))
        .filter((name) => name.startsWith(".quarantine-"))).toHaveLength(1);
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });
});

async function releaseFixture(prefix: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const source = join(root, "artifact");
  await mkdir(source);
  const paths = homeInstallationPaths("/vault", { applicationSupportDir: join(root, "support") });
  return { root, source, paths };
}

async function repairFixture(prefix: string) {
  const base = await releaseFixture(prefix);
  const expected = manifest();
  const manifestBytes = `${JSON.stringify(expected)}\n`;
  await writeFile(join(base.source, "manifest.json"), manifestBytes);
  const verify = async (path: string): Promise<HomeArtifactManifest> => {
    const raw = await readFile(join(path, "manifest.json"), "utf8");
    let parsed: HomeArtifactManifest;
    try { parsed = JSON.parse(raw) as HomeArtifactManifest; }
    catch { throw new Error("intrinsically corrupt artifact"); }
    return parsed;
  };
  return {
    ...base,
    expected,
    verify,
    input: {
      source: base.source,
      manifest: expected,
      expectedManifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
      paths: base.paths,
      platform: "darwin" as const,
    },
    deps: {
      verifyArtifact: verify,
      syncRelease: async () => {},
      publishRelease: rename,
      quarantineRelease: rename,
    },
  };
}

function manifest(): HomeArtifactManifest {
  return {
    schema: HOME_ARTIFACT_SCHEMA,
    product: { name: "Dome Home", version: "2.0.0" },
    target: HOME_ARTIFACT_TARGET,
    build: { gitCommit: "1".repeat(40) },
    artifact: { id: ARTIFACT_ID },
    runtime: {
      name: "bun",
      version: PINNED_BUN_VERSION,
      sourceUrl: PINNED_BUN_ARCHIVE_URL,
      archiveSha256: PINNED_BUN_ARCHIVE_SHA256,
      sha256: PINNED_BUN_BINARY_SHA256,
    },
    tools: [
      {
        name: "age",
        version: PINNED_AGE_VERSION,
        path: "runtime/age",
        sourceUrl: PINNED_AGE_ARCHIVE_URL,
        archiveSha256: PINNED_AGE_ARCHIVE_SHA256,
        sha256: PINNED_AGE_BINARY_SHA256,
        licensePath: "licenses/age-LICENSE",
        licenseSha256: PINNED_AGE_LICENSE_SHA256,
      },
      {
        name: "age-keygen",
        version: PINNED_AGE_VERSION,
        path: "runtime/age-keygen",
        sourceUrl: PINNED_AGE_ARCHIVE_URL,
        archiveSha256: PINNED_AGE_ARCHIVE_SHA256,
        sha256: PINNED_AGE_KEYGEN_BINARY_SHA256,
        licensePath: "licenses/age-LICENSE",
        licenseSha256: PINNED_AGE_LICENSE_SHA256,
      },
    ],
    entrypoint: "bin/dome",
    pwa: "app/pwa/dist",
    writerBarrier: { protocol: 1 },
    durableState: { protocol: HOME_DURABLE_STATE_PROTOCOL, stores: HOME_STORE_MIGRATIONS },
    distribution: { signed: false, notarized: false, upgradeSupported: false },
    entries: [{
      type: "file",
      path: "runtime/bun",
      bytes: 1,
      sha256: PINNED_BUN_BINARY_SHA256,
      mode: "0755",
    }],
  };
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value)
    .reverse()
    .map(([key, child]) => [key, reverseObjectKeys(child)]));
}
