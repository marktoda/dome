import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildHomeMacosDistributionForTests,
  createNotarizedHomeDmg,
  parseHomeMacosActivationBinding,
  parseHomeMacosDistributionReceipt,
  readHomeMacosDistributionConfig,
  HomeMacosDistributionPublicationError,
  signHomeArtifactNativeCode,
  verifyHomeMacosDistributionForTests,
  type HomeMacosActivationBinding,
  type BuildHomeMacosDistributionTestDeps,
  type DistributionCommandResult,
} from "../../scripts/home-macos-distribution";
import {
  PINNED_AGE_BINARY_SHA256,
  PINNED_AGE_KEYGEN_BINARY_SHA256,
  PINNED_BUN_BINARY_SHA256,
  PINNED_BUN_DEVELOPER_ID_TEAM_ID,
  canonicalHomeEntitlementsSha256,
  verifySignedHomeArtifactNativeCodeForTests,
  type HomeArtifactCodeSigning,
  type HomeArtifactManifest,
} from "../../src/product-host/home-artifact";

const DOME_TEAM = "A1B2C3D4E5";
const IDENTITY = `Developer ID Application: Dome Test (${DOME_TEAM})`;
const OK = Object.freeze({ exitCode: 0, stdout: "", stderr: "" });

describe("Home macOS native signing", () => {
  test("preserves upstream Bun and signs only the exact age executables before returning evidence", async () => {
    const commands: string[][] = [];
    const signed = new Set<string>();
    const sourceHashes = new Map([
      ["/sources/bun", PINNED_BUN_BINARY_SHA256],
      ["/sources/age", PINNED_AGE_BINARY_SHA256],
      ["/sources/age-keygen", PINNED_AGE_KEYGEN_BINARY_SHA256],
    ]);
    const targetSource = new Map([
      ["/artifact/runtime/bun", PINNED_BUN_BINARY_SHA256],
      ["/artifact/runtime/age", PINNED_AGE_BINARY_SHA256],
      ["/artifact/runtime/age-keygen", PINNED_AGE_KEYGEN_BINARY_SHA256],
    ]);
    const shipped = new Map([
      ["/artifact/runtime/age", "a".repeat(64)],
      ["/artifact/runtime/age-keygen", "b".repeat(64)],
    ]);
    const run = async (argv: ReadonlyArray<string>): Promise<DistributionCommandResult> => {
      commands.push([...argv]);
      const path = argv.at(-1) ?? "";
      if (argv.includes("--sign")) {
        signed.add(path);
        return OK;
      }
      if (argv.includes("--entitlements")) {
        return { ...OK, stdout: path.endsWith("/bun") ? "<plist>bun-jit</plist>" : "<plist/>" };
      }
      if (argv.includes("--display")) {
        const team = path.endsWith("/bun") ? PINNED_BUN_DEVELOPER_ID_TEAM_ID : DOME_TEAM;
        return {
          ...OK,
          stderr:
            "CodeDirectory v=20500 size=100 flags=0x10000(runtime) hashes=1+0 location=embedded\n" +
            `CDHash=${path.endsWith("/bun") ? "1" : path.endsWith("age-keygen") ? "2" : "3"}`.padEnd(47, path.endsWith("/bun") ? "1" : path.endsWith("age-keygen") ? "2" : "3") + "\n" +
            `TeamIdentifier=${team}\nTimestamp=Jul 14, 2026 at 12:00:00 PM\n`,
        };
      }
      return OK;
    };

    const result = await signHomeArtifactNativeCode({
      artifactRoot: "/artifact",
      sources: { bun: "/sources/bun", age: "/sources/age", ageKeygen: "/sources/age-keygen" },
      domeTeamId: DOME_TEAM,
      signingIdentity: IDENTITY,
    }, {
      run,
      inventoryMachO: async () => ["runtime/age", "runtime/age-keygen", "runtime/bun"],
      digest: async (path) => {
        const source = sourceHashes.get(path) ?? targetSource.get(path);
        const hash = signed.has(path) ? shipped.get(path) : source;
        if (hash === undefined) throw new Error(`unexpected digest ${path}`);
        return { bytes: 10, sha256: hash };
      },
    });

    expect(result.executables.map((row) => row.path)).toEqual([
      "runtime/age", "runtime/age-keygen", "runtime/bun",
    ]);
    expect(result.executables[0]).toMatchObject({
      sourceSha256: PINNED_AGE_BINARY_SHA256,
      shippedSha256: "a".repeat(64),
      teamId: DOME_TEAM,
      hardenedRuntime: true,
      secureTimestamp: true,
    });
    expect(result.executables[2]).toMatchObject({
      sourceSha256: PINNED_BUN_BINARY_SHA256,
      shippedSha256: PINNED_BUN_BINARY_SHA256,
      teamId: PINNED_BUN_DEVELOPER_ID_TEAM_ID,
    });
    const signingCommands = commands.filter((argv) => argv.includes("--sign"));
    expect(signingCommands.map((argv) => argv.at(-1))).toEqual([
      "/artifact/runtime/age",
      "/artifact/runtime/age-keygen",
    ]);
    expect(signingCommands.some((argv) => argv.at(-1)?.endsWith("/bun"))).toBeFalse();
  });

  test("rejects an unreviewed Mach-O before invoking codesign", async () => {
    let invoked = false;
    await expect(signHomeArtifactNativeCode({
      artifactRoot: "/artifact",
      sources: { bun: "/sources/bun", age: "/sources/age", ageKeygen: "/sources/age-keygen" },
      domeTeamId: DOME_TEAM,
      signingIdentity: IDENTITY,
    }, {
      run: async () => { invoked = true; return OK; },
      inventoryMachO: async () => ["runtime/age", "runtime/age-keygen", "runtime/bun", "app/native-addon"],
    })).rejects.toThrow("Mach-O inventory is not exact");
    expect(invoked).toBeFalse();
  });

  test("re-inventories native code after signing before returning manifest evidence", async () => {
    let inventories = 0;
    const signed = new Set<string>();
    await expect(signHomeArtifactNativeCode({
      artifactRoot: "/artifact",
      sources: { bun: "/sources/bun", age: "/sources/age", ageKeygen: "/sources/age-keygen" },
      domeTeamId: DOME_TEAM,
      signingIdentity: IDENTITY,
    }, {
      run: async (argv) => {
        const path = argv.at(-1)!;
        if (argv.includes("--sign")) signed.add(path);
        if (argv.includes("--entitlements")) return { ...OK, stdout: "<plist><dict/></plist>" };
        if (argv.includes("--display")) {
          const team = path.endsWith("/bun") ? PINNED_BUN_DEVELOPER_ID_TEAM_ID : DOME_TEAM;
          return {
            ...OK,
            stderr: `CodeDirectory flags=0x10000(runtime)\nCDHash=${"1".repeat(40)}\n` +
              `TeamIdentifier=${team}\nTimestamp=Jul 14, 2026\n`,
          };
        }
        return OK;
      },
      inventoryMachO: async () => ++inventories === 1
        ? ["runtime/age", "runtime/age-keygen", "runtime/bun"]
        : ["app/late-addon", "runtime/age", "runtime/age-keygen", "runtime/bun"],
      digest: async (path) => {
        const source = path.endsWith("age-keygen") ? PINNED_AGE_KEYGEN_BINARY_SHA256
          : path.endsWith("age") ? PINNED_AGE_BINARY_SHA256
          : PINNED_BUN_BINARY_SHA256;
        return {
          bytes: 10,
          sha256: signed.has(path)
            ? (path.endsWith("age-keygen") ? "b" : "a").repeat(64)
            : source,
        };
      },
    })).rejects.toThrow("signed Home artifact Mach-O inventory is not exact");
    expect(inventories).toBe(2);
  });
});

describe("installed signed-artifact native verification", () => {
  test("matches actual codesign evidence and rejects symlink aliases to native payloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-home-native-verify-"));
    const entitlements = "<?xml version=\"1.0\"?>\n<plist>\n<dict/>\n</plist>\n";
    try {
      await mkdir(join(root, "runtime"));
      for (const name of ["age", "age-keygen", "bun"]) {
        await writeFile(join(root, "runtime", name), Buffer.concat([
          Buffer.from("feedfacf", "hex"),
          Buffer.from(name),
        ]));
      }
      const codeSigning: HomeArtifactCodeSigning = Object.freeze({
        executables: Object.freeze(signedManifest().codeSigning!.executables.map((row) => Object.freeze({
          ...row,
          entitlementsSha256: canonicalHomeEntitlementsSha256(entitlements),
        }))),
      });
      const commands: string[][] = [];
      const run = async (argv: ReadonlyArray<string>): Promise<DistributionCommandResult> => {
        commands.push([...argv]);
        const path = argv.at(-1)!;
        const relative = `runtime/${path.split("/").at(-1)!}`;
        const row = codeSigning.executables.find((candidate) => candidate.path === relative)!;
        if (argv.includes("--entitlements")) return { ...OK, stdout: entitlements };
        if (argv.includes("--display")) return {
          ...OK,
          stderr: "CodeDirectory v=20500 flags=0x10000(runtime)\n" +
            `CDHash=${row.cdHash}\nTeamIdentifier=${row.teamId}\nTimestamp=Jul 14, 2026\n`,
        };
        return OK;
      };
      await verifySignedHomeArtifactNativeCodeForTests(root, codeSigning, run);
      expect(commands).toHaveLength(9);

      await symlink("age", join(root, "runtime", "age-alias"));
      await expect(verifySignedHomeArtifactNativeCodeForTests(root, codeSigning, run))
        .rejects.toThrow("symlink alias to native code");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Home notarized DMG", () => {
  test("binds the accepted, stapled, Gatekeeper-assessed DMG without retaining credential profile", async () => {
    const commands: string[][] = [];
    let stapled = false;
    const manifest = signedManifest();
    const result = await createNotarizedHomeDmg({
      payloadRoot: "/private/payload",
      artifactRoot: "/private/dome-home-0.2.0-darwin-arm64",
      manifest,
      activationEvidencePath: "/private/activation.json",
      activationBinding: activationBinding(),
      archiveSha256: "6".repeat(64),
      dmgPath: "/private/dome-home-0.2.0-darwin-arm64.dmg",
      volumeName: "Dome Home 0.2.0",
      signingIdentity: IDENTITY,
      teamId: DOME_TEAM,
      notaryKeychainProfile: "dome-notary-private-profile",
    }, {
      run: async (argv) => {
        commands.push([...argv]);
        if (argv.includes("submit")) {
          return { ...OK, stdout: JSON.stringify({
            id: "11111111-2222-4333-8444-555555555555",
            status: "Accepted",
          }) };
        }
        if (argv.includes("log")) {
          return { ...OK, stdout: JSON.stringify({
            logFormatVersion: 1,
            jobId: "11111111-2222-4333-8444-555555555555",
            status: "Accepted",
            statusCode: 0,
            archiveFilename: "dome-home-0.2.0-darwin-arm64.dmg",
            sha256: "c".repeat(64),
            issues: null,
            statusSummary: "Ready for distribution",
            uploadDate: "2026-07-14T12:00:00.000Z",
            ticketContents: [
              {
                path: "dome-home-0.2.0-darwin-arm64.dmg",
                digestAlgorithm: "SHA-256",
                cdhash: "9".repeat(40),
              },
              {
                path: "artifact/runtime/age",
                digestAlgorithm: "SHA-256",
                cdhash: "a".repeat(40),
                arch: "arm64",
              },
            ],
          }) };
        }
        if (argv.includes("--display")) return {
          ...OK,
          stderr: `CDHash=${"5".repeat(40)}\nTeamIdentifier=${DOME_TEAM}\nTimestamp=Jul 14, 2026\n`,
        };
        if (argv[0] === "/usr/sbin/spctl" && argv.includes("--status")) {
          return { ...OK, stdout: "assessments enabled\n" };
        }
        if (argv.includes("staple")) stapled = true;
        return OK;
      },
      digest: async (path) => {
        if (path.endsWith(".dmg")) {
          return { bytes: stapled ? 101 : 100, sha256: (stapled ? "d" : "c").repeat(64) };
        }
        if (path.endsWith("manifest.json")) return { bytes: 20, sha256: "e".repeat(64) };
        if (path.endsWith("activation.json")) return { bytes: 30, sha256: "f".repeat(64) };
        throw new Error(`unexpected digest ${path}`);
      },
    });

    expect(commands.map((argv) => argv.slice(0, 3).join(" "))).toEqual([
      "/usr/bin/hdiutil create -format",
      "/usr/bin/codesign --force --timestamp",
      "/usr/bin/codesign --verify --strict",
      "/usr/bin/codesign --display --verbose=4",
      "/usr/bin/xcrun notarytool submit",
      "/usr/bin/xcrun notarytool log",
      "/usr/bin/xcrun stapler staple",
      "/usr/bin/xcrun stapler validate",
      "/usr/bin/codesign --verify --strict",
      "/usr/bin/codesign --display --verbose=4",
      "/usr/bin/hdiutil verify /private/dome-home-0.2.0-darwin-arm64.dmg",
      "/usr/sbin/spctl --status",
      "/usr/sbin/spctl --assess --ignore-cache",
    ]);
    expect(result).toMatchObject({
      schema: "dome.home-macos-distribution/v1",
      product: { version: "0.2.0", target: "darwin-arm64" },
      artifact: {
        id: "9".repeat(64),
        manifestSha256: "e".repeat(64),
        activationEvidenceSha256: "f".repeat(64),
        archiveSha256: "6".repeat(64),
      },
      container: {
        format: "dmg",
        name: "dome-home-0.2.0-darwin-arm64.dmg",
        submitted: { sha256: "c".repeat(64) },
        distributed: { sha256: "d".repeat(64) },
        signature: { teamId: DOME_TEAM, cdHash: "5".repeat(40), secureTimestamp: true },
      },
      notarization: {
        submissionId: "11111111-2222-4333-8444-555555555555",
        status: "Accepted",
        issues: 0,
        stapled: true,
        assessed: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain("dome-notary-private-profile");
    expect(result.artifact.codeSigningSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test("fails closed before stapling when Apple rejects the submission", async () => {
    const commands: string[][] = [];
    await expect(createNotarizedHomeDmg({
      payloadRoot: "/private/payload",
      artifactRoot: "/private/artifact",
      manifest: signedManifest(),
      activationEvidencePath: "/private/activation.json",
      activationBinding: activationBinding(),
      archiveSha256: "6".repeat(64),
      dmgPath: "/private/dome.dmg",
      volumeName: "Dome Home",
      signingIdentity: IDENTITY,
      teamId: DOME_TEAM,
      notaryKeychainProfile: "profile",
    }, {
      run: async (argv) => {
        commands.push([...argv]);
        if (argv.includes("--display")) return {
          ...OK,
          stderr: `CDHash=${"5".repeat(40)}\nTeamIdentifier=${DOME_TEAM}\nTimestamp=Jul 14, 2026\n`,
        };
        return argv.includes("submit")
          ? { ...OK, stdout: JSON.stringify({ id: "11111111-2222-4333-8444-555555555555", status: "Invalid" }) }
          : OK;
      },
      digest: async () => ({ bytes: 1, sha256: "a".repeat(64) }),
    })).rejects.toThrow("did not return an accepted submission");
    expect(commands.some((argv) => argv.includes("staple"))).toBeFalse();
    expect(commands.some((argv) => argv[0] === "/usr/sbin/spctl")).toBeFalse();
  });

  test("caps and redacts notary diagnostics", async () => {
    const profile = "private-profile-name";
    const error = await createNotarizedHomeDmg({
      payloadRoot: "/private/payload",
      artifactRoot: "/private/artifact",
      manifest: signedManifest(),
      activationEvidencePath: "/private/activation.json",
      activationBinding: activationBinding(),
      archiveSha256: "6".repeat(64),
      dmgPath: "/private/dome.dmg",
      volumeName: "Dome Home",
      signingIdentity: IDENTITY,
      teamId: DOME_TEAM,
      notaryKeychainProfile: profile,
    }, {
      run: async (argv) => {
        if (argv.includes("--display")) return {
          ...OK,
          stderr: `CDHash=${"5".repeat(40)}\nTeamIdentifier=${DOME_TEAM}\nTimestamp=Jul 14, 2026\n`,
        };
        if (argv.includes("submit")) return { exitCode: 1, stdout: "", stderr: `${profile} `.repeat(2_000) };
        return OK;
      },
      digest: async () => ({ bytes: 1, sha256: "a".repeat(64) }),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(profile);
    expect((error as Error).message.length).toBeLessThan(2_100);
  });
});

describe("Home macOS distribution publication", () => {
  test("builds, signs, re-proves, and exclusively publishes only the final DMG and redacted receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-home-distribution-build-"));
    const output = join(root, "release");
    const events: string[] = [];
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.2.0" }));
      let builtManifest: HomeArtifactManifest | undefined;
      const result = await buildHomeMacosDistributionForTests({
        repoRoot: root,
        outputDir: output,
        config: {
          signingIdentity: IDENTITY,
          teamId: DOME_TEAM,
          notaryKeychainProfile: "private-notary-profile",
        },
      }, groupBuildDeps({
        platform: "darwin",
        arch: "arm64",
        signArtifact: async () => {
          events.push("sign");
          return signedManifest().codeSigning!;
        },
        buildArtifact: async (options) => {
          events.push("build");
          const artifactRoot = join(options.outputDir, "dome-home-0.2.0-darwin-arm64");
          await mkdir(artifactRoot, { recursive: true });
          const codeSigning = await options.beforeManifest({
            artifactRoot,
            sources: { bun: "/source/bun", age: "/source/age", ageKeygen: "/source/age-keygen" },
          });
          builtManifest = { ...signedManifest(), codeSigning };
          const manifestText = `${JSON.stringify(builtManifest, null, 2)}\n`;
          const archive = join(options.outputDir, "artifact.tar.gz");
          const evidence = join(options.outputDir, "activation.json");
          await writeFile(join(artifactRoot, "manifest.json"), manifestText);
          await writeFile(archive, "archive bytes\n");
          await writeFile(evidence, `${JSON.stringify(rawActivationEvidence({
            archiveSha256: digestText("archive bytes\n"),
            manifestSha256: digestText(manifestText),
          }), null, 2)}\n`);
          return {
            directory: artifactRoot,
            archive,
            archiveSha256: digestText("archive bytes\n"),
            evidence,
            evidenceSha256: digestText(await readFile(evidence, "utf8")),
            manifest: builtManifest,
          };
        },
        createDmg: async (input) => {
          events.push("dmg");
          expect((await readdir(input.payloadRoot)).sort()).toEqual(["artifact", "release"]);
          expect(parseHomeMacosActivationBinding(JSON.parse(
            await readFile(join(input.payloadRoot, "release", "activation-binding.json"), "utf8"),
          ))).toEqual(input.activationBinding);
          await writeFile(input.dmgPath, "distributed dmg\n");
          const manifestSha256 = digestText(await readFile(join(input.artifactRoot, "manifest.json"), "utf8"));
          const activationEvidenceSha256 = digestText(await readFile(input.activationEvidencePath, "utf8"));
          const activationBindingSha256 = digestText(`${JSON.stringify(input.activationBinding, null, 2)}\n`);
          const codeSigning = input.manifest.codeSigning!;
          return {
            schema: "dome.home-macos-distribution/v1",
            product: { version: "0.2.0", target: "darwin-arm64" },
            artifact: {
              id: input.manifest.artifact.id,
              buildCommit: input.manifest.build.gitCommit,
              archiveSha256: input.archiveSha256,
              manifestSha256,
              activationEvidenceSha256,
              activationBindingSha256,
              codeSigning,
              codeSigningSha256: digestText(JSON.stringify(codeSigning)),
            },
            container: {
              format: "dmg",
              name: "dome-home-0.2.0-darwin-arm64.dmg",
              submitted: { bytes: 14, sha256: "8".repeat(64) },
              distributed: { bytes: 16, sha256: digestText("distributed dmg\n") },
              signature: { teamId: DOME_TEAM, cdHash: "5".repeat(40), secureTimestamp: true },
            },
            notarization: {
              submissionId: "11111111-2222-4333-8444-555555555555",
              status: "Accepted",
              logSha256: "7".repeat(64),
              issues: 0,
              stapled: true,
              assessed: true,
            },
          };
        },
        verifyArtifact: async () => {
          events.push("verify");
          return builtManifest!;
        },
        reproveSource: async (_repo, commit, privateRoot) => {
          events.push("source");
          expect(commit).toBe("6".repeat(40));
          expect(privateRoot).toContain(".dome-home-distribution-");
        },
        verifyDistribution: async (directory) => {
          events.push("verify-distribution");
          const publicDirectory = join(directory, "public");
          const names = await readdir(publicDirectory);
          const receiptPath = join(publicDirectory, names.find((name) => name.endsWith(".distribution-receipt.json"))!);
          const activationPath = join(publicDirectory, names.find((name) => name.endsWith(".activation-binding.json"))!);
          const dmgPath = join(publicDirectory, names.find((name) => name.endsWith(".dmg"))!);
          return {
            receipt: parseHomeMacosDistributionReceipt(JSON.parse(await readFile(receiptPath, "utf8"))),
            activationBinding: parseHomeMacosActivationBinding(JSON.parse(await readFile(activationPath, "utf8"))),
            dmgPath,
            receiptPath,
            activationBindingPath: activationPath,
          };
        },
        syncFile: async () => {},
        syncDirectory: async () => {},
        publish: async (source, target) => {
          events.push("publish");
          expect((await readdir(join(source, "public"))).sort()).toEqual([
            "dome-home-0.2.0-darwin-arm64.activation-binding.json",
            "dome-home-0.2.0-darwin-arm64.distribution-receipt.json",
            "dome-home-0.2.0-darwin-arm64.dmg",
          ].sort());
          await rename(source, target);
        },
      }));

      expect(events).toEqual([
        "build", "sign", "dmg", "verify", "source", "verify-distribution",
        "publish", "verify-distribution",
      ]);
      expect(result.envelope).toBe(join(await realpath(root), "release"));
      expect((await readdir(output)).sort()).toEqual(["private", "public"]);
      expect((await readdir(join(output, "public"))).sort()).toEqual([
        "dome-home-0.2.0-darwin-arm64.activation-binding.json",
        "dome-home-0.2.0-darwin-arm64.distribution-receipt.json",
        "dome-home-0.2.0-darwin-arm64.dmg",
      ].sort());
      const receipt = await readFile(result.receipt, "utf8");
      expect(receipt).not.toContain(IDENTITY);
      expect(receipt).not.toContain("private-notary-profile");
      expect(await readFile(result.privateReleaseEvidence, "utf8")).toContain('"host"');
      expect((await lstat(result.privateReleaseEvidence)).mode & 0o777).toBe(0o600);
      expect(await readFile(result.activationBinding, "utf8")).not.toContain('"uid"');
      expect((await readdir(root)).some((name) => name.startsWith(".dome-home-distribution-"))).toBeFalse();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("removes private staging and publishes nothing when a late gate fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-home-distribution-failure-"));
    const output = join(root, "release");
    let published = false;
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.2.0" }));
      await expect(buildHomeMacosDistributionForTests({
        repoRoot: root,
        outputDir: output,
        config: { signingIdentity: IDENTITY, teamId: DOME_TEAM, notaryKeychainProfile: "profile" },
      }, groupBuildDeps({
        platform: "darwin",
        arch: "arm64",
        signArtifact: async () => signedManifest().codeSigning!,
        buildArtifact: async (options) => {
          const artifactRoot = join(options.outputDir, "dome-home-0.2.0-darwin-arm64");
          await mkdir(artifactRoot, { recursive: true });
          const codeSigning = await options.beforeManifest({
            artifactRoot,
            sources: { bun: "bun", age: "age", ageKeygen: "age-keygen" },
          });
          const manifest = { ...signedManifest(), codeSigning };
          await writeFile(join(artifactRoot, "manifest.json"), `${JSON.stringify(manifest)}\n`);
          const archive = join(options.outputDir, "artifact.tar.gz");
          const evidence = join(options.outputDir, "activation.json");
          await writeFile(archive, "archive");
          await writeFile(evidence, `${JSON.stringify(rawActivationEvidence({
            archiveSha256: digestText("archive"),
            manifestSha256: digestText(`${JSON.stringify(manifest)}\n`),
          }))}\n`);
          return {
            directory: artifactRoot,
            archive,
            archiveSha256: digestText("archive"),
            evidence,
            evidenceSha256: digestText(await readFile(evidence, "utf8")),
            manifest,
          };
        },
        createDmg: async (input) => {
          await writeFile(input.dmgPath, "partial dmg");
          throw new Error("notary rejected");
        },
        publish: async () => { published = true; },
      }))).rejects.toThrow("notary rejected");
      expect(published).toBeFalse();
      expect((await readdir(root)).sort()).toEqual(["package.json"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("strictly re-verifies the three-file published distribution and native envelope", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-home-distribution-strict-verify-"));
    const output = join(root, "release");
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.2.0" }));
      await buildHomeMacosDistributionForTests({
        repoRoot: root, outputDir: output,
        config: { signingIdentity: IDENTITY, teamId: DOME_TEAM, notaryKeychainProfile: "profile" },
      }, fakeDistributionBuildDeps());
      const commands: string[][] = [];
      const receiptName = (await readdir(join(await realpath(output), "public")))
        .find((name) => name.endsWith(".distribution-receipt.json"))!;
      const receipt = parseHomeMacosDistributionReceipt(JSON.parse(
        await readFile(join(await realpath(output), "public", receiptName), "utf8"),
      ));
      const activationName = (await readdir(join(await realpath(output), "public")))
        .find((name) => name.endsWith(".activation-binding.json"))!;
      const publishedActivation = parseHomeMacosActivationBinding(JSON.parse(
        await readFile(join(await realpath(output), "public", activationName), "utf8"),
      ));
      await verifyHomeMacosDistributionForTests(await realpath(output), { expectedTeamId: DOME_TEAM }, {
        run: async (argv) => {
          commands.push([...argv]);
          if (argv[0] === "/usr/bin/hdiutil" && argv[1] === "attach") {
            const mount = argv[argv.indexOf("-mountpoint") + 1]!;
            await mkdir(join(mount, "artifact"), { recursive: true });
            await mkdir(join(mount, "release"), { recursive: true });
            await writeFile(
              join(mount, "release", "activation-binding.json"),
              `${JSON.stringify(publishedActivation, null, 2)}\n`,
            );
          }
          if (argv.includes("--display")) return {
            ...OK,
            stderr: `CDHash=${"5".repeat(40)}\nTeamIdentifier=${DOME_TEAM}\nTimestamp=Jul 14, 2026\n`,
          };
          if (argv[0] === "/usr/sbin/spctl" && argv.includes("--status")) {
            return { ...OK, stdout: "assessments enabled\n" };
          }
          return OK;
        },
        verifyMountedArtifact: async (artifactRoot) => {
          expect(artifactRoot.endsWith("/artifact")).toBeTrue();
          return { manifest: signedManifest(), manifestSha256: receipt.artifact.manifestSha256 };
        },
      });
      expect(commands.map((argv) => argv[0])).toEqual([
        "/usr/bin/codesign", "/usr/bin/codesign", "/usr/bin/xcrun",
        "/usr/bin/hdiutil", "/usr/sbin/spctl", "/usr/sbin/spctl",
        "/usr/bin/hdiutil", "/usr/bin/hdiutil",
      ]);

      const failureCommands: string[][] = [];
      await expect(verifyHomeMacosDistributionForTests(output, { expectedTeamId: DOME_TEAM }, {
        run: async (argv) => {
          failureCommands.push([...argv]);
          if (argv[0] === "/usr/bin/hdiutil" && argv[1] === "attach") {
            const mount = argv[argv.indexOf("-mountpoint") + 1]!;
            await mkdir(join(mount, "artifact"), { recursive: true });
            await mkdir(join(mount, "release"), { recursive: true });
            await writeFile(
              join(mount, "release", "activation-binding.json"),
              `${JSON.stringify(publishedActivation, null, 2)}\n`,
            );
          }
          if (argv.includes("--display")) return {
            ...OK,
            stderr: `CDHash=${"5".repeat(40)}\nTeamIdentifier=${DOME_TEAM}\nTimestamp=Jul 14, 2026\n`,
          };
          if (argv[0] === "/usr/sbin/spctl" && argv.includes("--status")) {
            return { ...OK, stdout: "assessments enabled\n" };
          }
          return OK;
        },
        verifyMountedArtifact: async () => { throw new Error("embedded verifier failed"); },
      })).rejects.toThrow("embedded verifier failed");
      expect(failureCommands.at(-1)?.slice(0, 2)).toEqual(["/usr/bin/hdiutil", "detach"]);
      await writeFile(join(output, "unexpected.txt"), "drift");
      await expect(verifyHomeMacosDistributionForTests(
        output,
        { expectedTeamId: DOME_TEAM },
        { run: async () => OK },
      )).rejects.toThrow("envelope inventory is not exact");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("requires the exact three environment variables and validates identity/team binding", () => {
    expect(() => readHomeMacosDistributionConfig({})).toThrow("DOME_CODESIGN_IDENTITY is required");
    expect(() => readHomeMacosDistributionConfig({
      DOME_CODESIGN_IDENTITY: IDENTITY,
      DOME_APPLE_TEAM_ID: DOME_TEAM,
    })).toThrow("DOME_NOTARY_KEYCHAIN_PROFILE is required");
    expect(() => readHomeMacosDistributionConfig({
      DOME_CODESIGN_IDENTITY: `Developer ID Application: Wrong (Z9Y8X7W6V5)`,
      DOME_APPLE_TEAM_ID: DOME_TEAM,
      DOME_NOTARY_KEYCHAIN_PROFILE: "profile",
    })).toThrow("identity for DOME_APPLE_TEAM_ID");
    expect(readHomeMacosDistributionConfig({
      DOME_CODESIGN_IDENTITY: IDENTITY,
      DOME_APPLE_TEAM_ID: DOME_TEAM,
      DOME_NOTARY_KEYCHAIN_PROFILE: "profile",
    })).toEqual({ signingIdentity: IDENTITY, teamId: DOME_TEAM, notaryKeychainProfile: "profile" });
  });

  test("preserves a rename-complete winner and reports crash-uncertain publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-home-distribution-rename-throw-"));
    const output = join(root, "release");
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.2.0" }));
      const deps = fakeDistributionBuildDeps({
        publish: async (source, target) => {
          await rename(source, target);
          throw new Error("rename completion was ambiguous");
        },
      });
      const error = await buildHomeMacosDistributionForTests({
        repoRoot: root, outputDir: output,
        config: { signingIdentity: IDENTITY, teamId: DOME_TEAM, notaryKeychainProfile: "profile" },
      }, deps).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(HomeMacosDistributionPublicationError);
      expect(error).toMatchObject({ published: true, durability: "uncertain" });
      expect((await readdir(output)).sort()).toEqual(["private", "public"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("reports a definite collision when publication fails before moving the candidate", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-home-distribution-collision-"));
    const output = join(root, "release");
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.2.0" }));
      const error = await buildHomeMacosDistributionForTests({
        repoRoot: root, outputDir: output,
        config: { signingIdentity: IDENTITY, teamId: DOME_TEAM, notaryKeychainProfile: "profile" },
      }, fakeDistributionBuildDeps({
        publish: async (_source, target) => {
          await mkdir(target);
          throw new Error("exclusive publish collision");
        },
      })).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(HomeMacosDistributionPublicationError);
      expect((error as Error).message).toBe("exclusive publish collision");
      expect(await readdir(output)).toEqual([]);
      expect((await readdir(root)).some((name) => name.startsWith(".dome-home-distribution-"))).toBeFalse();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("preserves the winner when parent durability fails after the commit rename", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-home-distribution-sync-fail-"));
    const output = join(root, "release");
    let directorySyncs = 0;
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.2.0" }));
      const error = await buildHomeMacosDistributionForTests({
        repoRoot: root, outputDir: output,
        config: { signingIdentity: IDENTITY, teamId: DOME_TEAM, notaryKeychainProfile: "profile" },
      }, fakeDistributionBuildDeps({
        syncDirectory: async () => {
          directorySyncs += 1;
          if (directorySyncs === 4) throw new Error("parent fsync failed");
        },
      })).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(HomeMacosDistributionPublicationError);
      expect(error).toMatchObject({ published: true, durability: "uncertain" });
      expect((await readdir(output)).sort()).toEqual(["private", "public"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("refuses a retargeted lexical parent before either publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-home-distribution-parent-retarget-"));
    const parent = join(root, "parent");
    const moved = join(root, "moved-parent");
    const output = join(parent, "release");
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.2.0" }));
      await mkdir(parent);
      await expect(buildHomeMacosDistributionForTests({
        repoRoot: root, outputDir: output,
        config: { signingIdentity: IDENTITY, teamId: DOME_TEAM, notaryKeychainProfile: "profile" },
      }, fakeDistributionBuildDeps({
        reproveSource: async () => {
          await rename(parent, moved);
          await mkdir(parent);
        },
      }))).rejects.toThrow("output parent changed during publication");
      expect(await readdir(parent)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("published readback drift is reported without deleting the winner", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-home-distribution-drift-"));
    const output = join(root, "release");
    let verifications = 0;
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.2.0" }));
      const base = fakeDistributionBuildDeps();
      const error = await buildHomeMacosDistributionForTests({
        repoRoot: root, outputDir: output,
        config: { signingIdentity: IDENTITY, teamId: DOME_TEAM, notaryKeychainProfile: "profile" },
      }, {
        ...base,
        distribution: {
          ...base.distribution,
          verifyDistribution: async (...args) => {
            verifications += 1;
            if (verifications === 2) throw new Error("published bytes drifted");
            return await base.distribution!.verifyDistribution!(...args);
          },
        },
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(HomeMacosDistributionPublicationError);
      expect(error).toMatchObject({ published: true, durability: "uncertain" });
      expect((await readdir(output)).sort()).toEqual(["private", "public"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

type FlatBuildTestDeps = NonNullable<BuildHomeMacosDistributionTestDeps["artifact"]> &
  NonNullable<BuildHomeMacosDistributionTestDeps["distribution"]> &
  NonNullable<BuildHomeMacosDistributionTestDeps["publication"]> &
  Readonly<{ platform?: NodeJS.Platform; arch?: string }>;

function groupBuildDeps(deps: FlatBuildTestDeps): BuildHomeMacosDistributionTestDeps {
  return {
    host: {
      ...(deps.platform === undefined ? {} : { platform: deps.platform }),
      ...(deps.arch === undefined ? {} : { arch: deps.arch }),
    },
    artifact: {
      ...(deps.buildArtifact === undefined ? {} : { buildArtifact: deps.buildArtifact }),
      ...(deps.signArtifact === undefined ? {} : { signArtifact: deps.signArtifact }),
      ...(deps.verifyArtifact === undefined ? {} : { verifyArtifact: deps.verifyArtifact }),
      ...(deps.reproveSource === undefined ? {} : { reproveSource: deps.reproveSource }),
    },
    distribution: {
      ...(deps.run === undefined ? {} : { run: deps.run }),
      ...(deps.createDmg === undefined ? {} : { createDmg: deps.createDmg }),
      ...(deps.digest === undefined ? {} : { digest: deps.digest }),
      ...(deps.verifyDistribution === undefined ? {} : { verifyDistribution: deps.verifyDistribution }),
    },
    publication: {
      ...(deps.publish === undefined ? {} : { publish: deps.publish }),
      ...(deps.syncFile === undefined ? {} : { syncFile: deps.syncFile }),
      ...(deps.syncDirectory === undefined ? {} : { syncDirectory: deps.syncDirectory }),
    },
  };
}

function fakeDistributionBuildDeps(
  overrides: Partial<FlatBuildTestDeps> = {},
): BuildHomeMacosDistributionTestDeps {
  let manifest: HomeArtifactManifest | undefined;
  const deps: FlatBuildTestDeps = {
    platform: "darwin",
    arch: "arm64",
    signArtifact: async () => signedManifest().codeSigning!,
    buildArtifact: async (options) => {
      const artifactRoot = join(options.outputDir, "dome-home-0.2.0-darwin-arm64");
      await mkdir(artifactRoot, { recursive: true });
      const codeSigning = await options.beforeManifest({
        artifactRoot,
        sources: { bun: "bun", age: "age", ageKeygen: "age-keygen" },
      });
      manifest = { ...signedManifest(), codeSigning };
      const manifestText = `${JSON.stringify(manifest)}\n`;
      const archive = join(options.outputDir, "artifact.tar.gz");
      const evidence = join(options.outputDir, "activation.json");
      await writeFile(join(artifactRoot, "manifest.json"), manifestText);
      await writeFile(archive, "archive");
      await writeFile(evidence, `${JSON.stringify(rawActivationEvidence({
        archiveSha256: digestText("archive"), manifestSha256: digestText(manifestText),
      }))}\n`);
      return {
        directory: artifactRoot,
        archive,
        archiveSha256: digestText("archive"),
        evidence,
        evidenceSha256: digestText(await readFile(evidence, "utf8")),
        manifest,
      };
    },
    createDmg: async (input) => {
      await writeFile(input.dmgPath, "distributed dmg\n");
      const codeSigning = input.manifest.codeSigning!;
      return {
        schema: "dome.home-macos-distribution/v1",
        product: { version: input.manifest.product.version, target: "darwin-arm64" },
        artifact: {
          id: input.manifest.artifact.id,
          buildCommit: input.manifest.build.gitCommit,
          archiveSha256: input.archiveSha256,
          manifestSha256: digestText(await readFile(join(input.artifactRoot, "manifest.json"), "utf8")),
          activationEvidenceSha256: digestText(await readFile(input.activationEvidencePath, "utf8")),
          activationBindingSha256: digestText(`${JSON.stringify(input.activationBinding, null, 2)}\n`),
          codeSigning,
          codeSigningSha256: digestText(JSON.stringify(codeSigning)),
        },
        container: {
          format: "dmg",
          name: "dome-home-0.2.0-darwin-arm64.dmg",
          submitted: { bytes: 14, sha256: "8".repeat(64) },
          distributed: { bytes: 16, sha256: digestText("distributed dmg\n") },
          signature: { teamId: DOME_TEAM, cdHash: "5".repeat(40), secureTimestamp: true },
        },
        notarization: {
          submissionId: "11111111-2222-4333-8444-555555555555",
          status: "Accepted",
          logSha256: "7".repeat(64),
          issues: 0,
          stapled: true,
          assessed: true,
        },
      };
    },
    verifyArtifact: async () => manifest!,
    reproveSource: async () => {},
    verifyDistribution: async (directory) => {
      const publicDirectory = join(directory, "public");
      const names = await readdir(publicDirectory);
      const receiptPath = join(publicDirectory, names.find((name) => name.endsWith(".distribution-receipt.json"))!);
      const activationBindingPath = join(publicDirectory, names.find((name) => name.endsWith(".activation-binding.json"))!);
      return {
        receipt: parseHomeMacosDistributionReceipt(JSON.parse(await readFile(receiptPath, "utf8"))),
        activationBinding: parseHomeMacosActivationBinding(JSON.parse(await readFile(activationBindingPath, "utf8"))),
        dmgPath: join(publicDirectory, names.find((name) => name.endsWith(".dmg"))!),
        receiptPath,
        activationBindingPath,
      };
    },
    syncFile: async () => {},
    syncDirectory: async () => {},
    publish: async (source, target) => { await rename(source, target); },
    ...overrides,
  };
  return groupBuildDeps(deps);
}

function signedManifest(): HomeArtifactManifest {
  const codeSigning: HomeArtifactCodeSigning = Object.freeze({
    executables: Object.freeze([
      signingRow("runtime/age", PINNED_AGE_BINARY_SHA256, "a".repeat(64), DOME_TEAM, "1"),
      signingRow("runtime/age-keygen", PINNED_AGE_KEYGEN_BINARY_SHA256, "b".repeat(64), DOME_TEAM, "2"),
      signingRow("runtime/bun", PINNED_BUN_BINARY_SHA256, PINNED_BUN_BINARY_SHA256, PINNED_BUN_DEVELOPER_ID_TEAM_ID, "3"),
    ]),
  });
  return {
    schema: "dome.home-artifact/v1",
    product: { name: "Dome Home", version: "0.2.0" },
    target: { os: "darwin", arch: "arm64" },
    build: { gitCommit: "6".repeat(40) },
    artifact: { id: "9".repeat(64) },
    codeSigning,
    distribution: { signed: true, notarized: false, upgradeSupported: true },
  } as HomeArtifactManifest;
}

function digestText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function activationBinding(): HomeMacosActivationBinding {
  return parseHomeMacosActivationBinding({
    schema: "dome.home-macos-activation-binding/v1",
    predecessor: {
      artifactId: "1".repeat(64), version: "0.1.0", buildCommit: "2".repeat(40),
      archiveSha256: "3".repeat(64), manifestSha256: "4".repeat(64),
    },
    candidate: {
      artifactId: "9".repeat(64), version: "0.2.0", buildCommit: "6".repeat(40),
      archiveSha256: "6".repeat(64), manifestSha256: "e".repeat(64),
    },
    fixture: { releaseId: "n-1", sourceCommit: "7".repeat(40), canaryDigest: "8".repeat(64) },
    scenarios: ["ready-success", "stopped-precommit-crash", "committed-exact-repair"],
  });
}

function rawActivationEvidence(input: Readonly<{ archiveSha256: string; manifestSha256: string }>): unknown {
  const binding = activationBinding();
  return {
    schema: "dome.home-installed-upgrade-rehearsal/v1",
    evidence: "installed-darwin-arm64",
    host: { platform: "darwin", arch: "arm64", uid: 501 },
    predecessor: binding.predecessor,
    candidate: { ...binding.candidate, archiveSha256: input.archiveSha256, manifestSha256: input.manifestSha256 },
    fixture: binding.fixture,
    scenarios: binding.scenarios,
  };
}

function signingRow(
  path: "runtime/age" | "runtime/age-keygen" | "runtime/bun",
  sourceSha256: string,
  shippedSha256: string,
  teamId: string,
  cd: string,
): HomeArtifactCodeSigning["executables"][number] {
  return Object.freeze({
    path,
    sourceSha256,
    shippedSha256,
    teamId,
    cdHash: cd.repeat(40),
    hardenedRuntime: true,
    secureTimestamp: true,
    entitlementsSha256: "4".repeat(64),
  });
}
