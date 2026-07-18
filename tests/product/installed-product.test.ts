import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  verifyInstalledProduct,
  verifyInstalledProductReadOnly,
  type InstalledProductVerifierDependencies,
} from "../../src/product-package/installed-product";
import {
  PRODUCT_PACKAGE_NAME,
  PRODUCT_PACKAGE_SCHEMA,
  PRODUCT_PACKAGE_VERSION,
  type ProductPackageFile,
  type ProductPackageManifest,
} from "../../src/product-package/manifest";
import type { HomeArtifactManifest } from "../../src/product-host/home-artifact";

describe("installed complete-product verifier", () => {
  test("exposes a read-only closed-package proof without Home materialization", async () => {
    const fixture = await installedFixture();
    try {
      const evidence = await verifyInstalledProductReadOnly({ packageRoot: fixture.root });
      expect(evidence.filesVerified).toBe(fixture.manifest.files.length);
      expect(evidence.declaredHome).toEqual({
        artifactId: fixture.manifest.home.artifactId,
        archiveSha256: fixture.manifest.home.sha256,
        manifestSha256: fixture.manifest.home.manifestSha256,
        buildCommit: fixture.manifest.home.buildCommit,
      });
      expect(fixture.materializations()).toBe(0);
    } finally { await fixture.cleanup(); }
  });

  test("closes the installed tree and Home provenance through one shipped seam", async () => {
    const fixture = await installedFixture();
    try {
      await chmod(join(fixture.root, "product"), 0o700);
      await chmod(join(fixture.root, "product", "pwa"), 0o750);
      const evidence = await verifyInstalledProduct({ packageRoot: fixture.root }, fixture.dependencies());
      expect(evidence.filesVerified).toBe(fixture.manifest.files.length);
      expect(evidence.pwaFilesVerified).toBe(1);
      expect(evidence.home).toEqual({
        artifactId: "a".repeat(64),
        archiveSha256: fixture.manifest.home.sha256,
        manifestSha256: fixture.manifest.home.manifestSha256,
        buildCommit: fixture.manifest.package.sourceCommit,
      });
    } finally { await fixture.cleanup(); }
  });

  test("rejects group- or world-writable installed directories", async () => {
    for (const mode of [0o770, 0o755 | 0o002]) {
      const fixture = await installedFixture();
      try {
        await chmod(join(fixture.root, "product", "pwa"), mode);
        await expect(verifyInstalledProduct({ packageRoot: fixture.root }, fixture.dependencies()))
          .rejects.toThrow("directory mode is unsafe");
        expect(fixture.materializations()).toBe(0);
      } finally { await fixture.cleanup(); }
    }
  });

  test("admits exactly one npm-owned root dependency subtree without treating it as package evidence", async () => {
    const fixture = await installedFixture();
    try {
      const dependencyRoot = join(fixture.root, "node_modules");
      await mkdir(join(dependencyRoot, "commander"), { recursive: true });
      await writeFile(join(dependencyRoot, "commander", "package.json"), "{\"name\":\"commander\"}\n");
      await chmod(dependencyRoot, 0o755);
      const evidence = await verifyInstalledProduct({ packageRoot: fixture.root }, fixture.dependencies());
      expect(evidence.filesVerified).toBe(fixture.manifest.files.length);
      expect(fixture.materializations()).toBe(1);
    } finally { await fixture.cleanup(); }
  });

  test("rejects unsafe or aliased npm ownership roots and every similarly named root extra", async () => {
    for (const mutation of ["unsafe-node-modules", "linked-node-modules", "lookalike"] as const) {
      const fixture = await installedFixture();
      try {
        if (mutation === "unsafe-node-modules") {
          await mkdir(join(fixture.root, "node_modules"));
          await chmod(join(fixture.root, "node_modules"), 0o777);
        } else if (mutation === "linked-node-modules") {
          const target = join(fixture.temporary, "dependencies");
          await mkdir(target);
          await symlink(target, join(fixture.root, "node_modules"));
        } else {
          await mkdir(join(fixture.root, "node_modules-copy"));
        }
        const expected = mutation === "unsafe-node-modules" ? "package-manager directory mode is unsafe" :
          mutation === "linked-node-modules" ? "package-manager root is not a direct directory" :
            "unexpected directory: node_modules-copy";
        await expect(verifyInstalledProduct({ packageRoot: fixture.root }, fixture.dependencies()))
          .rejects.toThrow(expected);
        expect(fixture.materializations()).toBe(0);
      } finally { await fixture.cleanup(); }
    }
  });

  test("rejects a product manifest that claims npm-owned dependency paths", async () => {
    const fixture = await installedFixture();
    try {
      const dependency = join(fixture.root, "node_modules", "commander", "package.json");
      const body = Buffer.from("{\"name\":\"commander\"}\n");
      await mkdir(join(dependency, ".."), { recursive: true });
      await writeFile(dependency, body);
      const manifestPath = join(fixture.root, "product", "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { files: ProductPackageFile[] };
      manifest.files.push({ path: "node_modules/commander/package.json", bytes: body.byteLength, sha256: sha256(body), mode: "0644" });
      manifest.files.sort((left, right) => left.path < right.path ? -1 : 1);
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      await expect(verifyInstalledProduct({ packageRoot: fixture.root }, fixture.dependencies()))
        .rejects.toThrow("product package contains development or secret path");
      expect(fixture.materializations()).toBe(0);
    } finally { await fixture.cleanup(); }
  });

  test("rejects root aliases, extras, symlinks, byte drift, and mode drift before Home admission", async () => {
    for (const mutation of ["root-link", "extra-file", "extra-dir", "symlink", "bytes", "mode"] as const) {
      const fixture = await installedFixture();
      let requestedRoot = fixture.root;
      try {
        if (mutation === "root-link") {
          requestedRoot = join(fixture.temporary, "root-link");
          await symlink(fixture.root, requestedRoot);
        } else if (mutation === "extra-file") {
          await writeFile(join(fixture.root, "product", "pwa", "extra.js"), "extra\n");
        } else if (mutation === "extra-dir") {
          await mkdir(join(fixture.root, "product", "pwa", "empty"));
        } else if (mutation === "symlink") {
          await symlink("index.html", join(fixture.root, "product", "pwa", "alias.html"));
        } else if (mutation === "bytes") {
          await writeFile(join(fixture.root, "README.md"), "drift\n");
        } else {
          await chmod(join(fixture.root, "README.md"), 0o600);
        }
        await expect(verifyInstalledProduct({ packageRoot: requestedRoot }, fixture.dependencies()))
          .rejects.toThrow();
        expect(fixture.materializations()).toBe(0);
      } finally { await fixture.cleanup(); }
    }
  });

  test("preserves Home provenance failure together with disposal failure", async () => {
    const fixture = await installedFixture();
    try {
      let caught: unknown;
      try {
        await verifyInstalledProduct({ packageRoot: fixture.root }, fixture.dependencies({
          buildCommit: "f".repeat(40),
          disposeError: new Error("dispose failed"),
        }));
      } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(AggregateError);
      const messages = (caught as AggregateError).errors.map(String).join(" ");
      expect(messages).toContain("Home provenance");
      expect(messages).toContain("dispose failed");
    } finally { await fixture.cleanup(); }
  });
});

async function installedFixture(): Promise<Readonly<{
  temporary: string;
  root: string;
  manifest: ProductPackageManifest;
  materializations(): number;
  dependencies(options?: Readonly<{ buildCommit?: string; disposeError?: Error }>): InstalledProductVerifierDependencies;
  cleanup(): Promise<void>;
}>> {
  const temporary = await mkdtemp(join(tmpdir(), "dome-installed-product-test-"));
  const root = join(temporary, "package");
  await mkdir(root);
  const sourceCommit = "1".repeat(40);
  const rows: ProductPackageFile[] = [];
  for (const [path, body, mode] of [
    ["LICENSE", "MIT\n", 0o644],
    ["README.md", "# Dome\n", 0o644],
    ["package.json", "{}\n", 0o644],
    ["bin/dome", "#!/usr/bin/env bun\n", 0o755],
    ["src/index.ts", "export {};\n", 0o644],
    ["product/pwa/index.html", "<main>Dome</main>\n", 0o644],
    ["product/home/dome-home-0.4.0-darwin-arm64.tar.gz", "fake archive\n", 0o644],
  ] as const) {
    const absolute = join(root, ...path.split("/"));
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, body, { mode });
    await chmod(absolute, mode);
    rows.push(Object.freeze({ path, bytes: Buffer.byteLength(body), sha256: sha256(Buffer.from(body)), mode: mode === 0o755 ? "0755" : "0644" }));
  }
  rows.sort((left, right) => left.path < right.path ? -1 : 1);
  const homeRow = rows.find((row) => row.path.startsWith("product/home/"))!;
  const pwa = rows.filter((row) => row.path.startsWith("product/pwa/"));
  const manifest: ProductPackageManifest = Object.freeze({
    schema: PRODUCT_PACKAGE_SCHEMA,
    package: Object.freeze({ name: PRODUCT_PACKAGE_NAME, version: PRODUCT_PACKAGE_VERSION, sourceCommit }),
    platform: Object.freeze({ os: "darwin", arch: "arm64" }),
    home: Object.freeze({
      path: homeRow.path,
      bytes: homeRow.bytes,
      sha256: homeRow.sha256,
      root: "dome-home-0.4.0-darwin-arm64",
      manifestSha256: "b".repeat(64),
      artifactId: "a".repeat(64),
      productVersion: PRODUCT_PACKAGE_VERSION,
      buildCommit: sourceCommit,
    }),
    pwa: Object.freeze({ root: "product/pwa", entries: Object.freeze(pwa) }),
    files: Object.freeze(rows),
  });
  const manifestPath = join(root, "product", "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  await chmod(manifestPath, 0o644);
  let count = 0;
  return Object.freeze({
    temporary,
    root,
    manifest,
    materializations: () => count,
    dependencies: (options = {}) => Object.freeze({
      materializeHome: async (input) => {
        count += 1;
        expect(input.expected).toMatchObject({
          compressedBytes: manifest.home.bytes,
          compressedSha256: manifest.home.sha256,
          artifactId: manifest.home.artifactId,
        });
        const homeManifest = {
          build: { gitCommit: options.buildCommit ?? sourceCommit },
          artifact: { id: manifest.home.artifactId },
        } as unknown as HomeArtifactManifest;
        const materializedRoot = join(temporary, manifest.home.root);
        await mkdir(materializedRoot, { recursive: true });
        return Object.freeze({
          root: materializedRoot,
          manifest: homeManifest,
          archiveBytes: manifest.home.bytes,
          archiveSha256: manifest.home.sha256,
          manifestBytes: 1,
          manifestSha256: manifest.home.manifestSha256,
          dispose: async () => { if (options.disposeError !== undefined) throw options.disposeError; },
        });
      },
    }),
    cleanup: async () => await rm(temporary, { recursive: true, force: true }),
  });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
