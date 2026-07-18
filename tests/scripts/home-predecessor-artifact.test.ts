import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertHomePredecessorObservation,
  assertKnownHistoricalFailure,
  materializePinnedHomePredecessorArchive,
  normalizePinnedHomePredecessorTarForTests,
  parseHomePredecessorReceipt,
  parseHomePredecessorCliArgs,
  readHomePredecessorReceipt,
  reconstructHomePredecessorArtifact,
  type HomePredecessorObservation,
  type HomePredecessorReceipt,
} from "../../scripts/home-predecessor-artifact";
import {
  createNormalizedHomeArtifactTarHeader,
  inspectHomeArtifactTar,
} from "../../src/product-host/home-artifact-archive";
import { readBoundedStableRegularFile } from "../../src/platform/bounded-regular-file";

const RECEIPT_PATH = join(
  import.meta.dir,
  "..", "fixtures", "home-upgrade", "n-1", "0.1.0-eb644dc2", "artifact-receipt.json",
);

describe("Home predecessor artifact provenance", () => {
  test("keeps one closed CLI shape", () => {
    expect(parseHomePredecessorCliArgs(["--output", "/tmp/predecessor"])).toEqual({
      help: false,
      outputDir: "/tmp/predecessor",
    });
    expect(parseHomePredecessorCliArgs(["--help"])).toEqual({ help: true, outputDir: null });
    for (const argv of [[], ["--json"], ["--output"], ["--output", "a", "--output", "b"], ["--future", "x"]]) {
      expect(() => parseHomePredecessorCliArgs(argv)).toThrow("usage:");
    }
  });

  test("parses one closed receipt that explicitly is not distribution history", async () => {
    const receipt = await readHomePredecessorReceipt(RECEIPT_PATH);
    expect(receipt).toMatchObject({
      classification: "reconstructed-internal-floor",
      distributed: false,
      builder: { bun: "1.2.13", sourceCommit: "eb644dc29b37cbc0c964f8cffc5329a95cad49ba" },
      archive: {
        bytes: 37_808_584,
        sha256: "35de119b40172ea5e418c0fa784a4db549c6ddf2911de9106beabf88fd492ebd",
      },
    });
    const raw = JSON.parse(await readFile(RECEIPT_PATH, "utf8"));
    expect(() => parseHomePredecessorReceipt({ ...raw, publishedRelease: true })).toThrow("unknown or missing");
    expect(() => parseHomePredecessorReceipt({ ...raw, distributed: true })).toThrow("identity changed");
  });

  test("accepts only the exact structured historical post-archive failure", async () => {
    const receipt = await readHomePredecessorReceipt(RECEIPT_PATH);
    const root = "/tmp/dome-home-rehearsal-Ab12Cd";
    const canonical = "/private/tmp/dome-home-rehearsal-Ab12Cd";
    const label = "com.dome.home.dome-home-rehearsal-ab12cd-1234abcd";
    const payload = {
      schema: "dome.home.lifecycle/v1",
      action: "status",
      vault: canonical,
      label,
      plist: `/Users/test/Library/LaunchAgents/${label}.plist`,
      log: `${canonical}/.dome/state/home.log`,
      program: "",
      installation: `/Users/test/Library/Application Support/Dome/Home/installations/${label.slice("com.dome.home.".length)}/installation.json`,
      release: null,
      artifactId: null,
      productVersion: null,
      status: "error",
      installed: null,
      loaded: null,
      ready: null,
      exitCode: 64,
      error: "not an initialized Dome vault; run `dome init` first",
      lifecycle: { state: "unavailable", error: "not an initialized Dome vault; run `dome init` first" },
    };
    const stderr = `dome home artifact: "${root}/Installed Dome Home/${receipt.archive.root}/bin/dome" "home" "status" "--vault" "${root}/vault" "--json" failed (64)\n${JSON.stringify(payload, null, 2)}\n`;
    expect(() => assertKnownHistoricalFailure(stderr, receipt)).not.toThrow();
    expect(() => assertKnownHistoricalFailure(stderr.replace("failed (64)", "failed (1)"), receipt)).toThrow("signature changed");
    expect(() => assertKnownHistoricalFailure(stderr.replace('"status": "error"', '"status": "ready"'), receipt)).toThrow("signature changed");
    expect(() => assertKnownHistoricalFailure(`${stderr}extra\n`, receipt)).toThrow();
  });

  test("validates every archive and raw-manifest identity pin", async () => {
    const receipt = await readHomePredecessorReceipt(RECEIPT_PATH);
    const observation = observed(receipt);
    expect(() => assertHomePredecessorObservation(observation, receipt)).not.toThrow();
    expect(() => assertHomePredecessorObservation({ ...observation, manifestBytes: observation.manifestBytes + 1 }, receipt))
      .toThrow("differs from its immutable receipt");
    expect(() => assertHomePredecessorObservation({
      ...observation,
      manifest: { ...observation.manifest, buildCommit: "f".repeat(40) },
    }, receipt)).toThrow("differs from its immutable receipt");
  });

  test("routes reconstructed archive admission through the shipped Product Host boundary", async () => {
    const source = await readFile(
      join(import.meta.dir, "..", "..", "scripts", "home-predecessor-artifact.ts"),
      "utf8",
    );
    expect(source).toContain("materializeHomeArtifactArchive({");
    expect(source).not.toContain('requireSuccess(["tar", "-x');
    expect(source).not.toContain('requireSuccess(["tar", "-t');
  });

  test("normalizes only the frozen predecessor's exact legacy symlink-mode inventory", () => {
    const root = "dome-home-0.1.0-darwin-arm64";
    const suffixes = [
      "app/node_modules/.bin/crc32",
      "app/node_modules/.bin/esparse",
      "app/node_modules/.bin/esvalidate",
      "app/node_modules/.bin/isogit",
      "app/node_modules/.bin/js-yaml",
      "app/node_modules/.bin/node-which",
      "app/node_modules/.bin/sha.js",
      "app/node_modules/.bin/yaml",
    ];
    const headers = [
      createNormalizedHomeArtifactTarHeader(`${root}/`, { mode: 0o755, size: 0, type: "5", link: "" }),
      ...suffixes.map((suffix) => legacySymlinkHeader(`${root}/${suffix}`)),
    ];
    const legacy = Buffer.concat([...headers, Buffer.alloc(1024)]);

    expect(() => inspectHomeArtifactTar(legacy)).toThrow(
      `Home artifact tar mode is not normalized: ${root}/${suffixes[0]}`,
    );
    const canonical = normalizePinnedHomePredecessorTarForTests(legacy, root);
    expect(inspectHomeArtifactTar(canonical).entries).toHaveLength(headers.length);
    for (let offset = 512; offset < headers.length * 512; offset += 512) {
      expect(readTarMode(canonical, offset)).toBe(0o755);
    }

    const unrelated = Buffer.concat([
      createNormalizedHomeArtifactTarHeader("unrelated/", { mode: 0o755, size: 0, type: "5", link: "" }),
      legacySymlinkHeader("unrelated/link"),
      Buffer.alloc(1024),
    ]);
    expect(() => inspectHomeArtifactTar(unrelated)).toThrow("mode is not normalized: unrelated/link");
    expect(() => normalizePinnedHomePredecessorTarForTests(unrelated, "unrelated"))
      .toThrow("unexpected legacy tar mode: unrelated/link");
  });

  test("rejects symlink, oversize, and pathname-replaced predecessor inputs without workspace residue", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-predecessor-input-defense-"));
    const workspaceParent = join(root, "workspaces");
    const receipt = await readHomePredecessorReceipt(RECEIPT_PATH);
    await mkdir(workspaceParent);
    try {
      const target = join(root, "target.tar.gz");
      const alias = join(root, "alias.tar.gz");
      await writeFile(target, "not an archive");
      await symlink(target, alias);
      await expect(materializePinnedHomePredecessorArchive({
        archive: alias,
        receipt,
        temporaryParent: workspaceParent,
      })).rejects.toThrow("not the immutable receipt file");
      expect(await readdir(workspaceParent)).toEqual([]);

      const oversized = join(root, "oversized.tar.gz");
      const oversizedHandle = await open(oversized, "wx", 0o600);
      try { await oversizedHandle.truncate(receipt.archive.bytes + 1); }
      finally { await oversizedHandle.close(); }
      await expect(materializePinnedHomePredecessorArchive({
        archive: oversized,
        receipt,
        temporaryParent: workspaceParent,
      })).rejects.toThrow("not the immutable receipt file");
      expect(await readdir(workspaceParent)).toEqual([]);

      const raced = join(root, "raced.tar.gz");
      const replacement = join(root, "replacement.tar.gz");
      for (const path of [raced, replacement]) {
        const handle = await open(path, "wx", 0o600);
        try { await handle.truncate(receipt.archive.bytes); }
        finally { await handle.close(); }
      }
      await expect(materializePinnedHomePredecessorArchive({
        archive: raced,
        receipt,
        temporaryParent: workspaceParent,
      }, {
        readArchive: async (input) => await readBoundedStableRegularFile(input, {
          afterLexicalStat: async () => {
            await rename(raced, join(root, "retained-original.tar.gz"));
            await rename(replacement, raced);
          },
        }),
      })).rejects.toThrow("not the immutable receipt file");
      expect(await readdir(workspaceParent)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("snapshots nested receipt pins before awaits and confines failed cleanup to its owned inode", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-predecessor-snapshot-defense-"));
    const workspaceParent = join(root, "workspaces");
    await mkdir(workspaceParent);
    try {
      const archive = join(root, "candidate.tar.gz");
      await writeFile(archive, "bad");
      const mutable = JSON.parse(await readFile(RECEIPT_PATH, "utf8")) as HomePredecessorReceipt;
      await expect(materializePinnedHomePredecessorArchive({
        archive,
        receipt: mutable,
        temporaryParent: workspaceParent,
      }, {
        readArchive: async () => {
          await Promise.resolve();
          const nested = mutable as unknown as {
            archive: { bytes: number; sha256: string; root: string };
            manifest: { bytes: number; sha256: string; artifactId: string; productVersion: string };
          };
          nested.archive.bytes = 3;
          nested.archive.sha256 = digest(Buffer.from("bad"));
          nested.archive.root = "attacker-root";
          nested.manifest.bytes = 1;
          nested.manifest.sha256 = "0".repeat(64);
          nested.manifest.artifactId = "0".repeat(64);
          nested.manifest.productVersion = "attacker";
          return Buffer.from("bad");
        },
      })).rejects.toThrow("differs from its immutable receipt");
      expect(await readdir(workspaceParent)).toEqual([]);

      const exactReceipt = await readHomePredecessorReceipt(RECEIPT_PATH);
      let replacementRoot = "";
      await expect(materializePinnedHomePredecessorArchive({
        archive,
        receipt: exactReceipt,
        temporaryParent: workspaceParent,
      }, {
        readArchive: async () => {
          const entries = await readdir(workspaceParent);
          expect(entries).toHaveLength(1);
          replacementRoot = join(workspaceParent, entries[0]!);
          await rename(replacementRoot, join(root, "retained-owned-workspace"));
          await mkdir(replacementRoot);
          await writeFile(join(replacementRoot, "replacement-canary"), "retain me");
          return Buffer.from("bad");
        },
      })).rejects.toThrow("predecessor admission and cleanup both failed");
      expect(await readFile(join(replacementRoot, "replacement-canary"), "utf8")).toBe("retain me");
      expect(await readdir(join(root, "retained-owned-workspace"))).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("rejects a symlink workspace parent before archive admission", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-predecessor-parent-defense-"));
    try {
      const parent = join(root, "parent");
      const alias = join(root, "parent-alias");
      const archive = join(root, "candidate.tar.gz");
      await mkdir(parent);
      await symlink(parent, alias);
      await writeFile(archive, "bad");
      await expect(materializePinnedHomePredecessorArchive({
        archive,
        receipt: await readHomePredecessorReceipt(RECEIPT_PATH),
        temporaryParent: alias,
      })).rejects.toThrow("workspace parent is not a direct directory");
      expect(await readdir(parent)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("orchestrates exactly two independent builds, compare, then publish", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-predecessor-test-"));
    try {
      const receipt = await readHomePredecessorReceipt(RECEIPT_PATH);
      const calls: string[] = [];
      const result = await reconstructHomePredecessorArtifact({
        repoRoot: root,
        outputDir: join(root, "out"),
        receiptPath: RECEIPT_PATH,
      }, {
        platform: "darwin",
        arch: "arm64",
        bunVersion: "1.2.13",
        build: async ({ index, workspace }) => {
          calls.push(`build-${index}:${workspace}`);
          return observed(receipt, join(workspace, `build-${index}`, receipt.archive.name));
        },
        compare: async (left, right) => { calls.push(`compare:${left}:${right}`); return true; },
        publish: async (source, destination) => { calls.push(`publish:${source}:${destination}`); },
      });
      expect(calls.filter((call) => call.startsWith("build-"))).toHaveLength(2);
      expect(new Set(calls.slice(0, 2).map((call) => call.split(":")[0]))).toEqual(new Set(["build-1", "build-2"]));
      expect(calls[2]).toStartWith("compare:");
      expect(calls[3]).toStartWith("publish:");
      expect(result.archive).toBe(join(root, "out", receipt.archive.name));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("platform gate precedes clone orchestration", async () => {
    let builds = 0;
    await expect(reconstructHomePredecessorArtifact({
      repoRoot: "/repo",
      outputDir: "/output",
      receiptPath: RECEIPT_PATH,
    }, {
      platform: "linux",
      arch: "x64",
      bunVersion: "1.2.13",
      build: async () => { builds += 1; throw new Error("must not build"); },
    })).rejects.toThrow("requires darwin-arm64");
    expect(builds).toBe(0);
  });
});

function observed(
  receipt: Awaited<ReturnType<typeof readHomePredecessorReceipt>>,
  archivePath = `/tmp/${receipt.archive.name}`,
): HomePredecessorObservation {
  return {
    archivePath,
    archiveBytes: receipt.archive.bytes,
    archiveSha256: receipt.archive.sha256,
    archiveRoot: receipt.archive.root,
    manifestBytes: receipt.manifest.bytes,
    manifestSha256: receipt.manifest.sha256,
    manifest: {
      schema: receipt.manifest.schema,
      productVersion: receipt.manifest.productVersion,
      targetOs: receipt.manifest.target.os,
      targetArch: receipt.manifest.target.arch,
      buildCommit: receipt.manifest.buildCommit,
      artifactId: receipt.manifest.artifactId,
    },
  };
}

function legacySymlinkHeader(path: string): Buffer {
  const header = createNormalizedHomeArtifactTarHeader(path, {
    mode: 0o755,
    size: 0,
    type: "2",
    link: "../target",
  });
  header.write("0000777\0", 100, 8, "ascii");
  header.fill(0x20, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

function readTarMode(tar: Buffer, headerOffset: number): number {
  return Number.parseInt(tar.subarray(headerOffset + 100, headerOffset + 108).toString("ascii").replace(/\0.*$/, ""), 8);
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
