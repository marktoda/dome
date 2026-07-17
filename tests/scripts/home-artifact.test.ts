import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  createDeterministicTar,
  compileHomeCredentialHelper,
  exerciseArtifactHomeReadinessForTests,
  HOME_ARTIFACT_READINESS_TIMEOUT_MS,
  inspectHomeArtifactTar,
  assertSourceSnapshot,
  HOME_ARTIFACT_SCHEMA,
  normalizeArtifactModes,
  parseGeneratedPwaPrecache,
  parseGeneratedWorkboxRuntimePath,
  PINNED_AGE_ARCHIVE_SHA256,
  PINNED_AGE_ARCHIVE_URL,
  PINNED_AGE_BINARY_SHA256,
  PINNED_AGE_KEYGEN_BINARY_SHA256,
  PINNED_AGE_LICENSE_SHA256,
  PINNED_AGE_VERSION,
  PINNED_BUN_VERSION,
  PINNED_BUN_BINARY_SHA256,
  stageAndPublishHomeArtifactCandidate,
  verifyHomeArtifact,
  writeArtifactMetadata,
  writeSignedArtifactMetadataForTests,
} from "../../scripts/home-artifact";
import { parsePwaShellHashedAssetPath } from "../../scripts/home-pwa-shell";
import { HOME_DURABLE_STATE_PROTOCOL, HOME_STORE_MIGRATIONS } from "../../src/product-host/home-store-migrations";
import { HOME_PAIRING_READINESS_TIMEOUT_MS } from "../../src/product-host/home-readiness";
import {
  parseHomeArtifactManifest,
  HOME_RUNTIME_LAUNCH_ALIAS_PATH,
  HOME_RUNTIME_PATH,
  homeArtifactLaunchCapability,
  verifyHomeArtifactToolChecksumMetadataForTests,
  verifyHomeArtifact as shippedVerifyHomeArtifact,
  type HomeArtifactCodeSigning,
  type HomeArtifactManifest,
} from "../../src/product-host/home-artifact";

describe("Dome Home artifact", () => {
  test("accepts the URL-safe hashed asset names emitted in the generated PWA shell", () => {
    expect(parsePwaShellHashedAssetPath(
      '<link rel="stylesheet" href="/assets/index-CVJzGQWh.css"><script src="/assets/index-CX_-7ChH.js"></script>',
    )).toBe("/assets/index-CVJzGQWh.css");
    expect(parsePwaShellHashedAssetPath(
      '<script type="module" src="/assets/index-CX_-7ChH.js"></script>',
    )).toBe("/assets/index-CX_-7ChH.js");
    for (const body of [
      '<script src="/assets/index.js"></script>',
      '<script src="/index-AbCd1234.js"></script>',
      '<script src="/assets/index-AbCd12!.js"></script>',
      '<script src="/assets/nested/index-AbCd1234.js"></script>',
      '<script src="/assets/../index-AbCd1234.js"></script>',
    ]) {
      expect(() => parsePwaShellHashedAssetPath(body)).toThrow(
        "PWA shell did not reference a hashed asset",
      );
    }
  });

  test("normalizes the pinned GenerateSW Workbox dependency to its served runtime path", () => {
    const worker = 'if(!self.define){/* pinned loader */}define(["./workbox-1234abcd"],function(e){e.precacheAndRoute([],{})});';
    expect(parseGeneratedWorkboxRuntimePath(worker)).toBe("workbox-1234abcd.js");
  });

  test("rejects missing, duplicate, or malformed GenerateSW Workbox dependencies", () => {
    const worker = (dependency: string) =>
      `if(!self.define){/* pinned loader */}define([${dependency}],function(e){e.precacheAndRoute([],{})});`;
    for (const dependency of [
      '"./workbox-1234abcd.js"',
      '"../workbox-1234abcd"',
      '"./other-1234abcd"',
      '"./workbox-1234ABCD"',
      '"./workbox-1234abcd","./other-1234abcd"',
      "'./workbox-1234abcd'",
    ]) {
      expect(() => parseGeneratedWorkboxRuntimePath(worker(dependency))).toThrow("malformed");
    }
    expect(() => parseGeneratedWorkboxRuntimePath("self.addEventListener('install',()=>{})"))
      .toThrow("one AMD dependency list");
    expect(() => parseGeneratedWorkboxRuntimePath(
      `${worker('"./workbox-1234abcd"')}${worker('"./workbox-deadbeef"')}`,
    )).toThrow("one AMD dependency list");
  });

  test("strictly parses the pinned GenerateSW precache object literal", () => {
    const revision = "a".repeat(32);
    const worker = `define(["./workbox-1234abcd"],function(e){e.precacheAndRoute([{url:"manifest.webmanifest",revision:"${revision}"},{url:"index.html",revision:"${revision}"},{url:"pwa-192x192.png",revision:"${revision}"},{url:"maskable-icon-512x512.png",revision:"${revision}"},{url:"assets/index-AbCd1234.js",revision:null}],{}),e.cleanupOutdatedCaches()});`;
    expect(parseGeneratedPwaPrecache(worker)).toEqual([
      "manifest.webmanifest", "index.html", "pwa-192x192.png", "maskable-icon-512x512.png",
      "assets/index-AbCd1234.js",
    ]);
  });

  test("rejects malformed residue, duplicate, and unsafe GenerateSW entries", () => {
    const revision = "b".repeat(32);
    const entry = `{url:"index.html",revision:"${revision}"}`;
    const worker = (literal: string) => `e.precacheAndRoute([${literal}],{}),e.cleanupOutdatedCaches()`;
    expect(() => parseGeneratedPwaPrecache(worker(`${entry},garbage`))).toThrow("malformed");
    expect(() => parseGeneratedPwaPrecache(worker(`${entry},${entry}`))).toThrow("duplicated");
    expect(() => parseGeneratedPwaPrecache(worker(`{url:"../index.html",revision:"${revision}"}`))).toThrow("unsafe");
    expect(() => parseGeneratedPwaPrecache(worker(`{url:"assets/icon-AbCd1234.png",revision:null}`))).toThrow("unsafe");
    expect(() => parseGeneratedPwaPrecache(worker(`{url:"pwa-128x128.png",revision:"${revision}"}`))).toThrow("unsafe");
    expect(() => parseGeneratedPwaPrecache(`${worker(entry)}${worker(entry)}`)).toThrow("one precache call");
  });

  test("the builder exports the exact shipped verifier", () => {
    expect(verifyHomeArtifact).toBe(shippedVerifyHomeArtifact);
  });

  test("credential helper compilation pins the exact staged Bun and provider bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-home-helper-compile-"));
    const source = join(root, "helper.c");
    const provider = join(root, "anthropic.ts");
    const bun = join(root, "bun");
    const target = join(root, "helper");
    let command: ReadonlyArray<string> = [];
    try {
      await writeFile(source, "int main(void) { return 0; }\n");
      await writeFile(provider, "provider fixture\n");
      await writeFile(bun, "bun fixture\n");
      await compileHomeCredentialHelper(source, target, provider, bun, { run: async (argv) => {
        command = argv;
        await writeFile(target, "mach-o fixture", { mode: 0o755 });
      } });
      expect(command).toContain("-arch");
      expect(command).toContain("arm64");
      expect(command).toContain("-mmacosx-version-min=13.0");
      expect(command).toContain(`-DSHIPPED_PROVIDER_SHA256=\"${digest(await readFile(provider))}\"`);
      expect(command).toContain(`-DSHIPPED_BUN_SHA256=\"${digest(await readFile(bun))}\"`);
      expect(command.at(-1)).toBe(target);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("the artifact builder compiles against the staged shipped Bun path", async () => {
    const source = await readFile(join(import.meta.dir, "..", "..", "scripts", "home-artifact.ts"), "utf8");
    expect(source).toContain('const shippedBun = join(directory, "runtime", "bun");');
    expect(source).toContain("shippedModelProviderSource,\n          shippedBun,\n");
    const signing = source.indexOf("const codeSigning = options.beforeManifest");
    const alias = source.indexOf("await link(shippedBun, join(directory, HOME_RUNTIME_LAUNCH_ALIAS_PATH))");
    const metadata = source.indexOf("const manifest = await writeArtifactMetadataForRelease");
    expect(signing).toBeGreaterThan(-1);
    expect(alias).toBeGreaterThan(signing);
    expect(metadata).toBeGreaterThan(alias);
  });

  test("derives named launch only from an exact executable manifest twin", async () => {
    const root = await verifiableFixture();
    try {
      const legacy = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
      expect(homeArtifactLaunchCapability(parseHomeArtifactManifest(legacy))).toEqual({
        kind: "legacy", programPath: HOME_RUNTIME_PATH, argv0: null,
      });

      await link(join(root, HOME_RUNTIME_PATH), join(root, HOME_RUNTIME_LAUNCH_ALIAS_PATH));
      const named = await writeArtifactMetadata(root, "1.0.0");
      expect(homeArtifactLaunchCapability(named)).toEqual({
        kind: "named", programPath: HOME_RUNTIME_LAUNCH_ALIAS_PATH, argv0: "Dome Home",
      });
      const runtime = named.entries.find((entry) => entry.path === HOME_RUNTIME_PATH);
      const alias = named.entries.find((entry) => entry.path === HOME_RUNTIME_LAUNCH_ALIAS_PATH);
      if (runtime?.type !== "file") throw new Error("test runtime missing");
      expect(alias).toEqual({ ...runtime, path: HOME_RUNTIME_LAUNCH_ALIAS_PATH });
      const checksums = await readFile(join(root, "checksums.sha256"), "utf8");
      expect(checksums).toContain(`${runtime.sha256}  ${HOME_RUNTIME_PATH}`);
      expect(checksums).toContain(`${runtime.sha256}  ${HOME_RUNTIME_LAUNCH_ALIAS_PATH}`);

      for (const mutate of [
        (entry: Record<string, unknown>) => { entry["sha256"] = "f".repeat(64); },
        (entry: Record<string, unknown>) => { entry["bytes"] = 1; },
        (entry: Record<string, unknown>) => { entry["mode"] = "0644"; },
        (entry: Record<string, unknown>) => { entry["type"] = "directory"; delete entry["bytes"]; delete entry["sha256"]; },
      ]) {
        const malformed = structuredClone(named) as unknown as { entries: Array<Record<string, unknown>> };
        mutate(malformed.entries.find((entry) => entry["path"] === HOME_RUNTIME_LAUNCH_ALIAS_PATH)!);
        expect(() => homeArtifactLaunchCapability(malformed as unknown as HomeArtifactManifest))
          .toThrow("not an exact executable Bun twin");
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("portable Home rehearsal shares the supervised startup budget", () => {
    expect(HOME_PAIRING_READINESS_TIMEOUT_MS).toBe(120_000);
    expect(HOME_ARTIFACT_READINESS_TIMEOUT_MS).toBe(HOME_PAIRING_READINESS_TIMEOUT_MS);
  });

  test("portable Home readiness accepts completion beyond the modeled old deadline", async () => {
    const encoder = new TextEncoder();
    const oldDeadlineMs = 10;
    const delayed = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(encoder.encode("dome home: serving http://127.0.0.1:43123\n"));
          controller.close();
        }, oldDeadlineMs + 10);
      },
    });
    let resolveExit: ((code: number) => void) | undefined;
    const child = {
      exited: new Promise<number>((resolve) => { resolveExit = resolve; }),
      kill() { resolveExit?.(0); },
    };
    const started = performance.now();
    let readyUrl = "";
    await exerciseArtifactHomeReadinessForTests(child, delayed.getReader(), async (url) => { readyUrl = url; }, 100, 10);
    expect(performance.now() - started).toBeGreaterThan(oldDeadlineMs);
    expect(readyUrl).toBe("http://127.0.0.1:43123");
  });

  test("portable Home timeout terminates then drains the same pending reader with bounded diagnostics", async () => {
    const encoder = new TextEncoder();
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`${"x".repeat(12_000)}\nBearer secret-value\n/Users/mark.toda/private\n`));
      },
      cancel() { events.push("drain"); },
    });
    const events: string[] = [];
    const signals: string[] = [];
    let resolveExit: ((code: number) => void) | undefined;
    const reader = stalled.getReader();
    const release = reader.releaseLock.bind(reader);
    reader.releaseLock = () => { events.push("release"); release(); };
    let failure: unknown;
    try {
      await exerciseArtifactHomeReadinessForTests({
        exited: new Promise<number>((resolve) => { resolveExit = resolve; }),
        kill(signal) {
          signals.push(String(signal));
          if (signal === "SIGKILL") resolveExit?.(137);
        },
      }, reader, async () => {}, 5, 5);
    } catch (error) { failure = error; }
    const message = failure instanceof Error ? failure.message : String(failure);
    expect(message).toContain("startup timed out after 5ms");
    expect(message.length).toBeLessThanOrEqual(2_200);
    expect(message).not.toContain("secret-value");
    expect(message).not.toContain("mark.toda");
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(events).toEqual(["drain", "release"]);
  });

  test("portable Home readiness distinguishes early exit and preserves primary cleanup failure", async () => {
    const encoder = new TextEncoder();
    const failed = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode("bind failed\n")); controller.close(); },
    });
    await expect(exerciseArtifactHomeReadinessForTests({
      exited: Promise.resolve(78),
      kill() {},
    }, failed.getReader(), async () => {}, 50, 5)).rejects.toThrow(
      "artifact dome home exited before readiness (code 78)\nbind failed\n",
    );

    const ready = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode("dome home: serving http://127.0.0.1:43123\n")); },
      cancel() { events.push("cancel"); },
    });
    const events: string[] = [];
    const reader = ready.getReader();
    const release = reader.releaseLock.bind(reader);
    reader.releaseLock = () => { events.push("release"); release(); };
    let combinedFailure: unknown;
    try {
      await exerciseArtifactHomeReadinessForTests({
        exited: Promise.reject(new Error("exit observer failed")),
        kill(signal) { events.push(String(signal)); },
      }, reader, async () => {
        throw new Error("primary gate failed");
      }, 50, 5);
    } catch (error) { combinedFailure = error; }
    expect(combinedFailure).toBeInstanceOf(Error);
    const combinedMessage = combinedFailure instanceof Error ? combinedFailure.message : "";
    expect(combinedMessage).toContain("primary gate failed; cleanup also failed:");
    expect(combinedMessage).toContain("child exit wait failed after SIGKILL: exit observer failed");
    expect(events).toEqual(["SIGTERM", "SIGKILL", "cancel", "release"]);
  });

  test("assembles and runs configured gates in private state before one publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-home-candidate-test-"));
    const output = join(root, "release", "dist");
    const events: string[] = [];
    let privateDirectory = "";
    try {
      const result = await stageAndPublishHomeArtifactCandidate({
        outputDir: output,
        artifactName: "dome-home-0.1.0-darwin-arm64",
        assemble: async (paths) => {
          events.push("assemble");
          privateDirectory = paths.directory;
          expect(paths.artifactName).toBe("dome-home-0.1.0-darwin-arm64");
          expect(paths.archiveName).toBe("dome-home-0.1.0-darwin-arm64.tar.gz");
          expect(basename(dirname(paths.directory)).startsWith(".dome-home-candidate-")).toBeTrue();
          await mkdir(paths.directory, { recursive: true });
          await writeFile(join(paths.directory, "payload"), "candidate\n");
          await writeFile(paths.archive, "archive\n");
        },
        verifyArtifact: async (candidate) => {
          events.push("verify-artifact");
          expect(await readFile(candidate.archive, "utf8")).toBe("archive\n");
        },
        rehearseArchive: async () => { events.push("rehearse-archive"); },
      }, async (source, target) => {
        events.push("publish");
        expect(await pathExists(target)).toBeFalse();
        expect((await readdir(source)).sort()).toEqual([
          "dome-home-0.1.0-darwin-arm64",
          "dome-home-0.1.0-darwin-arm64.tar.gz",
        ]);
        await rename(source, target);
      });

      expect(events).toEqual(["assemble", "verify-artifact", "rehearse-archive", "publish"]);
      const canonicalOutput = join(await realpath(join(root, "release")), "dist");
      expect(result.directory).toBe(join(canonicalOutput, "dome-home-0.1.0-darwin-arm64"));
      expect(result.archive).toBe(join(canonicalOutput, "dome-home-0.1.0-darwin-arm64.tar.gz"));
      expect(result.directory).not.toBe(privateDirectory);
      expect(await readFile(join(result.directory, "payload"), "utf8")).toBe("candidate\n");
      expect(await readdir(join(root, "release"))).toEqual(["dist"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a failed gate publishes nothing, skips later gates, and removes private state", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-home-candidate-failure-"));
    const output = join(root, "dist");
    const events: string[] = [];
    try {
      await expect(stageAndPublishHomeArtifactCandidate({
        outputDir: output,
        artifactName: "candidate",
        assemble: async (paths) => {
          events.push("assemble");
          await mkdir(paths.directory);
          await writeFile(paths.archive, "private archive");
        },
        verifyArtifact: async () => { events.push("verify-artifact"); },
        rehearseArchive: async () => {
          events.push("rehearse-archive");
          throw new Error("candidate rejected");
        },
      }, async () => { events.push("publish"); })).rejects.toThrow("candidate rejected");

      expect(events).toEqual(["assemble", "verify-artifact", "rehearse-archive"]);
      expect(await pathExists(output)).toBeFalse();
      expect((await readdir(root)).filter((name) => name.startsWith(".dome-home-candidate-"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("verification failure skips rehearsal and publication and removes private state", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-home-candidate-verification-"));
    const events: string[] = [];
    try {
      await expect(stageAndPublishHomeArtifactCandidate({
        outputDir: join(root, "dist"),
        artifactName: "candidate",
        assemble: async (paths) => {
          events.push("assemble");
          await mkdir(paths.directory);
          await writeFile(paths.archive, "archive\n");
        },
        verifyArtifact: async () => {
          events.push("verify-artifact");
          throw new Error("verification rejected");
        },
        rehearseArchive: async () => { events.push("rehearse-archive"); },
      }, async () => { events.push("publish"); })).rejects.toThrow("verification rejected");

      expect(events).toEqual(["assemble", "verify-artifact"]);
      expect((await readdir(root)).filter((name) => name.startsWith(".dome-home-candidate-"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("publication failure removes only the still-owned staging inode", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-home-candidate-publish-failure-"));
    try {
      await expect(stageAndPublishHomeArtifactCandidate({
        outputDir: join(root, "dist"),
        artifactName: "candidate",
        assemble: async (paths) => {
          await mkdir(paths.directory);
          await writeFile(paths.archive, "archive\n");
        },
        verifyArtifact: async () => {},
        rehearseArchive: async () => {},
      }, async () => { throw new Error("publication rejected"); })).rejects.toThrow("publication rejected");

      expect(await pathExists(join(root, "dist"))).toBeFalse();
      expect((await readdir(root)).filter((name) => name.startsWith(".dome-home-candidate-"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rename-then-throw publication never removes a replacement at the former staging path", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-home-candidate-cleanup-race-"));
    const output = join(root, "dist");
    let replacement = "";
    try {
      await expect(stageAndPublishHomeArtifactCandidate({
        outputDir: output,
        artifactName: "candidate",
        assemble: async (paths) => {
          await mkdir(paths.directory);
          await writeFile(paths.archive, "archive\n");
        },
        verifyArtifact: async () => {},
        rehearseArchive: async () => {},
      }, async (source, target) => {
        await rename(source, target);
        replacement = source;
        await mkdir(replacement);
        await writeFile(join(replacement, "not-owned-by-builder"), "keep\n");
        throw new Error("publisher failed after rename");
      })).rejects.toThrow("publisher failed after rename");

      expect(await readFile(join(replacement, "not-owned-by-builder"), "utf8")).toBe("keep\n");
      expect(await readFile(join(output, "candidate.tar.gz"), "utf8")).toBe("archive\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses every existing output target without assembling or deleting it", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-home-candidate-existing-"));
    try {
      for (const kind of ["directory", "file", "symbolic link"] as const) {
        const output = join(root, kind.replace(" ", "-"));
        if (kind === "directory") await mkdir(output);
        else if (kind === "file") await writeFile(output, "keep\n");
        else await symlink(join(root, "missing-target"), output);
        let assembled = false;
        await expect(stageAndPublishHomeArtifactCandidate({
          outputDir: output,
          artifactName: "candidate",
          assemble: async () => {
            assembled = true;
          },
          verifyArtifact: async () => {},
          rehearseArchive: async () => {},
        })).rejects.toThrow(`already exists as a ${kind}`);
        expect(assembled).toBeFalse();
        expect((await lstat(output)).isSymbolicLink()).toBe(kind === "symbolic link");
        if (kind === "file") expect(await readFile(output, "utf8")).toBe("keep\n");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses a symlink output parent and a parent retarget before publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-home-candidate-parent-"));
    try {
      const realParent = join(root, "real-parent");
      const linkedParent = join(root, "linked-parent");
      await mkdir(realParent);
      await symlink(realParent, linkedParent);
      await expect(stageAndPublishHomeArtifactCandidate({
        outputDir: join(linkedParent, "dist"),
        artifactName: "candidate",
        assemble: async () => {},
        verifyArtifact: async () => {},
        rehearseArchive: async () => {},
      })).rejects.toThrow("output parent must be a direct non-symlink directory");

      const parent = join(root, "mutable-parent");
      const movedParent = join(root, "moved-parent");
      await mkdir(parent);
      let publishCalled = false;
      let stagedName = "";
      await expect(stageAndPublishHomeArtifactCandidate({
        outputDir: join(parent, "dist"),
        artifactName: "candidate",
        assemble: async (paths) => {
          stagedName = basename(dirname(paths.directory));
          await mkdir(paths.directory);
          await writeFile(paths.archive, "archive\n");
        },
        verifyArtifact: async () => {},
        rehearseArchive: async () => {
          await rename(parent, movedParent);
          await mkdir(parent);
        },
      }, async () => { publishCalled = true; })).rejects.toThrow("output parent changed during candidate assembly");

      expect(publishCalled).toBeFalse();
      expect(await pathExists(join(parent, "dist"))).toBeFalse();
      expect(await pathExists(join(movedParent, stagedName))).toBeTrue();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses staging beneath a copied source tree before assembly or directory creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-home-candidate-recursion-"));
    const copiedRoot = join(root, "src");
    const nestedParent = join(copiedRoot, "generated");
    await mkdir(copiedRoot);
    let assembled = false;
    try {
      await expect(stageAndPublishHomeArtifactCandidate({
        outputDir: join(nestedParent, "dist"),
        artifactName: "candidate",
        forbiddenStagingRoots: [copiedRoot],
        assemble: async () => { assembled = true; },
        verifyArtifact: async () => {},
        rehearseArchive: async () => {},
      })).rejects.toThrow("output parent is inside copied source tree");

      expect(assembled).toBeFalse();
      expect(await pathExists(nestedParent)).toBeFalse();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("concurrent candidate publications leave one complete winner and no staging debris", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-home-candidate-race-"));
    const output = join(root, "dist");
    let arrivals = 0;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const build = (id: string) => stageAndPublishHomeArtifactCandidate({
      outputDir: output,
      artifactName: "candidate",
      assemble: async (paths) => {
        await mkdir(paths.directory);
        await writeFile(join(paths.directory, "winner"), `${id}\n`);
        await writeFile(paths.archive, `archive-${id}\n`);
      },
      verifyArtifact: async () => {
        arrivals += 1;
        if (arrivals === 2) release();
        await ready;
      },
      rehearseArchive: async () => {},
    }, async (source, target) => { await rename(source, target); });
    try {
      const outcomes = await Promise.allSettled([build("one"), build("two")]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
      const winner = (await readFile(join(output, "candidate", "winner"), "utf8")).trim();
      expect(["one", "two"]).toContain(winner);
      expect(await readFile(join(output, "candidate.tar.gz"), "utf8")).toBe(`archive-${winner}\n`);
      expect((await readdir(root)).filter((name) => name.startsWith(".dome-home-candidate-"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("source proof excludes only its private staging root and catches concurrent source mutation", async () => {
    const repo = await mkdtemp(join(tmpdir(), "dome-home-candidate-source-"));
    const events: string[] = [];
    try {
      await git(repo, "init", "-q");
      await git(repo, "config", "user.name", "Artifact Test");
      await git(repo, "config", "user.email", "artifact@localhost");
      await writeFile(join(repo, "tracked.txt"), "one\n");
      await git(repo, "add", ".");
      await git(repo, "-c", "commit.gpgsign=false", "commit", "-qm", "one");
      const head = (await git(repo, "rev-parse", "HEAD")).trim();

      await expect(stageAndPublishHomeArtifactCandidate({
        outputDir: join(repo, "dist"),
        artifactName: "candidate",
        assemble: async (paths) => {
          events.push("assemble");
          await mkdir(paths.directory);
          await writeFile(paths.archive, "private archive\n");
          await assertSourceSnapshot(repo, head, join(paths.directory, ".."));
          events.push("private-staging-ignored");
          await writeFile(join(repo, "tracked.txt"), "concurrent mutation\n");
          await assertSourceSnapshot(repo, head, join(paths.directory, ".."));
        },
        verifyArtifact: async () => { events.push("verify"); },
        rehearseArchive: async () => { events.push("rehearse"); },
      }, async () => { events.push("publish"); })).rejects.toThrow("source worktree changed");

      expect(events).toEqual(["assemble", "private-staging-ignored"]);
      expect(await pathExists(join(repo, "dist"))).toBeFalse();
      expect((await readdir(repo)).filter((name) => name.startsWith(".dome-home-candidate-"))).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("writes an honest versioned manifest and sorted checksums", async () => {
    const pkg = JSON.parse(await readFile(join(import.meta.dir, "..", "..", "package.json"), "utf8")) as {
      readonly version: string;
    };
    expect(pkg.version).toBe("0.3.9");
    const root = await fixture();
    try {
      const manifest = await writeArtifactMetadata(root, "9.8.7");
      expect(manifest.schema).toBe(HOME_ARTIFACT_SCHEMA);
      expect(manifest.product.version).toBe("9.8.7");
      expect(manifest.runtime.version).toBe(PINNED_BUN_VERSION);
      expect(manifest.tools).toEqual([
        {
          name: "age",
          version: PINNED_AGE_VERSION,
          path: "runtime/age",
          sourceUrl: PINNED_AGE_ARCHIVE_URL,
          archiveSha256: PINNED_AGE_ARCHIVE_SHA256,
          sha256: "unavailable",
          licensePath: "licenses/age-LICENSE",
          licenseSha256: "unavailable",
        },
        {
          name: "age-keygen",
          version: PINNED_AGE_VERSION,
          path: "runtime/age-keygen",
          sourceUrl: PINNED_AGE_ARCHIVE_URL,
          archiveSha256: PINNED_AGE_ARCHIVE_SHA256,
          sha256: "unavailable",
          licensePath: "licenses/age-LICENSE",
          licenseSha256: "unavailable",
        },
      ]);
      expect(manifest.distribution).toEqual({
        signed: false,
        notarized: false,
        upgradeSupported: false,
      });
      expect(manifest.writerBarrier).toEqual({ protocol: 1 });
      expect(manifest.durableState).toEqual({
        protocol: HOME_DURABLE_STATE_PROTOCOL,
        stores: HOME_STORE_MIGRATIONS,
      });
      expect(manifest.entries.filter((entry) => entry.type === "file").map((entry) => entry.path)).toEqual([
        "app/pwa/dist/index.html",
        "bin/dome",
      ]);

      const checksums = (await readFile(join(root, "checksums.sha256"), "utf8"))
        .trim().split("\n");
      expect(checksums).toHaveLength(3);
      expect(checksums.map((line) => line.slice(66))).toEqual([
        "app/pwa/dist/index.html",
        "bin/dome",
        "manifest.json",
      ]);
      expect(checksums.every((line) => /^[a-f0-9]{64}  \S+$/.test(line))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("binds the credential-helper protocol to its exact checksummed executable", async () => {
    const root = await verifiableFixture();
    try {
      const helper = join(root, "runtime", "dome-keychain-helper");
      const provider = join(root, "app", "assets", "model-providers", "anthropic.ts");
      await mkdir(dirname(provider), { recursive: true });
      await writeFile(helper, "compiled helper fixture\n", { mode: 0o755 });
      await writeFile(provider, "shipped provider fixture\n", { mode: 0o644 });
      const manifest = await writeArtifactMetadata(root, "1.0.0");
      const sha256 = digest(await readFile(helper));
      const providerSha256 = digest(await readFile(provider));
      expect(manifest.homeCredentials).toEqual({
        protocol: 1, path: "runtime/dome-keychain-helper", sha256,
        providerPath: "app/assets/model-providers/anthropic.ts", providerSha256,
      });
      expect(manifest.entries).toContainEqual(expect.objectContaining({
        type: "file", path: "runtime/dome-keychain-helper", sha256, mode: "0755",
      }));
      expect(await readFile(join(root, "checksums.sha256"), "utf8"))
        .toContain(`${sha256}  runtime/dome-keychain-helper`);
      expect(parseHomeArtifactManifest(JSON.parse(await readFile(join(root, "manifest.json"), "utf8"))).homeCredentials)
        .toEqual(manifest.homeCredentials);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("emits byte-identical tar streams independent of mtimes", async () => {
    const root = await fixture();
    try {
      await writeArtifactMetadata(root, "1.0.0");
      const first = await createDeterministicTar(root);
      await Bun.sleep(5);
      await writeFile(join(root, "app", "pwa", "dist", "index.html"), "<main>Dome</main>\n");
      const second = await createDeterministicTar(root);
      expect(digest(second)).toBe(digest(first));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("strictly inspects USTAR while accepting only contained artifact symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-home-tar-links-"));
    try {
      await mkdir(join(root, "bin"));
      await mkdir(join(root, "target"));
      await writeFile(join(root, "target", "tool"), "tool\n");
      await symlink("../target/tool", join(root, "bin", "tool"));
      const inspected = inspectHomeArtifactTar(await createDeterministicTar(root, "dome"));
      expect(inspected.root).toBe("dome");
      expect(inspected.entries.find((entry) => entry.path === "dome/bin/tool")).toEqual({
        path: "dome/bin/tool",
        type: "symlink",
        size: 0,
        linkTarget: "../target/tool",
      });

      await rm(join(root, "bin", "tool"));
      await symlink("../../outside", join(root, "bin", "tool"));
      const escaping = await createDeterministicTar(root, "dome");
      expect(() => inspectHomeArtifactTar(escaping))
        .toThrow("symlink escapes its root");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("encodes one Bun body plus the exact extractable Home hardlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-home-tar-hardlink-"));
    const extracted = await mkdtemp(join(tmpdir(), "dome-home-tar-hardlink-extract-"));
    try {
      await mkdir(join(root, "runtime"));
      await writeFile(join(root, HOME_RUNTIME_PATH), "bun body\n", { mode: 0o755 });
      await link(join(root, HOME_RUNTIME_PATH), join(root, HOME_RUNTIME_LAUNCH_ALIAS_PATH));
      const tar = await createDeterministicTar(root, "dome");
      expect(await createDeterministicTar(root, "dome")).toEqual(tar);
      const inspected = inspectHomeArtifactTar(tar);
      expect(inspected.entries.find((entry) => entry.path === "dome/runtime/bun")).toMatchObject({
        type: "file", size: 9, linkTarget: null,
      });
      expect(inspected.entries.find((entry) => entry.path === "dome/runtime/Dome Home")).toEqual({
        path: "dome/runtime/Dome Home",
        type: "hardlink",
        size: 0,
        linkTarget: "dome/runtime/bun",
      });
      const tarPath = join(extracted, "artifact.tar");
      await writeFile(tarPath, tar);
      const child = Bun.spawn(["/usr/bin/tar", "-xf", tarPath, "-C", extracted], {
        stdout: "ignore", stderr: "pipe",
      });
      expect(await child.exited).toBe(0);
      const [runtimeInfo, aliasInfo] = await Promise.all([
        lstat(join(extracted, "dome", HOME_RUNTIME_PATH)),
        lstat(join(extracted, "dome", HOME_RUNTIME_LAUNCH_ALIAS_PATH)),
      ]);
      expect([runtimeInfo.dev, runtimeInfo.ino, runtimeInfo.nlink]).toEqual([
        aliasInfo.dev, aliasInfo.ino, 2,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(extracted, { recursive: true, force: true });
    }
  });

  test("rejects every other or malformed USTAR hardlink and bad checksums", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-home-tar-types-"));
    try {
      await writeFile(join(root, "file"), "payload\n");
      const original = await createDeterministicTar(root, "dome");
      const hardlink = Buffer.from(original);
      rewriteTarType(hardlink, 512, "1");
      expect(() => inspectHomeArtifactTar(hardlink)).toThrow("hardlink has a body");

      await mkdir(join(root, "runtime"));
      await writeFile(join(root, HOME_RUNTIME_PATH), "");
      await link(join(root, HOME_RUNTIME_PATH), join(root, HOME_RUNTIME_LAUNCH_ALIAS_PATH));
      const normalized = await createDeterministicTar(root, "dome");
      const aliasOffset = tarHeaderOffset(normalized, "dome/runtime/Dome Home");
      const runtimeOffset = tarHeaderOffset(normalized, "dome/runtime/bun");
      const ordinaryAlias = Buffer.from(normalized);
      rewriteTarType(ordinaryAlias, aliasOffset, "0");
      expect(() => inspectHomeArtifactTar(ordinaryAlias)).toThrow("reserved runtime alias");
      const symlinkAlias = Buffer.from(normalized);
      rewriteTarLink(symlinkAlias, aliasOffset, "bun");
      expect(() => inspectHomeArtifactTar(symlinkAlias)).toThrow("reserved runtime alias");
      const wrongTarget = Buffer.from(normalized);
      rewriteTarLink(wrongTarget, aliasOffset, "dome/runtime/age", "1");
      expect(() => inspectHomeArtifactTar(wrongTarget)).toThrow("unsupported hardlink");
      const body = Buffer.from(normalized);
      rewriteTarSize(body, aliasOffset, 1);
      expect(() => inspectHomeArtifactTar(body)).toThrow("hardlink has a body");
      const forward = Buffer.from(normalized);
      const runtimeHeader = Buffer.from(forward.subarray(runtimeOffset, runtimeOffset + 512));
      const aliasHeader = Buffer.from(forward.subarray(aliasOffset, aliasOffset + 512));
      aliasHeader.copy(forward, runtimeOffset);
      runtimeHeader.copy(forward, aliasOffset);
      expect(() => inspectHomeArtifactTar(forward)).toThrow("unsupported hardlink");

      const corrupt = Buffer.from(original);
      corrupt[512] = (corrupt[512] ?? 0) ^ 1;
      expect(() => inspectHomeArtifactTar(corrupt)).toThrow("header checksum is invalid");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects absolute links, members beneath links, duplicates, traversal, and trailing data", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-home-tar-closed-"));
    try {
      await mkdir(join(root, "link"));
      await writeFile(join(root, "link", "child"), "");
      const nested = await createDeterministicTar(root, "dome");
      rewriteTarName(nested, 512, "dome/link");
      rewriteTarLink(nested, 512, "target");
      expect(() => inspectHomeArtifactTar(nested)).toThrow("member beneath symlink");

      await rm(root, { recursive: true, force: true });
      await mkdir(root);
      await symlink("/tmp/outside", join(root, "absolute"));
      const absolute = await createDeterministicTar(root, "dome");
      expect(() => inspectHomeArtifactTar(absolute))
        .toThrow("symlink target is unsafe");

      await rm(root, { recursive: true, force: true });
      await mkdir(root);
      await writeFile(join(root, "a"), "");
      await writeFile(join(root, "b"), "");
      const duplicate = await createDeterministicTar(root, "dome");
      rewriteTarName(duplicate, 1024, "dome/a");
      expect(() => inspectHomeArtifactTar(duplicate)).toThrow("duplicate member");

      const traversal = await createDeterministicTar(root, "dome");
      rewriteTarName(traversal, 512, "dome/../escape");
      expect(() => inspectHomeArtifactTar(traversal)).toThrow("path is unsafe");

      const trailing = Buffer.concat([await createDeterministicTar(root, "dome"), Buffer.from([1])]);
      expect(() => inspectHomeArtifactTar(trailing)).toThrow("termination or trailing data");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects payload corruption after metadata is written", async () => {
    const root = await verifiableFixture();
    try {
      await writeFile(join(root, "app", "pwa", "dist", "index.html"), "corrupted\n");
      expect(verifyHomeArtifact(root)).rejects.toThrow("artifact checksum mismatch");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects unknown manifest fields before trusting payload paths", async () => {
    const root = await verifiableFixture();
    try {
      const path = join(root, "manifest.json");
      const manifest = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      manifest["futureSelector"] = "ambient-current-symlink";
      await writeFile(path, `${JSON.stringify(manifest)}\n`);
      expect(verifyHomeArtifact(root)).rejects.toThrow("unknown or missing fields");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("general manifest verification accepts legacy v1 without an upgrade protocol", async () => {
    const root = await verifiableFixture();
    try {
      const path = join(root, "manifest.json");
      const manifest = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      delete manifest["writerBarrier"];
      delete manifest["durableState"];
      expect(parseHomeArtifactManifest(manifest).writerBarrier).toBeUndefined();
      expect(parseHomeArtifactManifest(manifest).durableState).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("general manifest parsing accepts an explicit supported-upgrade capability", async () => {
    const root = await verifiableFixture();
    try {
      const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as Record<string, unknown>;
      manifest["distribution"] = {
        ...(manifest["distribution"] as Record<string, unknown>),
        upgradeSupported: true,
      };
      expect(parseHomeArtifactManifest(manifest).distribution.upgradeSupported).toBeTrue();
      expect(() => parseHomeArtifactManifest({
        ...manifest,
        distribution: {
          ...(manifest["distribution"] as Record<string, unknown>),
          upgradeSupported: "yes",
        },
      })).toThrow("fixed product semantics");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("structurally validates closed historical durable-state evidence", async () => {
    const root = await verifiableFixture();
    try {
      const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as Record<string, unknown>;
      const durable = structuredClone(manifest["durableState"]) as { protocol: number; stores: Array<Record<string, unknown>> };
      durable.protocol = 2;
      expect(() => parseHomeArtifactManifest({ ...manifest, durableState: durable })).toThrow("protocol or store inventory");
      durable.protocol = 1;
      durable.stores.pop();
      expect(() => parseHomeArtifactManifest({ ...manifest, durableState: durable })).toThrow("protocol or store inventory");
      durable.stores = structuredClone((manifest["durableState"] as { stores: Array<Record<string, unknown>> }).stores);
      durable.stores.reverse();
      expect(() => parseHomeArtifactManifest({ ...manifest, durableState: durable })).toThrow("store inventory is invalid");
      durable.stores.reverse();
      durable.stores[0]!["currentSchemaHash"] = "f".repeat(64);
      durable.stores[0]!["migratesFrom"] = ["e".repeat(64)];
      expect(parseHomeArtifactManifest({ ...manifest, durableState: durable }).durableState?.stores[0])
        .toEqual(expect.objectContaining({ currentSchemaHash: "f".repeat(64), migratesFrom: ["e".repeat(64)] }));
      durable.stores = structuredClone((manifest["durableState"] as { stores: Array<Record<string, unknown>> }).stores);
      durable.stores[0]!["currentSchemaHash"] = "not-a-hash";
      expect(() => parseHomeArtifactManifest({ ...manifest, durableState: durable })).toThrow("store inventory is invalid");
      durable.stores = structuredClone((manifest["durableState"] as { stores: Array<Record<string, unknown>> }).stores);
      durable.stores[1] = structuredClone(durable.stores[0]!);
      expect(() => parseHomeArtifactManifest({ ...manifest, durableState: durable })).toThrow("store inventory is invalid");
      durable.stores = structuredClone((manifest["durableState"] as { stores: Array<Record<string, unknown>> }).stores);
      durable.stores[0]!["migratesFrom"] = ["b".repeat(64), "a".repeat(64)];
      expect(() => parseHomeArtifactManifest({ ...manifest, durableState: durable })).toThrow("store inventory is invalid");
      durable.stores = structuredClone((manifest["durableState"] as { stores: Array<Record<string, unknown>> }).stores);
      durable.stores[0]!["future"] = true;
      expect(() => parseHomeArtifactManifest({ ...manifest, durableState: durable })).toThrow("unknown or missing fields");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects escaping and broken symlinks", async () => {
    const root = await verifiableFixture();
    try {
      const link = join(root, "app", "escape");
      await symlink(tmpdir(), link);
      await writeArtifactMetadata(root, "1.0.0");
      expect(verifyHomeArtifact(root)).rejects.toThrow("artifact symlink escapes its root");
      await rm(link, { force: true });
      await symlink("missing-target", link);
      await writeArtifactMetadata(root, "1.0.0");
      expect(verifyHomeArtifact(root)).rejects.toThrow("artifact contains broken symlink");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects retargeted or added symlinks and added directories", async () => {
    const root = await verifiableFixture();
    try {
      const link = join(root, "app", "pwa-link");
      await symlink("pwa", link);
      await writeArtifactMetadata(root, "1.0.0");
      await rm(link, { force: true });
      await symlink("pwa/dist", link);
      expect(verifyHomeArtifact(root)).rejects.toThrow("artifact symlink target mismatch");

      await rm(link, { force: true });
      await writeArtifactMetadata(root, "1.0.0");
      await symlink("pwa", link);
      expect(verifyHomeArtifact(root)).rejects.toThrow("artifact entry path/type set differs");
      await rm(link, { force: true });
      await mkdir(join(root, "app", "unexpected"));
      expect(verifyHomeArtifact(root)).rejects.toThrow("artifact entry path/type set differs");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("source snapshot rejects worktree mutation and HEAD movement", async () => {
    const repo = await mkdtemp(join(tmpdir(), "dome-home-source-test-"));
    try {
      await git(repo, "init", "-q");
      await git(repo, "config", "user.name", "Artifact Test");
      await git(repo, "config", "user.email", "artifact@localhost");
      await writeFile(join(repo, "tracked.txt"), "one\n");
      await git(repo, "add", ".");
      await git(repo, "-c", "commit.gpgsign=false", "commit", "-qm", "one");
      const head = (await git(repo, "rev-parse", "HEAD")).trim();
      await assertSourceSnapshot(repo, head);
      await writeFile(join(repo, "tracked.txt"), "dirty\n");
      expect(assertSourceSnapshot(repo, head)).rejects.toThrow("source worktree changed");
      await git(repo, "checkout", "--", "tracked.txt");
      await writeFile(join(repo, "tracked.txt"), "two\n");
      await git(repo, "add", ".");
      await git(repo, "-c", "commit.gpgsign=false", "commit", "-qm", "two");
      expect(assertSourceSnapshot(repo, head)).rejects.toThrow("source HEAD changed");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("normalizes archive modes while preserving executable intent", async () => {
    const root = await fixture();
    try {
      const executable = join(root, "bin", "dome");
      const regular = join(root, "app", "pwa", "dist", "index.html");
      await chmod(executable, 0o777);
      await chmod(regular, 0o666);
      await normalizeArtifactModes(root);
      expect((await lstat(root)).mode & 0o777).toBe(0o755);
      expect((await lstat(join(root, "app"))).mode & 0o777).toBe(0o755);
      expect((await lstat(executable)).mode & 0o777).toBe(0o755);
      expect((await lstat(regular)).mode & 0o777).toBe(0o644);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("pins the official age archive and both darwin-arm64 executables", () => {
    expect(PINNED_AGE_VERSION).toBe("1.3.1");
    expect(PINNED_AGE_ARCHIVE_URL).toBe(
      "https://github.com/FiloSottile/age/releases/download/v1.3.1/age-v1.3.1-darwin-arm64.tar.gz",
    );
    expect(PINNED_AGE_ARCHIVE_SHA256).toBe(
      "01120ea2cbf0463d4c6bd767f99f3271bbed1cdc8a9aa718a76ba1fe4f01998b",
    );
    expect(PINNED_AGE_BINARY_SHA256).toBe(
      "0e3ea0b1bed2b30aa2dc46eef4e1723864d626c80f37319c20d9b73ca045f56f",
    );
    expect(PINNED_AGE_KEYGEN_BINARY_SHA256).toBe(
      "37c4b509d86f233d8dd065f5a905e11d2e1d5549d59445a9bc52da9235a622ad",
    );
    expect(PINNED_AGE_LICENSE_SHA256).toBe(
      "afbdb4e07a359499db587ae632815809b1fc1670a92d5449af112ce9a67833a2",
    );
  });

  test("inventories the bundled upstream age license in tool provenance and checksums", async () => {
    const root = await fixture();
    try {
      const license = Buffer.from("upstream age license fixture\n");
      await mkdir(join(root, "licenses"), { recursive: true });
      await writeFile(join(root, "licenses", "age-LICENSE"), license);
      const manifest = await writeArtifactMetadata(root, "1.0.0");
      const licenseSha256 = digest(license);
      expect(manifest.entries).toContainEqual(expect.objectContaining({
        type: "file",
        path: "licenses/age-LICENSE",
        sha256: licenseSha256,
      }));
      expect(manifest.tools.every((tool) =>
        tool.licensePath === "licenses/age-LICENSE" && tool.licenseSha256 === licenseSha256
      )).toBe(true);
      expect(await readFile(join(root, "checksums.sha256"), "utf8"))
        .toContain(`${licenseSha256}  licenses/age-LICENSE`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the parser keeps a historical signed 0.2.0 three-executable manifest verifiable", async () => {
    const root = await verifiableFixture();
    try {
      const agePath = join(root, "runtime", "age");
      const keygenPath = join(root, "runtime", "age-keygen");
      await writeFile(agePath, `${await readFile(agePath, "utf8")}# signed age\n`);
      await writeFile(keygenPath, `${await readFile(keygenPath, "utf8")}# signed age-keygen\n`);
      const ageShipped = digest(await readFile(agePath));
      const keygenShipped = digest(await readFile(keygenPath));
      const codeSigning: HomeArtifactCodeSigning = Object.freeze({
        executables: Object.freeze([
          signedRow("runtime/age", PINNED_AGE_BINARY_SHA256, ageShipped, "A1B2C3D4E5", "1"),
          signedRow("runtime/age-keygen", PINNED_AGE_KEYGEN_BINARY_SHA256, keygenShipped, "A1B2C3D4E5", "2"),
          signedRow("runtime/bun", PINNED_BUN_BINARY_SHA256, PINNED_BUN_BINARY_SHA256, "7FRXF46ZSN", "3"),
        ]),
      });
      const written = await writeSignedArtifactMetadataForTests(root, "0.2.0", codeSigning);
      expect(written.product.version).toBe("0.2.0");
      expect(written.homeCredentials).toBeUndefined();
      expect(written.tools.find((tool) => tool.name === "age")?.sha256).toBe(ageShipped);
      expect(written.tools.find((tool) => tool.name === "age-keygen")?.sha256).toBe(keygenShipped);
      expect(ageShipped).not.toBe(PINNED_AGE_BINARY_SHA256);
      expect(keygenShipped).not.toBe(PINNED_AGE_KEYGEN_BINARY_SHA256);

      const raw: unknown = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
      const verified = verifyHomeArtifactToolChecksumMetadataForTests(raw);
      expect(verified.distribution.signed).toBeTrue();
      expect(verified.product.version).toBe("0.2.0");
      const corrupted = structuredClone(raw) as { tools: Array<{ name: string; sha256: string }> };
      corrupted.tools.find((tool) => tool.name === "age")!.sha256 = PINNED_AGE_BINARY_SHA256;
      expect(() => verifyHomeArtifactToolChecksumMetadataForTests(corrupted))
        .toThrow("artifact age checksum is missing or inconsistent");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function signedRow(
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

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dome-home-artifact-test-"));
  await mkdir(join(root, "bin"), { recursive: true });
  await mkdir(join(root, "app", "pwa", "dist"), { recursive: true });
  await writeFile(join(root, "bin", "dome"), "#!/bin/sh\n", { mode: 0o755 });
  await chmod(join(root, "bin", "dome"), 0o755);
  await writeFile(join(root, "app", "pwa", "dist", "index.html"), "<main>Dome</main>\n");
  return root;
}

async function verifiableFixture(): Promise<string> {
  const root = await fixture();
  await mkdir(join(root, "runtime"), { recursive: true });
  await writeFile(join(root, "runtime", "bun"), `#!/bin/sh\necho ${PINNED_BUN_VERSION}\n`, { mode: 0o755 });
  await chmod(join(root, "runtime", "bun"), 0o755);
  await writeFile(join(root, "runtime", "age"), `#!/bin/sh\necho v${PINNED_AGE_VERSION}\n`, { mode: 0o755 });
  await writeFile(join(root, "runtime", "age-keygen"), `#!/bin/sh\necho v${PINNED_AGE_VERSION}\n`, { mode: 0o755 });
  await chmod(join(root, "runtime", "age"), 0o755);
  await chmod(join(root, "runtime", "age-keygen"), 0o755);
  await mkdir(join(root, "licenses"), { recursive: true });
  await writeFile(join(root, "licenses", "age-LICENSE"), "fixture license\n");
  await writeArtifactMetadata(root, "1.0.0");
  return root;
}

function digest(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function rewriteTarType(tar: Buffer, headerOffset: number, type: string): void {
  tar[headerOffset + 156] = type.charCodeAt(0);
  rewriteTarChecksum(tar, headerOffset);
}

function rewriteTarLink(tar: Buffer, headerOffset: number, target: string, type = "2"): void {
  tar[headerOffset + 156] = type.charCodeAt(0);
  tar.fill(0, headerOffset + 157, headerOffset + 257);
  Buffer.from(target).copy(tar, headerOffset + 157);
  rewriteTarChecksum(tar, headerOffset);
}

function rewriteTarSize(tar: Buffer, headerOffset: number, size: number): void {
  tar.fill(0, headerOffset + 124, headerOffset + 136);
  Buffer.from(`${size.toString(8).padStart(11, "0")}\0`).copy(tar, headerOffset + 124);
  rewriteTarChecksum(tar, headerOffset);
}

function tarHeaderOffset(tar: Buffer, expectedPath: string): number {
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start: number, length: number) => {
      const field = header.subarray(start, start + length);
      const zero = field.indexOf(0);
      return field.subarray(0, zero < 0 ? field.length : zero).toString();
    };
    const name = text(0, 100);
    const prefix = text(345, 155);
    const path = prefix === "" ? name : `${prefix}/${name}`;
    if (path === expectedPath) return offset;
    const sizeText = text(124, 12).trim();
    const size = sizeText === "" ? 0 : Number.parseInt(sizeText, 8);
    offset += 512 + size + ((512 - (size % 512)) % 512);
  }
  throw new Error(`missing tar header ${expectedPath}`);
}

function rewriteTarName(tar: Buffer, headerOffset: number, name: string): void {
  tar.fill(0, headerOffset, headerOffset + 100);
  Buffer.from(name).copy(tar, headerOffset);
  rewriteTarChecksum(tar, headerOffset);
}

function rewriteTarChecksum(tar: Buffer, headerOffset: number): void {
  tar.fill(0x20, headerOffset + 148, headerOffset + 156);
  const checksum = tar.subarray(headerOffset, headerOffset + 512).reduce((sum, byte) => sum + byte, 0);
  Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `).copy(tar, headerOffset + 148);
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(stderr);
  return stdout;
}
