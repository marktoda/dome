import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { commit, initRepo } from "../../src/git";
import {
  PINNED_AGE_VERSION,
  PINNED_BUN_VERSION,
  type HomeArtifactVerificationEvidence,
} from "../../src/product-host/home-artifact";
import {
  PRODUCT_PACKAGE_NAME,
  PRODUCT_PACKAGE_SCHEMA,
  PRODUCT_PACKAGE_VERSION,
  type ProductPackageFile,
  type ProductPackageManifest,
} from "../../src/product-package/manifest";
import { discoverInitProduct } from "../../src/setup/init-product";
import { writeArtifactMetadata } from "../../scripts/home-artifact";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("init product evidence", () => {
  test("verifies a packaged distribution through its closed product manifest", async () => {
    const fixture = await packagedRoot();
    const evidence = await discoverInitProduct(fixture.root);
    expect(evidence).toMatchObject({
      distribution: "packaged",
      packageName: PRODUCT_PACKAGE_NAME,
      packageVersion: PRODUCT_PACKAGE_VERSION,
      sourceCommit: fixture.manifest.package.sourceCommit,
      packagedHome: {
        artifactId: fixture.manifest.home.artifactId,
        buildCommit: fixture.manifest.home.buildCommit,
        manifestSha256: fixture.manifest.home.manifestSha256,
      },
    });
    if (evidence.distribution !== "packaged") throw new Error("expected packaged evidence");
    expect(evidence.productManifestSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("identifies a direct source checkout without claiming Home authority", async () => {
    const root = await sourceRoot("dome-init-source-");
    const evidence = await discoverInitProduct(root);
    expect(evidence.distribution).toBe("source-tree");
    expect(evidence.packagedHome).toBeNull();
    expect(evidence.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
    if (evidence.distribution !== "source-tree") throw new Error("expected source-tree evidence");
    expect(evidence.sourceTreeSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("binds an exact source-built Home app to its enclosing artifact manifest", async () => {
    const fixture = await homeArtifactRoot();
    const evidence = await discoverInitProduct(join(fixture.root, "app"), async (artifactRoot) => {
      expect(artifactRoot).toBe(fixture.root);
      return fixture.evidence;
    });
    expect(evidence).toEqual({
      distribution: "home-artifact",
      packageName: PRODUCT_PACKAGE_NAME,
      packageVersion: fixture.evidence.manifest.product.version,
      sourceCommit: fixture.evidence.manifest.build.gitCommit,
      homeArtifactManifestSha256: fixture.evidence.manifestSha256,
      packagedHome: null,
    });
  });

  test("selects Home artifact verification permanently and never falls back to Git", async () => {
    const fixture = await homeArtifactRoot();
    await initRepo(join(fixture.root, "app"));
    await writeFile(join(fixture.root, "manifest.json"), "{}\n");
    await expect(discoverInitProduct(join(fixture.root, "app")))
      .rejects.toThrow("unknown or missing fields");
  });

  test("rejects a symlink alias before trusting Home artifact verification", async () => {
    const fixture = await homeArtifactRoot();
    const aliasRoot = await mkdtemp(join(tmpdir(), "dome-init-home-alias-"));
    roots.push(aliasRoot);
    const alias = join(aliasRoot, "app");
    await symlink(join(fixture.root, "app"), alias);
    await writeFile(join(aliasRoot, "manifest.json"), "{}\n");
    let verifierCalled = false;
    await expect(discoverInitProduct(alias, async () => {
      verifierCalled = true;
      return fixture.evidence;
    })).rejects.toThrow("exact canonical app directory");
    expect(verifierCalled).toBe(false);
  });

  test("never falls back to Git when a packaged manifest is tampered", async () => {
    const root = await sourceRoot("dome-init-tampered-");
    await mkdir(join(root, "product"));
    await writeFile(join(root, "product", "manifest.json"), "{}\n", { mode: 0o644 });
    await expect(discoverInitProduct(root)).rejects.toThrow("product package manifest schema is invalid");
  });

  test("does not borrow Git identity from an ancestor repository", async () => {
    const ancestor = await sourceRoot("dome-init-ancestor-");
    const nested = join(ancestor, "installed", "@marktoda", "dome");
    await mkdir(nested, { recursive: true });
    await expect(discoverInitProduct(nested)).rejects.toThrow("product evidence is unavailable");
  });
});

async function sourceRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  await initRepo(root);
  await writeFile(join(root, "seed.md"), "seed\n");
  await commit({ path: root, message: "seed", files: ["seed.md"] });
  return root;
}

async function packagedRoot(): Promise<Readonly<{ root: string; manifest: ProductPackageManifest }>> {
  const root = await mkdtemp(join(tmpdir(), "dome-init-packaged-"));
  roots.push(root);
  const sourceCommit = "1".repeat(40);
  const rows: ProductPackageFile[] = [];
  for (const [path, body, mode] of [
    ["LICENSE", "MIT\n", 0o644],
    ["README.md", "# Dome\n", 0o644],
    ["package.json", "{}\n", 0o644],
    ["bin/dome", "#!/usr/bin/env bun\n", 0o755],
    ["src/index.ts", "export {};\n", 0o644],
    ["product/pwa/index.html", "<main>Dome</main>\n", 0o644],
    ["product/home/dome-home-0.4.0-darwin-arm64.tar.gz", "archive\n", 0o644],
  ] as const) {
    const absolute = join(root, ...path.split("/"));
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, body, { mode });
    await chmod(absolute, mode);
    rows.push(Object.freeze({
      path,
      bytes: Buffer.byteLength(body),
      sha256: sha256(body),
      mode: mode === 0o755 ? "0755" : "0644",
    }));
  }
  rows.sort((left, right) => left.path < right.path ? -1 : 1);
  const home = rows.find((row) => row.path.startsWith("product/home/"))!;
  const pwa = rows.filter((row) => row.path.startsWith("product/pwa/"));
  const manifest: ProductPackageManifest = Object.freeze({
    schema: PRODUCT_PACKAGE_SCHEMA,
    package: Object.freeze({ name: PRODUCT_PACKAGE_NAME, version: PRODUCT_PACKAGE_VERSION, sourceCommit }),
    platform: Object.freeze({ os: "darwin", arch: "arm64" }),
    home: Object.freeze({
      path: home.path,
      bytes: home.bytes,
      sha256: home.sha256,
      root: "dome-home-0.4.0-darwin-arm64",
      manifestSha256: "b".repeat(64),
      artifactId: "a".repeat(64),
      productVersion: PRODUCT_PACKAGE_VERSION,
      buildCommit: sourceCommit,
    }),
    pwa: Object.freeze({ root: "product/pwa", entries: Object.freeze(pwa) }),
    files: Object.freeze(rows),
  });
  await writeFile(
    join(root, "product", "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o644 },
  );
  return Object.freeze({ root, manifest });
}

async function homeArtifactRoot(): Promise<Readonly<{
  root: string;
  evidence: HomeArtifactVerificationEvidence;
}>> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dome-init-home-artifact-")));
  roots.push(root);
  for (const directory of ["app/pwa/dist", "bin", "licenses", "runtime"]) {
    await mkdir(join(root, directory), { recursive: true });
  }
  await writeFile(join(root, "app", "pwa", "dist", "index.html"), "<main>Dome</main>\n");
  await writeFile(join(root, "bin", "dome"), "#!/bin/sh\n", { mode: 0o755 });
  await chmod(join(root, "bin", "dome"), 0o755);
  await writeFile(join(root, "runtime", "bun"), `#!/bin/sh\necho ${PINNED_BUN_VERSION}\n`, { mode: 0o755 });
  await writeFile(join(root, "runtime", "age"), `#!/bin/sh\necho v${PINNED_AGE_VERSION}\n`, { mode: 0o755 });
  await writeFile(join(root, "runtime", "age-keygen"), `#!/bin/sh\necho v${PINNED_AGE_VERSION}\n`, { mode: 0o755 });
  await chmod(join(root, "runtime", "bun"), 0o755);
  await chmod(join(root, "runtime", "age"), 0o755);
  await chmod(join(root, "runtime", "age-keygen"), 0o755);
  await writeFile(join(root, "licenses", "age-LICENSE"), "fixture license\n");
  const manifest = await writeArtifactMetadata(root, PRODUCT_PACKAGE_VERSION, "5".repeat(40));
  return Object.freeze({
    root,
    evidence: Object.freeze({
      manifest,
      manifestSha256: sha256(await readFile(join(root, "manifest.json"))),
    }),
  });
}

function sha256(body: string | Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}
