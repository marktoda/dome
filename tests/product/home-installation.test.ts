import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
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
      distribution: { ...base.distribution, upgradeSupported: true as false },
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
});

async function releaseFixture(prefix: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const source = join(root, "artifact");
  await mkdir(source);
  const paths = homeInstallationPaths("/vault", { applicationSupportDir: join(root, "support") });
  return { root, source, paths };
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
