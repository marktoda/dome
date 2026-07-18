#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, readdir, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

import type { InstalledProductEvidence } from "../src/product-package/installed-product";
import { PRODUCT_PACKAGE_CAPS } from "../src/product-package/manifest";
import { assembleCompleteProductPackage } from "./product-package";
import {
  runBoundedProductCommand,
  type ProductPackageCommandResult,
} from "./product-package/assembler";
import { RELEASE_PACKAGE_NAME, validatePackResult, validateReleasePackageManifest } from "./release-package";
import {
  verifyInstalledConsumerWorkflow,
  type InstalledConsumerEvidence,
} from "./installed-consumer-rehearsal";
import {
  formatReleaseProgress,
  runReleasePhase,
  type ReleaseProgressReporter,
} from "./release-progress";

const REPO_ROOT = resolve(import.meta.dir, "..");
const EXPORTS = Object.freeze([RELEASE_PACKAGE_NAME, `${RELEASE_PACKAGE_NAME}/cli`, `${RELEASE_PACKAGE_NAME}/mcp`]);

/** npm owns package installation; the installed executable continues to run on Bun. */
export const PACKED_PRODUCT_GLOBAL_INSTALL_CONTRACT = Object.freeze({
  installer: "npm" as const,
  runtime: "bun" as const,
  isolatedPrefix: true as const,
  isolatedCache: true as const,
  productionOnly: true as const,
  lifecycleScripts: false as const,
  binTargetMode: "0755" as const,
});

export function buildPackedProductGlobalInstallCommand(input: Readonly<{
  npmExecutable: string;
  tarball: string;
  prefix: string;
  cache: string;
}>): ReadonlyArray<string> {
  if (![input.npmExecutable, input.tarball, input.prefix, input.cache].every(isAbsolute) ||
    !["npm", "npm.cmd"].includes(basename(input.npmExecutable))) {
    throw new Error("packed-product global install paths are invalid");
  }
  return Object.freeze([
    input.npmExecutable, "install", "--global", input.tarball,
    "--prefix", input.prefix,
    "--cache", input.cache,
    "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund",
    "--registry=https://registry.npmjs.org",
  ]);
}

export function packedProductGlobalInstallLayout(prefix: string): Readonly<{
  modulesRoot: string;
  packageRoot: string;
  binRoot: string;
  domeBin: string;
}> {
  if (!isAbsolute(prefix)) throw new Error("packed-product global install prefix is invalid");
  const modulesRoot = join(prefix, "lib", "node_modules");
  const binRoot = join(prefix, "bin");
  return Object.freeze({
    modulesRoot,
    packageRoot: join(modulesRoot, "@marktoda", "dome"),
    binRoot,
    domeBin: join(binRoot, "dome"),
  });
}

/** Create one ordinary offline consumer resolver without mutating the global package. */
export async function preparePackedProductConsumerWorkspace(input: Readonly<{
  prefix: string;
  installedRoot: string;
  workspace: string;
}>): Promise<Readonly<{ root: string; packageLink: string }>> {
  const prefix = resolve(input.prefix);
  const installedRoot = resolve(input.installedRoot);
  const workspace = resolve(input.workspace);
  if (![input.prefix, input.installedRoot, input.workspace].every(isAbsolute) ||
    await realpath(prefix) !== prefix || await realpath(installedRoot) !== installedRoot ||
    !contains(prefix, installedRoot) || !contains(prefix, workspace) || workspace === prefix ||
    contains(installedRoot, workspace) || contains(workspace, installedRoot)) {
    throw new Error("packed-product consumer workspace ownership is invalid");
  }
  const parent = dirname(workspace);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (await realpath(parent) !== parent) throw new Error("packed-product consumer workspace parent is aliased");
  await assertAbsent(workspace, "offline consumer workspace");
  await mkdir(workspace, { mode: 0o700 });
  const nodeModules = join(workspace, "node_modules");
  const packageLink = join(nodeModules, ...RELEASE_PACKAGE_NAME.split("/"));
  await mkdir(nodeModules, { mode: 0o700 });
  await mkdir(dirname(packageLink), { mode: 0o700 });
  await symlink(installedRoot, packageLink, "dir");
  const link = await lstat(packageLink);
  if (!link.isSymbolicLink() || !contains(workspace, packageLink) ||
    await realpath(packageLink) !== installedRoot) {
    throw new Error("packed-product consumer package link is invalid");
  }
  return Object.freeze({ root: workspace, packageLink });
}

export type PortablePackedProductReport = Readonly<{
  evidence: false;
  repositoryUnavailable: true;
  exports: ReadonlyArray<string>;
  cliHelp: true;
  product: InstalledProductEvidence;
  scaffold: InstalledConsumerEvidence["scaffold"];
  currentSchemaReopen: InstalledConsumerEvidence["currentSchemaReopen"];
}>;

export type PackedProductReport = Omit<PortablePackedProductReport, "evidence"> & Readonly<{
  schema: "dome.packed-product-rehearsal/v3";
  evidence: "complete-packed-product";
  artifact: Readonly<{
    filename: "marktoda-dome-0.4.0.tgz";
    sha256: string;
    sourceCommit: string;
    entries: number;
    packedBytes: number;
    unpackedBytes: number;
  }>;
  globalInstall: typeof PACKED_PRODUCT_GLOBAL_INSTALL_CONTRACT;
}>;

export type PackedProductAcceptanceDependencies = Readonly<{
  install(): Promise<void>;
  retireInputs(): Promise<void>;
  assertInputsUnavailable(): Promise<void>;
  verifyInstalled(): Promise<InstalledProductEvidence>;
  verifyExports(): Promise<ReadonlyArray<string>>;
  verifyCli(): Promise<void>;
  verifyConsumer(): Promise<InstalledConsumerEvidence>;
}>;

/** Portable ordering seam. It can exercise refusal behavior but never issue release evidence. */
export async function runPackedProductAcceptanceForTests(
  dependencies: PackedProductAcceptanceDependencies,
): Promise<PortablePackedProductReport> {
  await dependencies.install();
  await dependencies.retireInputs();
  await dependencies.assertInputsUnavailable();
  const product = await dependencies.verifyInstalled();
  const exports = await dependencies.verifyExports();
  if (JSON.stringify(exports) !== JSON.stringify(EXPORTS)) throw new Error("installed package exports differ from the declared contract");
  await dependencies.verifyCli();
  const consumer = await dependencies.verifyConsumer();
  return Object.freeze({
    evidence: false as const,
    repositoryUnavailable: true as const,
    exports: Object.freeze([...exports]),
    cliHelp: true as const,
    product,
    scaffold: consumer.scaffold,
    currentSchemaReopen: consumer.currentSchemaReopen,
  });
}

/** Hardwired release rehearsal: exact package build, isolated global install, then source-free proof. */
export async function rehearsePackedProduct(input: Readonly<{
  repoRoot?: string;
  reportProgress?: ReleaseProgressReporter;
}> = {}): Promise<PackedProductReport> {
  const report = input.reportProgress;
  const repoRoot = await realpath(resolve(input.repoRoot ?? REPO_ROOT));
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "dome-packed-product-v3-")));
  let primary: unknown;
  try {
    const producer = join(temporary, "producer");
    const productOutput = join(temporary, "complete-product");
    const prefix = join(temporary, "prefix");
    const globalLayout = packedProductGlobalInstallLayout(prefix);
    const installCache = join(prefix, "cache");
    const home = join(prefix, "home");
    const probe = join(prefix, "probe");
    const xdgCache = join(prefix, "xdg-cache");
    const xdgConfig = join(prefix, "xdg-config");
    const xdgData = join(prefix, "xdg-data");
    const producerCache = join(temporary, "producer-cache");
    const producerHome = join(temporary, "producer-home");
    const npmExecutable = Bun.which("npm");
    if (npmExecutable === null) throw new Error("npm is required to rehearse the safe global package installation");
    await Promise.all([
      mkdir(globalLayout.binRoot, { recursive: true, mode: 0o700 }),
      mkdir(installCache, { recursive: true, mode: 0o700 }),
      mkdir(home, { recursive: true, mode: 0o700 }),
      mkdir(probe, { recursive: true, mode: 0o700 }),
      mkdir(xdgCache, { recursive: true, mode: 0o700 }),
      mkdir(xdgConfig, { recursive: true, mode: 0o700 }),
      mkdir(xdgData, { recursive: true, mode: 0o700 }),
      mkdir(producerCache, { recursive: true, mode: 0o700 }),
      mkdir(producerHome, { recursive: true, mode: 0o700 }),
    ]);

    const sourceCommit = await runReleasePhase("source-preflight", report, async () => {
      const sourceStatus = await command(["git", "status", "--porcelain=v1", "--untracked-files=all"], repoRoot, 15_000, 1024 * 1024);
      if (sourceStatus.stdout.byteLength !== 0) throw new Error("packed-product rehearsal requires a clean source repository");
      const commit = (await command(["git", "rev-parse", "HEAD"], repoRoot, 15_000, 128)).stdout.toString("utf8").trim();
      if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("packed-product rehearsal source commit is invalid");
      return commit;
    });
    await runReleasePhase("producer-clone", report, async () => {
      await command(["git", "clone", "--local", "--no-hardlinks", "--no-checkout", repoRoot, producer], temporary, 120_000);
      await command(["git", "-c", "commit.gpgsign=false", "checkout", "--detach", sourceCommit], producer, 30_000);
    });
    const producerEnv = isolatedEnvironment({
      home: producerHome,
      cache: producerCache,
      path: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    });
    await runReleasePhase("producer-sdk-install", report, async () => await command([
      process.execPath, "install", "--frozen-lockfile", "--ignore-scripts", "--backend=copyfile",
    ], producer, 5 * 60_000, 4 * 1024 * 1024, producerEnv));
    await runReleasePhase("producer-pwa-install", report, async () => await command([
      process.execPath, "install", "--frozen-lockfile", "--ignore-scripts", "--backend=copyfile",
    ], join(producer, "pwa"), 5 * 60_000, 4 * 1024 * 1024, producerEnv));
    const product = await runReleasePhase("product-assembly", report, async () =>
      await assembleCompleteProductPackage({
        repoRoot: producer,
        outputDir: productOutput,
        ...(report === undefined ? {} : { reportProgress: report }),
      }));
    validatePackResult(product.packed);
    const tarballBytes = await readBoundedFile(product.tarball, PRODUCT_PACKAGE_CAPS.packedBytes);
    const tarballSha256 = sha256(tarballBytes);

    const baseEnv = Object.freeze({
      ...isolatedEnvironment({
        home,
        cache: installCache,
        path: `${globalLayout.binRoot}:${dirname(npmExecutable)}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      }),
      NPM_CONFIG_PREFIX: prefix,
      NPM_CONFIG_CACHE: installCache,
      XDG_CACHE_HOME: xdgCache,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_DATA_HOME: xdgData,
      NODE_PATH: "",
    });
    const installedRoot = globalLayout.packageRoot;
    const domeBin = globalLayout.domeBin;
    let installedEvidence: InstalledProductEvidence | undefined;
    const portable = await runPackedProductAcceptanceForTests({
      install: async () => {
        await runReleasePhase("global-install", report, async () => await command(
          buildPackedProductGlobalInstallCommand({
            npmExecutable,
            tarball: product.tarball,
            prefix,
            cache: installCache,
          }),
          probe,
          10 * 60_000,
          4 * 1024 * 1024,
          baseEnv,
        ));
        await assertGlobalInstallLinks(
          prefix,
          globalLayout.modulesRoot,
          globalLayout.binRoot,
          installedRoot,
          domeBin,
        );
        const installedPackage = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8"));
        if (JSON.stringify(validateReleasePackageManifest(installedPackage)) !== JSON.stringify(EXPORTS)) {
          throw new Error("globally installed package identity differs from release contract");
        }
      },
      retireInputs: async () => {
        await runReleasePhase("retire-producer-inputs", report, async () => await Promise.all([
          removeOwnedDirectory(producer, "producer repository"),
          removeOwnedDirectory(productOutput, "product build output"),
          removeOwnedDirectory(installCache, "npm install cache"),
          removeOwnedDirectory(producerCache, "producer dependency cache"),
          removeOwnedDirectory(producerHome, "producer home and XDG state"),
        ]));
      },
      assertInputsUnavailable: async () => {
        await runReleasePhase("prove-producer-retired", report, async () => await Promise.all([
          assertAbsent(producer, "producer repository"),
          assertAbsent(productOutput, "product build output"),
          assertAbsent(product.tarball, "packed tarball"),
          assertAbsent(installCache, "npm install cache"),
          assertAbsent(producerCache, "producer dependency cache"),
          assertAbsent(producerHome, "producer home and XDG state"),
        ]));
      },
      verifyInstalled: async () => {
        return await runReleasePhase("verify-installed-product", report, async () => {
          const installedVerifier = pathToFileURL(
            join(installedRoot, "src", "product-package", "installed-product.ts"),
          ).href;
          const program = [
            `import { verifyInstalledProduct } from ${JSON.stringify(installedVerifier)};`,
            `const evidence = await verifyInstalledProduct(${JSON.stringify({ packageRoot: installedRoot, temporaryParent: probe })});`,
            `process.stdout.write(JSON.stringify(evidence));`,
          ].join("\n");
          const path = join(probe, "verify-installed-product.ts");
          await writeFile(path, program, { flag: "wx", mode: 0o600 });
          const result = await command(
            [process.execPath, path], probe, 10 * 60_000, 4 * 1024 * 1024, offlineEnv(baseEnv),
          );
          installedEvidence = JSON.parse(result.stdout.toString("utf8")) as InstalledProductEvidence;
          if (installedEvidence.manifest.package.sourceCommit !== sourceCommit ||
            installedEvidence.manifestSha256 !==
              sha256(Buffer.from(`${JSON.stringify(product.manifest, null, 2)}\n`))) {
            throw new Error("installed product manifest differs from assembled product evidence");
          }
          return installedEvidence;
        });
      },
      verifyExports: async () => {
        return await runReleasePhase("verify-exports", report, async () => {
          const consumer = await preparePackedProductConsumerWorkspace({
            prefix,
            installedRoot,
            workspace: join(probe, "consumer"),
          });
          const path = join(consumer.root, "verify-exports.ts");
          await writeFile(
            path,
            `${EXPORTS.map((specifier) => `await import(${JSON.stringify(specifier)});`).join("\n")}\n`,
            { flag: "wx", mode: 0o600 },
          );
          await command([process.execPath, path], consumer.root, 2 * 60_000, 1024 * 1024, offlineEnv(baseEnv));
          return EXPORTS;
        });
      },
      verifyCli: async () => {
        const result = await runReleasePhase("verify-cli", report, async () =>
          await command([domeBin, "--help"], probe, 60_000, 1024 * 1024, offlineEnv(baseEnv)));
        if (!result.stdout.toString("utf8").includes("Dome vault compiler")) {
          throw new Error("global dome --help did not render the Dome CLI");
        }
      },
      verifyConsumer: async () => await runReleasePhase(
        "verify-consumer",
        report,
        async () => await verifyInstalledConsumerWorkflow({
          domeBin,
          installedRoot,
          workspace: probe,
          env: offlineEnv(baseEnv),
          run: async (argv, cwd, env) => {
            const result = await command(argv, cwd, 2 * 60_000, 4 * 1024 * 1024, env);
            return Object.freeze({ stdout: result.stdout.toString("utf8") });
          },
        }),
      ),
    });
    if (installedEvidence === undefined) throw new Error("installed product evidence was not produced");
    return Object.freeze({
      ...portable,
      schema: "dome.packed-product-rehearsal/v3" as const,
      evidence: "complete-packed-product" as const,
      artifact: Object.freeze({
        filename: "marktoda-dome-0.4.0.tgz" as const,
        sha256: tarballSha256,
        sourceCommit,
        entries: product.packed.entryCount,
        packedBytes: product.packed.size,
        unpackedBytes: product.packed.unpackedSize,
      }),
      globalInstall: PACKED_PRODUCT_GLOBAL_INSTALL_CONTRACT,
    });
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    try {
      await runReleasePhase(
        "temporary-cleanup", report, async () => await removeOwnedDirectory(temporary, "rehearsal temporary root"),
      );
    }
    catch (cleanup) {
      if (primary !== undefined) throw new AggregateError([primary, cleanup], "packed-product rehearsal and cleanup both failed");
      throw cleanup;
    }
  }
}

async function assertGlobalInstallLinks(
  prefix: string, globalDir: string, globalBin: string, installedRoot: string, domeBin: string,
): Promise<void> {
  const lexicalRoot = await lstat(installedRoot);
  if (!lexicalRoot.isDirectory() || lexicalRoot.isSymbolicLink()) throw new Error("global package root is not a direct directory");
  const binInfo = await lstat(domeBin);
  if (!binInfo.isSymbolicLink()) throw new Error("global dome bin is not the expected package link");
  const binTarget = await realpath(domeBin);
  if (!contains(prefix, binTarget) || binTarget !== join(installedRoot, "bin", "dome")) {
    throw new Error("global dome bin escapes the isolated package prefix");
  }
  if (((await lstat(binTarget)).mode & 0o7777) !== Number.parseInt(PACKED_PRODUCT_GLOBAL_INSTALL_CONTRACT.binTargetMode, 8)) {
    throw new Error(`global dome bin target mode is not ${PACKED_PRODUCT_GLOBAL_INSTALL_CONTRACT.binTargetMode}`);
  }
  for (const root of [globalDir, globalBin]) await assertLinksContained(root, prefix);
}

async function assertLinksContained(root: string, prefix: string): Promise<void> {
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) {
        if (!contains(prefix, await realpath(child))) throw new Error(`global install link escapes prefix: ${relative(root, child)}`);
      } else if (entry.isDirectory()) await visit(child);
    }
  }
  await visit(root);
}

function offlineEnv(base: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  return {
    ...base,
    HTTP_PROXY: "http://127.0.0.1:1",
    HTTPS_PROXY: "http://127.0.0.1:1",
    ALL_PROXY: "http://127.0.0.1:1",
    NO_PROXY: "",
  };
}

function isolatedEnvironment(input: Readonly<{ home: string; cache: string; path: string }>): Record<string, string> {
  const env: Record<string, string> = {
    HOME: input.home,
    PATH: input.path,
    XDG_CACHE_HOME: join(input.home, ".cache"),
    XDG_CONFIG_HOME: join(input.home, ".config"),
    XDG_DATA_HOME: join(input.home, ".local", "share"),
    BUN_INSTALL_CACHE_DIR: input.cache,
    BUN_CONFIG_REGISTRY: "https://registry.npmjs.org",
    NPM_CONFIG_REGISTRY: "https://registry.npmjs.org",
    NPM_CONFIG_USERCONFIG: "/dev/null",
    npm_config_userconfig: "/dev/null",
    BUN_CONFIG_TOKEN: "",
    NPM_TOKEN: "",
    NODE_AUTH_TOKEN: "",
  };
  for (const key of ["CI", "LANG", "LC_ALL", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR"] as const) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

async function command(
  argv: ReadonlyArray<string>, cwd: string, timeoutMs: number, maxStdoutBytes = 1024 * 1024,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<ProductPackageCommandResult> {
  return await runBoundedProductCommand(argv, cwd, {
    timeoutMs, maxStdoutBytes, maxStderrBytes: 4 * 1024 * 1024,
    ...(env === undefined ? {} : { env }),
  });
}

async function readBoundedFile(path: string, maxBytes: number): Promise<Buffer> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maxBytes) {
    throw new Error("packed product tarball is not a bounded regular file");
  }
  return await readFile(path);
}

async function assertAbsent(path: string, label: string): Promise<void> {
  try { await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} remains available during installed-product verification`);
}

async function removeOwnedDirectory(path: string, label: string): Promise<void> {
  await command(["/bin/rm", "-rf", "--", path], tmpdir(), 2 * 60_000, 1_024 * 1_024);
  await assertAbsent(path, label);
}

function contains(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function main(): Promise<void> {
  const report = await rehearsePackedProduct({
    reportProgress: (progress) => { process.stderr.write(`${formatReleaseProgress(progress)}\n`); },
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`packed-product-rehearsal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
