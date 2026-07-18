import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { createDeterministicTar } from "../../scripts/home-artifact";
import {
  createNormalizedHomeArtifactTarHeader,
  inspectHomeArtifactTar,
  MAX_HOME_ARTIFACT_ENTRIES,
  MAX_HOME_ARTIFACT_MANIFEST_BYTES,
  materializeHomeArtifactArchive,
} from "../../src/product-host/home-artifact-archive";

describe("Home artifact archive boundary", () => {
  test("binds one stable archive and raw manifest before the shipped verifier", async () => {
    const fixture = await archiveFixture();
    const temporaryParent = await mkdtemp(join(tmpdir(), "dome-home-archive-materialize-"));
    try {
      const inspected = inspectHomeArtifactTar(fixture.tar);
      expect(inspected.root).toBe("artifact");
      expect(inspected.entries.map((entry) => entry.path)).toEqual([
        "artifact", "artifact/manifest.json", "artifact/payload.txt",
      ]);
      await expect(materializeHomeArtifactArchive({
        archive: fixture.archive,
        temporaryParent,
        expected: {
          compressedBytes: fixture.compressed.byteLength,
          compressedSha256: sha256(fixture.compressed),
          artifactRoot: "artifact",
          manifestBytes: fixture.manifestBytes.byteLength,
          manifestSha256: sha256(fixture.manifestBytes),
          artifactId: "artifact-test",
          productVersion: "9.8.7",
        },
      })).rejects.toThrow();
      expect(await readdir(temporaryParent)).toEqual([]);
    } finally {
      await fixture.cleanup();
      await rm(temporaryParent, { recursive: true, force: true });
    }
  });

  test("rejects non-regular aliases, bounded-size drift, and digest drift before extraction", async () => {
    const fixture = await archiveFixture();
    const temporaryParent = await mkdtemp(join(tmpdir(), "dome-home-archive-input-"));
    const alias = `${fixture.archive}.alias`;
    try {
      await symlink(fixture.archive, alias);
      await expect(materializeHomeArtifactArchive({
        archive: alias,
        temporaryParent,
      })).rejects.toThrow("bounded regular file");
      await expect(materializeHomeArtifactArchive({
        archive: fixture.archive,
        temporaryParent,
        maxCompressedBytes: fixture.compressed.byteLength - 1,
      })).rejects.toThrow("bounded regular file");
      await expect(materializeHomeArtifactArchive({
        archive: fixture.archive,
        temporaryParent,
        expected: { compressedBytes: fixture.compressed.byteLength + 1 },
      })).rejects.toThrow("archive size differs");
      await expect(materializeHomeArtifactArchive({
        archive: fixture.archive,
        temporaryParent,
        expected: { compressedSha256: "0".repeat(64) },
      })).rejects.toThrow("archive digest differs");
      expect(await readdir(temporaryParent)).toEqual([]);
    } finally {
      await rm(alias, { force: true });
      await fixture.cleanup();
      await rm(temporaryParent, { recursive: true, force: true });
    }
  });

  test("rejects traversal and special-file USTAR before creating a workspace", async () => {
    const fixture = await archiveFixture();
    const temporaryParent = await mkdtemp(join(tmpdir(), "dome-home-archive-hostile-"));
    try {
      const traversal = Buffer.from(fixture.tar);
      rewriteTarName(traversal, 512, "artifact/../escape");
      const traversalArchive = join(fixture.temporary, "traversal.tar.gz");
      await writeFile(traversalArchive, gzipSync(traversal));
      await expect(materializeHomeArtifactArchive({
        archive: traversalArchive,
        temporaryParent,
      })).rejects.toThrow("path is unsafe");

      const special = Buffer.from(fixture.tar);
      special[512 + 156] = "3".charCodeAt(0);
      rewriteTarChecksum(special, 512);
      const specialArchive = join(fixture.temporary, "special.tar.gz");
      await writeFile(specialArchive, gzipSync(special));
      expect(() => inspectHomeArtifactTar(special)).toThrow("unsupported entry type");
      await expect(materializeHomeArtifactArchive({
        archive: specialArchive,
        temporaryParent,
      })).rejects.toThrow("unsupported entry type");
      expect(await readdir(temporaryParent)).toEqual([]);
    } finally {
      await fixture.cleanup();
      await rm(temporaryParent, { recursive: true, force: true });
    }
  });

  test("rejects over-cardinality and oversized-manifest archives before creating a workspace", async () => {
    const fixture = await archiveFixture();
    const temporaryParent = await mkdtemp(join(tmpdir(), "dome-home-archive-budget-"));
    try {
      const headers = [createNormalizedHomeArtifactTarHeader(
        "artifact/",
        { mode: 0o755, size: 0, type: "5", link: "" },
      )];
      for (let index = 0; index < MAX_HOME_ARTIFACT_ENTRIES; index += 1) {
        headers.push(createNormalizedHomeArtifactTarHeader(
          `artifact/file-${index.toString().padStart(5, "0")}`,
          { mode: 0o644, size: 0, type: "0", link: "" },
        ));
      }
      headers.push(Buffer.alloc(1024));
      const overCardinality = join(fixture.temporary, "over-cardinality.tar.gz");
      await writeFile(overCardinality, gzipSync(Buffer.concat(headers)));
      await expect(materializeHomeArtifactArchive({
        archive: overCardinality,
        temporaryParent,
      })).rejects.toThrow("entry budget");
      expect(await readdir(temporaryParent)).toEqual([]);

      const oversizedBody = Buffer.alloc(MAX_HOME_ARTIFACT_MANIFEST_BYTES + 1, 0x20);
      const oversizedManifest = normalizedTar([
        { path: "artifact/", mode: 0o755, type: "5", body: Buffer.alloc(0) },
        { path: "artifact/manifest.json", mode: 0o644, type: "0", body: oversizedBody },
      ]);
      const oversizedManifestArchive = join(fixture.temporary, "oversized-manifest.tar.gz");
      await writeFile(oversizedManifestArchive, gzipSync(oversizedManifest));
      await expect(materializeHomeArtifactArchive({
        archive: oversizedManifestArchive,
        temporaryParent,
      })).rejects.toThrow("raw manifest exceeds");
      expect(await readdir(temporaryParent)).toEqual([]);
    } finally {
      await fixture.cleanup();
      await rm(temporaryParent, { recursive: true, force: true });
    }
  });

  test("rejects every noncanonical builder-owned USTAR header field before extraction", async () => {
    const fixture = await archiveFixture();
    const temporaryParent = await mkdtemp(join(tmpdir(), "dome-home-archive-header-"));
    const mutations: ReadonlyArray<readonly [string, (tar: Buffer) => void]> = [
      ["mode", (tar) => rewriteTarOctal(tar, 512, 100, 8, 0o600)],
      ["special mode", (tar) => rewriteTarOctal(tar, 512, 100, 8, 0o4644)],
      ["uid", (tar) => rewriteTarOctal(tar, 512, 108, 8, 1)],
      ["gid", (tar) => rewriteTarOctal(tar, 512, 116, 8, 1)],
      ["mtime", (tar) => rewriteTarOctal(tar, 512, 136, 12, 1)],
      ["uname", (tar) => rewriteTarByte(tar, 512, 265, "R")],
      ["gname", (tar) => rewriteTarByte(tar, 512, 297, "W")],
      ["device major", (tar) => rewriteTarOctal(tar, 512, 329, 8, 1)],
      ["device minor", (tar) => rewriteTarOctal(tar, 512, 337, 8, 1)],
      ["link residue", (tar) => rewriteTarByte(tar, 512, 157, "x")],
      ["reserved residue", (tar) => rewriteTarByte(tar, 512, 500, "x")],
      ["magic", (tar) => rewriteTarByte(tar, 512, 257, "U")],
      ["version", (tar) => rewriteTarByte(tar, 512, 263, "1")],
      ["checksum representation", (tar) => { tar[512 + 148] = 0x20; }],
    ];
    try {
      for (const [name, mutate] of mutations) {
        const hostile = Buffer.from(fixture.tar);
        mutate(hostile);
        const archive = join(fixture.temporary, `${name.replaceAll(" ", "-")}.tar.gz`);
        await writeFile(archive, gzipSync(hostile));
        await expect(materializeHomeArtifactArchive({ archive, temporaryParent })).rejects.toThrow();
        expect(await readdir(temporaryParent), name).toEqual([]);
      }
    } finally {
      await fixture.cleanup();
      await rm(temporaryParent, { recursive: true, force: true });
    }
  });

  test("validates a many-symlink archive with bounded ancestor checks", () => {
    const chunks = [
      createNormalizedHomeArtifactTarHeader(
        "artifact/",
        { mode: 0o755, size: 0, type: "5", link: "" },
      ),
      createNormalizedHomeArtifactTarHeader(
        "artifact/target",
        { mode: 0o644, size: 0, type: "0", link: "" },
      ),
    ];
    const symlinkCount = 8_000;
    for (let index = 0; index < symlinkCount; index += 1) {
      chunks.push(createNormalizedHomeArtifactTarHeader(
        `artifact/link-${index.toString().padStart(4, "0")}`,
        { mode: 0o755, size: 0, type: "2", link: "target" },
      ));
    }
    chunks.push(Buffer.alloc(1024));
    expect(inspectHomeArtifactTar(Buffer.concat(chunks)).entries).toHaveLength(symlinkCount + 2);
  });

  test("removes the private workspace after shipped verification failure", async () => {
    const fixture = await archiveFixture();
    const temporaryParent = await mkdtemp(join(tmpdir(), "dome-home-archive-failure-"));
    try {
      await expect(materializeHomeArtifactArchive({
        archive: fixture.archive,
        temporaryParent,
      })).rejects.toThrow();
      expect(await readdir(temporaryParent)).toEqual([]);

    } finally {
      await fixture.cleanup();
      await rm(temporaryParent, { recursive: true, force: true });
    }
  });
});

async function archiveFixture(): Promise<Readonly<{
  temporary: string;
  archive: string;
  tar: Buffer;
  compressed: Buffer;
  manifestBytes: Buffer;
  cleanup(): Promise<void>;
}>> {
  const temporary = await mkdtemp(join(tmpdir(), "dome-home-archive-fixture-"));
  const source = join(temporary, "source");
  await mkdir(source);
  const manifest = {
    product: { name: "Dome Home", version: "9.8.7" },
    artifact: { id: "artifact-test" },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  await writeFile(join(source, "manifest.json"), manifestBytes);
  await writeFile(join(source, "payload.txt"), "payload\n");
  const tar = await createDeterministicTar(source, "artifact");
  const compressed = gzipSync(tar);
  const archive = join(temporary, "artifact.tar.gz");
  await writeFile(archive, compressed);
  return Object.freeze({
    temporary,
    archive,
    tar,
    compressed,
    manifestBytes,
    cleanup: async () => { await rm(temporary, { recursive: true, force: true }); },
  });
}

function rewriteTarName(tar: Buffer, headerOffset: number, name: string): void {
  tar.fill(0, headerOffset, headerOffset + 100);
  Buffer.from(name).copy(tar, headerOffset);
  rewriteTarChecksum(tar, headerOffset);
}

function rewriteTarChecksum(tar: Buffer, headerOffset: number): void {
  const header = tar.subarray(headerOffset, headerOffset + 512);
  header.fill(0x20, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const encoded = `${checksum.toString(8).padStart(6, "0")}\0 `;
  Buffer.from(encoded).copy(header, 148);
}

function rewriteTarOctal(
  tar: Buffer,
  headerOffset: number,
  fieldOffset: number,
  length: number,
  value: number,
): void {
  const encoded = `${value.toString(8).padStart(length - 1, "0")}\0`;
  tar.fill(0, headerOffset + fieldOffset, headerOffset + fieldOffset + length);
  Buffer.from(encoded).copy(tar, headerOffset + fieldOffset);
  rewriteTarChecksum(tar, headerOffset);
}

function rewriteTarByte(tar: Buffer, headerOffset: number, fieldOffset: number, value: string): void {
  tar[headerOffset + fieldOffset] = value.charCodeAt(0);
  rewriteTarChecksum(tar, headerOffset);
}

function normalizedTar(entries: ReadonlyArray<Readonly<{
  path: string;
  mode: number;
  type: "0" | "5";
  body: Buffer;
}>>): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    chunks.push(createNormalizedHomeArtifactTarHeader(entry.path, {
      mode: entry.mode,
      size: entry.body.byteLength,
      type: entry.type,
      link: "",
    }));
    chunks.push(entry.body);
    const remainder = entry.body.byteLength % 512;
    if (remainder !== 0) chunks.push(Buffer.alloc(512 - remainder));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
