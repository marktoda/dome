import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertHomePredecessorObservation,
  assertKnownHistoricalFailure,
  parseHomePredecessorReceipt,
  parseHomePredecessorCliArgs,
  readHomePredecessorReceipt,
  reconstructHomePredecessorArtifact,
  type HomePredecessorObservation,
} from "../../scripts/home-predecessor-artifact";

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
