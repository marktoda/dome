import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create as createTar } from "tar";

import {
  assembleProductPackageForTests,
  runBoundedProductCommand,
  runProductPackageCommandForTests,
  type ProductPackageAssemblerDependencies,
} from "../../scripts/product-package/assembler";
import {
  PRODUCT_PACKAGE_CAPS,
  PRODUCT_PACKAGE_SCHEMA,
  validateProductPackageManifest,
} from "../../src/product-package/manifest";
import type { HomeArtifactManifest } from "../../src/product-host/home-artifact";
import { verifyPackedProductArchive } from "../../scripts/product-package/archive";

setDefaultTimeout(30_000);

describe("complete product package assembler", () => {
  test("stages tracked HEAD, one verified Home, and that Home's PWA into one closed tarball", async () => {
    const fixture = await repositoryFixture();
    const outputDir = join(fixture.temporary, "output");
    const events: string[] = [];
    try {
      const result = await assembleProductPackageForTests({
        repoRoot: fixture.repo,
        outputDir,
      }, dependencies(events));

      expect(result.evidence).toBeFalse();
      expect(events).toEqual(["build-home", "inspect-home", "dispose-home", "publish"]);
      expect(result.tarball).toBe(join(await realpath(outputDir), "marktoda-dome-0.4.0.tgz"));
      expect(result.manifest).toMatchObject({
        schema: PRODUCT_PACKAGE_SCHEMA,
        package: { name: "@marktoda/dome", version: "0.4.0", sourceCommit: fixture.head },
        platform: { os: "darwin", arch: "arm64" },
        home: {
          path: "product/home/dome-home-0.4.0-darwin-arm64.tar.gz",
          root: "dome-home-0.4.0-darwin-arm64",
          artifactId: "a".repeat(64),
          buildCommit: fixture.head,
        },
      });
      expect(result.manifest.pwa.entries.map((entry) => entry.path)).toEqual([
        "product/pwa/assets/app.js",
        "product/pwa/index.html",
      ]);
      expect(validateProductPackageManifest(result.manifest)).toBe(result.manifest);
      const listing = await command(["/usr/bin/tar", "-tzf", result.tarball], fixture.temporary);
      expect(listing).toContain("package/product/manifest.json");
      expect(listing).toContain("package/product/pwa/index.html");
      expect(listing).toContain("package/product/home/dome-home-0.4.0-darwin-arm64.tar.gz");
      const packedPackage = JSON.parse(await command([
        "/usr/bin/tar", "-xOzf", result.tarball, "package/package.json",
      ], fixture.temporary)) as Record<string, unknown>;
      expect(packedPackage).not.toHaveProperty("devDependencies");
      expect(packedPackage).not.toHaveProperty("scripts");
      expect(packedPackage["files"]).toContain("product/");
    } finally {
      await fixture.cleanup();
    }
  });

  test("refuses dirty, untracked, and tracked-symlink source input before Home build", async () => {
    for (const mutation of ["dirty", "untracked", "symlink"] as const) {
      const fixture = await repositoryFixture();
      const events: string[] = [];
      try {
        if (mutation === "dirty") await writeFile(join(fixture.repo, "README.md"), "dirty\n");
        if (mutation === "untracked") await writeFile(join(fixture.repo, "scratch.txt"), "scratch\n");
        if (mutation === "symlink") {
          await symlink("index.ts", join(fixture.repo, "src", "linked.ts"));
          await git(fixture.repo, ["add", "src/linked.ts"]);
          await git(fixture.repo, ["commit", "-m", "track symlink"]);
        }
        await expect(assembleProductPackageForTests({
          repoRoot: fixture.repo,
          outputDir: join(fixture.temporary, "output"),
        }, dependencies(events))).rejects.toThrow();
        expect(events, mutation).toEqual([]);
      } finally {
        await fixture.cleanup();
      }
    }
  });

  test("excludes ignored secrets but rejects selected secret paths and high-confidence secret content", async () => {
    const ignored = await repositoryFixture();
    try {
      await writeFile(join(ignored.repo, ".env"), "ANTHROPIC_API_KEY=owner-secret\n");
      const result = await assembleProductPackageForTests({
        repoRoot: ignored.repo,
        outputDir: join(ignored.temporary, "output"),
      }, dependencies([]));
      expect(result.manifest.files.some((entry) => entry.path.includes(".env"))).toBeFalse();
    } finally {
      await ignored.cleanup();
    }

    for (const mutation of ["secret-path", "secret-content"] as const) {
      const fixture = await repositoryFixture();
      const events: string[] = [];
      try {
        const path = mutation === "secret-path" ? "src/signing.pem" : "src/leak.ts";
        const body = mutation === "secret-path"
          ? "not even secret\n"
          : "export const leak = `-----BEGIN PRIVATE KEY-----\\nowner-secret\\n`;\n";
        await writeFile(join(fixture.repo, path), body);
        await git(fixture.repo, ["add", path]);
        await git(fixture.repo, ["commit", "-m", mutation]);
        await expect(assembleProductPackageForTests({
          repoRoot: fixture.repo,
          outputDir: join(fixture.temporary, "output"),
        }, dependencies(events))).rejects.toThrow(mutation === "secret-path" ? "secret path" : "secret marker");
        expect(events).toEqual([]);
      } finally {
        await fixture.cleanup();
      }
    }
  });

  test("stages captured Git blobs directly despite export-ignore and export-subst attributes", async () => {
    const fixture = await repositoryFixture();
    try {
      await writeFile(join(fixture.repo, ".gitattributes"), "README.md export-ignore\nsrc/index.ts export-subst\n");
      await writeFile(join(fixture.repo, "src", "index.ts"), "export const commit = '$Format:%H$';\n");
      await git(fixture.repo, ["add", ".gitattributes", "src/index.ts"]);
      await git(fixture.repo, ["commit", "-m", "attributes"]);
      const result = await assembleProductPackageForTests({
        repoRoot: fixture.repo,
        outputDir: join(fixture.temporary, "output"),
      }, dependencies([]));
      expect(await command(["/usr/bin/tar", "-xOzf", result.tarball, "package/README.md"], fixture.temporary))
        .toBe("# Dome\n");
      expect(await command(["/usr/bin/tar", "-xOzf", result.tarball, "package/src/index.ts"], fixture.temporary))
        .toContain("$Format:%H$");
    } finally {
      await fixture.cleanup();
    }
  });

  test("rejects oversized selected blobs and lifecycle hooks before Home build", async () => {
    for (const mutation of ["oversized", "postinstall"] as const) {
      const fixture = await repositoryFixture();
      const events: string[] = [];
      try {
        if (mutation === "oversized") {
          await writeFile(join(fixture.repo, "src", "oversized.bin"), Buffer.alloc(PRODUCT_PACKAGE_CAPS.sourceFileBytes + 1));
          await git(fixture.repo, ["add", "src/oversized.bin"]);
        } else {
          const path = join(fixture.repo, "package.json");
          const pkg = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
          pkg["scripts"] = { postinstall: "touch owner-machine" };
          await writeFile(path, `${JSON.stringify(pkg, null, 2)}\n`);
          await git(fixture.repo, ["add", "package.json"]);
        }
        await git(fixture.repo, ["commit", "-m", mutation]);
        await expect(assembleProductPackageForTests({
          repoRoot: fixture.repo, outputDir: join(fixture.temporary, "output"),
        }, dependencies(events))).rejects.toThrow(mutation === "oversized" ? "per-file byte budget" : "lifecycle hook");
        expect(events).toEqual([]);
      } finally {
        await fixture.cleanup();
      }
    }
  });

  test("bounded subprocesses kill and drain on timeout", async () => {
    const fixture = await repositoryFixture();
    try {
      await expect(runProductPackageCommandForTests([
        process.execPath, "-e", "setInterval(() => {}, 1000)",
      ], fixture.repo, 20)).rejects.toThrow("timed out");
    } finally {
      await fixture.cleanup();
    }
  });

  test("bounded subprocesses terminate a trapping descendant and close inherited pipes", async () => {
    const fixture = await repositoryFixture();
    const pidPath = join(fixture.temporary, "descendant.pid");
    let ownedPids: number[] = [];
    const program = [
      `const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify("process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)")}], { stdout: "inherit", stderr: "inherit" });`,
      `await Bun.write(${JSON.stringify(pidPath)}, JSON.stringify([process.pid, child.pid]));`,
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1_000);",
    ].join("\n");
    try {
      const startedAt = Date.now();
      await expect(runProductPackageCommandForTests([
        process.execPath, "-e", program,
      ], fixture.repo, 50)).rejects.toThrow("timed out");
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(existsSync(pidPath)).toBeTrue();
      ownedPids = JSON.parse(await readFile(pidPath, "utf8")) as number[];
      expect(ownedPids).toHaveLength(2);
      for (const pid of ownedPids) {
        expect(Number.isInteger(pid)).toBeTrue();
        let alive = true;
        for (let attempt = 0; attempt < 40 && alive; attempt += 1) {
          try {
            process.kill(pid, 0);
            await Bun.sleep(25);
          } catch {
            alive = false;
          }
        }
        expect(alive).toBeFalse();
      }
    } finally {
      for (const pid of ownedPids) try { process.kill(pid, "SIGKILL"); } catch {}
      await fixture.cleanup();
    }
  });

  test("bounded subprocess input is synchronously snapshotted and rejects proxies or accessors", async () => {
    const fixture = await repositoryFixture();
    let traps = 0;
    const command = new Proxy([process.execPath, "-e", "process.exit(0)"], {
      get() { traps += 1; throw new Error("command trap executed"); },
    });
    try {
      await expect(runBoundedProductCommand(command, fixture.repo, {
        timeoutMs: 1_000,
        maxStdoutBytes: 1_024,
        maxStderrBytes: 1_024,
      })).rejects.toThrow("argv is invalid");
      expect(traps).toBe(0);

      const accessorOptions = {} as Record<string, unknown>;
      Object.defineProperty(accessorOptions, "timeoutMs", { enumerable: true, get: () => 1_000 });
      Object.defineProperty(accessorOptions, "maxStdoutBytes", { enumerable: true, value: 1_024 });
      Object.defineProperty(accessorOptions, "maxStderrBytes", { enumerable: true, value: 1_024 });
      await expect(runBoundedProductCommand(
        [process.execPath, "-e", "process.exit(0)"],
        fixture.repo,
        accessorOptions as never,
      )).rejects.toThrow("options are invalid");

      const hostileEnvironment = new Proxy({}, { ownKeys() { traps += 1; throw new Error("env trap executed"); } });
      await expect(runBoundedProductCommand([process.execPath, "-e", "process.exit(0)"], fixture.repo, {
        timeoutMs: 1_000,
        maxStdoutBytes: 1_024,
        maxStderrBytes: 1_024,
        env: hostileEnvironment as Record<string, string>,
      })).rejects.toThrow("environment is invalid");
      expect(traps).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  test("bounded subprocesses retain immutable argv and environment snapshots after spawn", async () => {
    const fixture = await repositoryFixture();
    const command = [
      process.execPath,
      "-e",
      "await Bun.sleep(20); process.stdout.write(`${process.env.DOME_RELEASE_SNAPSHOT}:${process.env.__proto__}`)",
    ];
    const env = { ...process.env, DOME_RELEASE_SNAPSHOT: "captured" } as Record<string, string>;
    Object.defineProperty(env, "__proto__", {
      value: "literal-env-entry", enumerable: true, configurable: true, writable: true,
    });
    try {
      const pending = runBoundedProductCommand(command, fixture.repo, {
        timeoutMs: 1_000,
        maxStdoutBytes: 1_024,
        maxStderrBytes: 1_024,
        env,
      });
      command[0] = "mutated-owner-path";
      env.DOME_RELEASE_SNAPSHOT = "mutated";
      expect((await pending).stdout.toString("utf8")).toBe("captured:literal-env-entry");
    } finally {
      await fixture.cleanup();
    }
  });

  test("output overflow kills and drains the direct child and its inherited-pipe descendant", async () => {
    const fixture = await repositoryFixture();
    const pidPath = join(fixture.temporary, "overflow-pids.json");
    let ownedPids: number[] = [];
    const program = [
      `const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify("setInterval(() => {}, 1_000)")}], { stdout: "inherit", stderr: "inherit" });`,
      `await Bun.write(${JSON.stringify(pidPath)}, JSON.stringify([process.pid, child.pid]));`,
      `process.stdout.write("x".repeat(2_048));`,
      "setInterval(() => {}, 1_000);",
    ].join("\n");
    try {
      await expect(runBoundedProductCommand([process.execPath, "-e", program], fixture.repo, {
        timeoutMs: 1_000,
        maxStdoutBytes: 1_024,
        maxStderrBytes: 1_024,
      })).rejects.toThrow("stdout exceeded its byte budget");
      ownedPids = JSON.parse(await readFile(pidPath, "utf8")) as number[];
      for (const pid of ownedPids) {
        let alive = true;
        for (let attempt = 0; attempt < 40 && alive; attempt += 1) {
          try { process.kill(pid, 0); await Bun.sleep(25); }
          catch { alive = false; }
        }
        expect(alive).toBeFalse();
      }
    } finally {
      for (const pid of ownedPids) try { process.kill(pid, "SIGKILL"); } catch {}
      await fixture.cleanup();
    }
  });

  test("nonzero direct exit promptly kills a descendant holding inherited pipes", async () => {
    const fixture = await repositoryFixture();
    const pidPath = join(fixture.temporary, "nonzero-pids.json");
    let ownedPids: number[] = [];
    const program = [
      `const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify("setInterval(() => {}, 1_000)")}], { stdout: "inherit", stderr: "inherit" });`,
      `await Bun.write(${JSON.stringify(pidPath)}, JSON.stringify([process.pid, child.pid]));`,
      "process.exit(7);",
    ].join("\n");
    try {
      const startedAt = Date.now();
      let failure: unknown;
      try {
        await runBoundedProductCommand([process.execPath, "-e", program], fixture.repo, {
          timeoutMs: 2_000,
          maxStdoutBytes: 1_024,
          maxStderrBytes: 1_024,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(`${process.execPath} failed (7): `);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      ownedPids = JSON.parse(await readFile(pidPath, "utf8")) as number[];
      for (const pid of ownedPids) {
        let alive = true;
        for (let attempt = 0; attempt < 40 && alive; attempt += 1) {
          try { process.kill(pid, 0); await Bun.sleep(25); }
          catch { alive = false; }
        }
        expect(alive).toBeFalse(); // Neither the direct Bun nor its Bun descendant may linger.
      }
    } finally {
      for (const pid of ownedPids) try { process.kill(pid, "SIGKILL"); } catch {}
      await fixture.cleanup();
    }
  });

  test("proxied abort signals are rejected without executing traps", async () => {
    const fixture = await repositoryFixture();
    let traps = 0;
    const signal = new Proxy(new AbortController().signal, {
      getPrototypeOf() { traps += 1; throw new Error("signal trap executed"); },
    });
    try {
      await expect(runBoundedProductCommand([process.execPath, "-e", "process.exit(0)"], fixture.repo, {
        timeoutMs: 1_000,
        maxStdoutBytes: 1_024,
        maxStderrBytes: 1_024,
        signal,
      })).rejects.toThrow("signal is invalid");
      expect(traps).toBe(0);
      await expect(runBoundedProductCommand([process.execPath, "-e", "process.exit(0)"], fixture.repo, {
        timeoutMs: 1_000,
        maxStdoutBytes: 1_024,
        maxStderrBytes: 1_024,
        signal: Object.create(AbortSignal.prototype) as AbortSignal,
      })).rejects.toThrow("signal is invalid");
    } finally {
      await fixture.cleanup();
    }
  });

  test("genuine abort signal own accessors cannot affect a successful command", async () => {
    const fixture = await repositoryFixture();
    const controller = new AbortController();
    const accesses: string[] = [];
    poisonAbortSignalSurface(controller.signal, (name) => { accesses.push(name); });
    try {
      const result = await runBoundedProductCommand(
        [process.execPath, "-e", "await Bun.sleep(20); process.stdout.write('ok')"],
        fixture.repo,
        {
          timeoutMs: 1_000,
          maxStdoutBytes: 1_024,
          maxStderrBytes: 1_024,
          signal: controller.signal,
        },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString("utf8")).toBe("ok");
      expect(accesses).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  test("mid-flight abort signal mutation cannot mask a command failure", async () => {
    const fixture = await repositoryFixture();
    const controller = new AbortController();
    const accesses: string[] = [];
    try {
      const pending = runBoundedProductCommand(
        [process.execPath, "-e", "await Bun.sleep(30); process.stderr.write('expected'); process.exit(9)"],
        fixture.repo,
        {
          timeoutMs: 1_000,
          maxStdoutBytes: 1_024,
          maxStderrBytes: 1_024,
          signal: controller.signal,
        },
      );
      poisonAbortSignalSurface(controller.signal, (name) => { accesses.push(name); });
      let failure: unknown;
      try { await pending; } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(`${process.execPath} failed (9): expected`);
      expect(accesses).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  test("mid-flight abort signal mutation preserves abort and process cleanup", async () => {
    const fixture = await repositoryFixture();
    const controller = new AbortController();
    const accesses: string[] = [];
    const pidPath = join(fixture.temporary, "abort-mutation.pid");
    let ownedPid: number | undefined;
    try {
      const pending = runBoundedProductCommand(
        [process.execPath, "-e", `await Bun.write(${JSON.stringify(pidPath)}, String(process.pid)); await Bun.sleep(10_000)`],
        fixture.repo,
        {
          timeoutMs: 2_000,
          maxStdoutBytes: 1_024,
          maxStderrBytes: 1_024,
          signal: controller.signal,
        },
      );
      for (let attempt = 0; attempt < 40 && !existsSync(pidPath); attempt += 1) await Bun.sleep(25);
      expect(existsSync(pidPath)).toBeTrue();
      ownedPid = Number.parseInt(await readFile(pidPath, "utf8"), 10);
      poisonAbortSignalSurface(controller.signal, (name) => { accesses.push(name); });
      controller.abort();
      let failure: unknown;
      try { await pending; } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(`${process.execPath} was aborted`);
      expect(accesses).toEqual([]);
      let alive = true;
      for (let attempt = 0; attempt < 40 && alive; attempt += 1) {
        try { process.kill(ownedPid, 0); await Bun.sleep(25); }
        catch { alive = false; }
      }
      expect(alive).toBeFalse();
    } finally {
      if (ownedPid !== undefined) try { process.kill(ownedPid, "SIGKILL"); } catch {}
      await fixture.cleanup();
    }
  });

  test("the package archive seam rejects same-size content drift and special mode bits", async () => {
    const fixture = await repositoryFixture();
    const root = join(fixture.temporary, "tar-input");
    const archive = join(fixture.temporary, "candidate.tgz");
    try {
      await mkdir(root);
      const file = join(root, "a.txt");
      await writeFile(file, "alpha", { mode: 0o644 });
      const expected = [{ path: "a.txt", bytes: 5, sha256: sha256(Buffer.from("alpha")), mode: "0644" as const }];
      await createTar({ cwd: root, file: archive, gzip: true, portable: true, prefix: "package" }, ["a.txt"]);
      await verifyPackedProductArchive({ archive, compressedBytes: (await lstat(archive)).size, expected });

      await writeFile(file, "bravo", { mode: 0o644 });
      await rm(archive);
      await createTar({ cwd: root, file: archive, gzip: true, portable: true, prefix: "package" }, ["a.txt"]);
      await expect(verifyPackedProductArchive({
        archive, compressedBytes: (await lstat(archive)).size, expected,
      })).rejects.toThrow("content differs");

      await writeFile(file, "alpha", { mode: 0o644 });
      await chmod(file, 0o4644);
      await rm(archive);
      await createTar({
        cwd: root,
        file: archive,
        gzip: true,
        portable: false,
        prefix: "package",
        onWriteEntry: (entry) => {
          if (entry.stat === undefined) throw new Error("tar fixture entry has no stat evidence");
          entry.stat.mode = 0o104644;
        },
      }, ["a.txt"]);
      await expect(verifyPackedProductArchive({
        archive, compressedBytes: (await lstat(archive)).size, expected,
      })).rejects.toThrow("mode differs");
    } finally {
      await fixture.cleanup();
    }
  });

  test("refuses HEAD movement after the single Home build and publishes no output", async () => {
    const fixture = await repositoryFixture();
    const events: string[] = [];
    const base = dependencies(events);
    try {
      await expect(assembleProductPackageForTests({
        repoRoot: fixture.repo,
        outputDir: join(fixture.temporary, "output"),
      }, {
        ...base,
        buildHome: async (input) => {
          const built = await base.buildHome(input);
          await writeFile(join(fixture.repo, "README.md"), "new commit\n");
          await git(fixture.repo, ["add", "README.md"]);
          await git(fixture.repo, ["commit", "-m", "move head"]);
          return built;
        },
      })).rejects.toThrow("source HEAD changed");
      expect(events).toEqual(["build-home", "inspect-home", "dispose-home"]);
    } finally {
      await fixture.cleanup();
    }
  });

  test("binds Home and copied PWA provenance to the captured source commit and verified inventory", async () => {
    for (const mutation of ["home-commit", "pwa-content", "pwa-extra", "source-stage"] as const) {
      const fixture = await repositoryFixture();
      const events: string[] = [];
      const base = dependencies(events);
      try {
        const deps: ProductPackageAssemblerDependencies = mutation === "source-stage" ? {
          ...base,
          buildHome: async (input) => {
            const result = await base.buildHome(input);
            await writeFile(join(input.outputDir, "..", "stage", "README.md"), "mutated stage\n");
            return result;
          },
        } : {
          ...base,
          inspectHome: async (input) => {
            const inspected = await base.inspectHome(input);
            if (mutation === "home-commit") {
              return Object.freeze({
                ...inspected,
                manifest: { ...inspected.manifest, build: { gitCommit: "f".repeat(40) } },
              });
            }
            if (mutation === "pwa-content") {
              await writeFile(join(inspected.root, "app", "pwa", "dist", "index.html"), "<main>Drift</main>\n");
            }
            if (mutation === "pwa-extra") {
              await writeFile(join(inspected.root, "app", "pwa", "dist", "extra.js"), "extra\n");
            }
            return inspected;
          },
        };
        await expect(assembleProductPackageForTests({
          repoRoot: fixture.repo, outputDir: join(fixture.temporary, "output"),
        }, deps)).rejects.toThrow(
          mutation === "home-commit" ? "Home identity" :
            mutation === "source-stage" ? "normalized package source changed" : "copied PWA differs",
        );
      } finally {
        await fixture.cleanup();
      }
    }
  });

  test("preserves Home/PWA failure together with materialization disposal failure", async () => {
    const fixture = await repositoryFixture();
    const base = dependencies([]);
    try {
      let caught: unknown;
      try {
        await assembleProductPackageForTests({
          repoRoot: fixture.repo, outputDir: join(fixture.temporary, "output"),
        }, {
          ...base,
          inspectHome: async (input) => {
            const inspected = await base.inspectHome(input);
            await writeFile(join(inspected.root, "app", "pwa", "dist", "extra.js"), "extra\n");
            return Object.freeze({ ...inspected, dispose: async () => { throw new Error("dispose failed"); } });
          },
        });
      } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(AggregateError);
      expect((caught as AggregateError).errors.map(String).join(" ")).toContain("copied PWA differs");
      expect((caught as AggregateError).errors.map(String).join(" ")).toContain("dispose failed");
    } finally {
      await fixture.cleanup();
    }
  });

  test("manifest validation rejects extras, absolute paths, duplicates, and Home identity drift", async () => {
    const fixture = await repositoryFixture();
    try {
      const result = await assembleProductPackageForTests({
        repoRoot: fixture.repo,
        outputDir: join(fixture.temporary, "output"),
      }, dependencies([]));
      expect(() => validateProductPackageManifest({ ...result.manifest, extra: true }))
        .toThrow("unknown or missing fields");
      expect(() => validateProductPackageManifest({
        ...result.manifest,
        files: [result.manifest.files[0]!, result.manifest.files[0]!],
      })).toThrow("duplicate");
      expect(() => validateProductPackageManifest({
        ...result.manifest,
        files: [{ ...result.manifest.files[0]!, path: "/absolute" }, ...result.manifest.files.slice(1)],
      })).toThrow("unsafe path");
      expect(() => validateProductPackageManifest({
        ...result.manifest,
        home: { ...result.manifest.home, root: "different" },
      })).toThrow("Home identity");
      expect(() => validateProductPackageManifest({
        ...result.manifest,
        files: result.manifest.files.filter((entry) => entry.path !== "src/index.ts"),
      })).toThrow("missing src/index.ts");
      expect(() => validateProductPackageManifest({
        ...result.manifest,
        files: [...result.manifest.files, {
          path: "product/unexpected.txt", bytes: 1, sha256: "c".repeat(64), mode: "0644" as const,
        }].sort((left, right) => left.path < right.path ? -1 : 1),
      })).toThrow("unexpected generated product path");
      const withoutIndex = result.manifest.pwa.entries.filter((entry) => entry.path !== "product/pwa/index.html");
      expect(() => validateProductPackageManifest({
        ...result.manifest,
        pwa: { ...result.manifest.pwa, entries: withoutIndex },
        files: result.manifest.files.filter((entry) => entry.path !== "product/pwa/index.html"),
      })).toThrow("PWA inventory");
      expect(() => validateProductPackageManifest({
        ...result.manifest,
        files: result.manifest.files.map((entry) =>
          entry.path === "bin/dome" ? { ...entry, mode: "0644" as const } : entry),
      })).toThrow("bin/dome is not executable");
      const oversizedHome = PRODUCT_PACKAGE_CAPS.packedBytes + 1;
      expect(() => validateProductPackageManifest({
        ...result.manifest,
        home: { ...result.manifest.home, bytes: oversizedHome },
        files: result.manifest.files.map((entry) =>
          entry.path === result.manifest.home.path ? { ...entry, bytes: oversizedHome } : entry),
      })).toThrow("Home identity");
    } finally {
      await fixture.cleanup();
    }
  });

  test("the release-capable adapter is hardwired to real Home build, verification, and publication", async () => {
    const source = await readFile(join(import.meta.dir, "..", "..", "scripts", "product-package.ts"), "utf8");
    expect(source).toContain("buildHomeArtifact({");
    expect(source).toContain("materializeHomeArtifactArchive(archiveInput)");
    expect(source).toContain("publishDirectoryExclusive({ source, target })");
    expect(source).not.toContain("dependencies:");
  });
});

function dependencies(events: string[]): ProductPackageAssemblerDependencies {
  let manifest: HomeArtifactManifest | undefined;
  return Object.freeze({
    buildHome: async ({ repoRoot, outputDir }) => {
      events.push("build-home");
      manifest = homeManifest((await git(repoRoot, ["rev-parse", "HEAD"])).trim());
      await mkdir(outputDir);
      const archive = join(outputDir, "dome-home-0.4.0-darwin-arm64.tar.gz");
      await writeFile(archive, "verified Home archive\n");
      return Object.freeze({ archive, archiveSha256: sha256(Buffer.from("verified Home archive\n")), manifest });
    },
    inspectHome: async ({ archive, expected }) => {
      events.push("inspect-home");
      if (manifest === undefined) throw new Error("fake Home was not built");
      expect(expected).toEqual({
        compressedSha256: sha256(Buffer.from("verified Home archive\n")),
        artifactId: "a".repeat(64),
        productVersion: "0.4.0",
      });
      const root = join(archive, "..", "dome-home-0.4.0-darwin-arm64");
      await mkdir(join(root, "app", "pwa", "dist", "assets"), { recursive: true });
      await writeFile(join(root, "app", "pwa", "dist", "index.html"), "<main>Dome</main>\n");
      await writeFile(join(root, "app", "pwa", "dist", "assets", "app.js"), "console.log('Dome')\n");
      return Object.freeze({
        root,
        manifest,
        archiveBytes: Buffer.byteLength("verified Home archive\n"),
        archiveSha256: expected.compressedSha256,
        manifestSha256: "b".repeat(64),
        dispose: async () => { events.push("dispose-home"); await rm(root, { recursive: true, force: true }); },
      });
    },
    publish: async ({ source, target }) => { events.push("publish"); await rename(source, target); },
  });
}

async function repositoryFixture(): Promise<Readonly<{
  temporary: string;
  repo: string;
  head: string;
  cleanup(): Promise<void>;
}>> {
  const temporary = await mkdtemp(join(tmpdir(), "dome-product-package-test-"));
  const repo = join(temporary, "repo");
  await mkdir(repo);
  const files: ReadonlyArray<readonly [string, string, number?]> = [
    ["src/index.ts", "export const dome = true;\n"],
    ["contracts/agent-stream.ts", "export {};\n"],
    ["contracts/capture.ts", "export {};\n"],
    ["contracts/product-readiness.ts", "export {};\n"],
    ["contracts/source-document.ts", "export {};\n"],
    ["contracts/task-backlog.ts", "export {};\n"],
    ["contracts/task-backlog-review.ts", "export {};\n"],
    ["assets/extensions/dome.markdown/manifest.yaml", "id: dome.markdown\n"],
    ["assets/model-providers/anthropic.ts", "export {};\n"],
    ["assets/source-handlers/claude-slack.sh", "#!/bin/sh\n", 0o755],
    ["bin/dome", "#!/usr/bin/env bun\n", 0o755],
    ["LICENSE", "MIT License\n"],
    ["README.md", "# Dome\n"],
    [".gitignore", ".env\n"],
  ];
  for (const [path, body, mode] of files) {
    const absolute = join(repo, ...path.split("/"));
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, body, { mode: mode ?? 0o644 });
    if (mode !== undefined) await chmod(absolute, mode);
  }
  await writeFile(join(repo, "package.json"), `${JSON.stringify({
    name: "@marktoda/dome",
    version: "0.4.0",
    type: "module",
    files: [
      "src/", "contracts/agent-stream.ts", "contracts/capture.ts", "contracts/product-readiness.ts",
      "contracts/source-document.ts", "contracts/task-backlog.ts", "contracts/task-backlog-review.ts",
      "assets/extensions/", "assets/model-providers/", "assets/source-handlers/", "bin/dome", "LICENSE",
      "README.md", "product/",
    ],
    bin: { dome: "bin/dome" },
    devDependencies: { typescript: "latest" },
  }, null, 2)}\n`);
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.email", "dome@example.test"]);
  await git(repo, ["config", "user.name", "Dome Test"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "fixture"]);
  const head = (await git(repo, ["rev-parse", "HEAD"])).trim();
  return Object.freeze({
    temporary,
    repo,
    head,
    cleanup: async () => { await rm(temporary, { recursive: true, force: true }); },
  });
}

function homeManifest(sourceCommit: string): HomeArtifactManifest {
  return {
    product: { name: "Dome Home", version: "0.4.0" },
    target: { os: "darwin", arch: "arm64" },
    build: { gitCommit: sourceCommit },
    artifact: { id: "a".repeat(64) },
    pwa: "app/pwa/dist",
    entries: [
      {
        type: "file",
        path: "app/pwa/dist/assets/app.js",
        bytes: Buffer.byteLength("console.log('Dome')\n"),
        sha256: sha256(Buffer.from("console.log('Dome')\n")),
        mode: "0644",
      },
      {
        type: "file",
        path: "app/pwa/dist/index.html",
        bytes: Buffer.byteLength("<main>Dome</main>\n"),
        sha256: sha256(Buffer.from("<main>Dome</main>\n")),
        mode: "0644",
      },
    ],
  } as unknown as HomeArtifactManifest;
}

async function git(cwd: string, args: string[]): Promise<string> {
  return await command(["git", ...args], cwd);
}

function poisonAbortSignalSurface(signal: AbortSignal, onAccess: (name: string) => void): void {
  for (const name of ["aborted", "addEventListener", "removeEventListener"]) {
    Object.defineProperty(signal, name, {
      configurable: true,
      get() {
        onAccess(name);
        throw new Error(`caller-owned ${name} accessor executed`);
      },
    });
  }
}

async function command(argv: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${argv[0]} failed: ${stderr}`);
  return stdout;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
