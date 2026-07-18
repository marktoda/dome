#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  PRODUCT_PACKAGE_CAPS,
  PRODUCT_PACKAGE_SOURCE_PATHS,
} from "../src/product-package/manifest";
import { assembleCompleteProductPackage } from "./product-package";
import {
  verifyInstalledConsumerWorkflow,
} from "./installed-consumer-rehearsal";

export { currentSchemaReopenEvidence } from "./installed-consumer-rehearsal";

const repoRoot = resolve(import.meta.dir, "..");

export const RELEASE_PACKAGE_NAME = "@marktoda/dome";

const EXPECTED_EXPORTS = Object.freeze({
  ".": Object.freeze({
    types: "./src/index.ts",
    default: "./src/index.ts",
  }),
  "./cli": Object.freeze({
    types: "./src/cli/index.ts",
    default: "./src/cli/index.ts",
  }),
  "./mcp": Object.freeze({
    types: "./src/mcp/server.ts",
    default: "./src/mcp/server.ts",
  }),
});

const EXPECTED_MANIFEST_FIELDS = Object.freeze({
  name: RELEASE_PACKAGE_NAME,
  version: "0.4.0",
  description: "Dome — a local, self-tending operating system for your second brain.",
  license: "MIT",
  author: "Mark Toda",
  repository: Object.freeze({
    type: "git",
    url: "git+https://github.com/marktoda/dome.git",
  }),
  homepage: "https://github.com/marktoda/dome#readme",
  bugs: Object.freeze({ url: "https://github.com/marktoda/dome/issues" }),
  publishConfig: Object.freeze({ access: "public" }),
  engines: Object.freeze({ bun: ">=1.2.13 <2" }),
  packageManager: "bun@1.2.13",
  type: "module",
  main: "src/index.ts",
  types: "src/index.ts",
  exports: EXPECTED_EXPORTS,
  bin: Object.freeze({ dome: "bin/dome" }),
});

const PACKAGE_PATH_SEGMENTS = packagePathSegments(RELEASE_PACKAGE_NAME);

export const RELEASE_PACKAGE_CAPS = Object.freeze({
  entries: PRODUCT_PACKAGE_CAPS.packedEntries,
  packedBytes: PRODUCT_PACKAGE_CAPS.packedBytes,
  unpackedBytes: PRODUCT_PACKAGE_CAPS.unpackedBytes,
});

const ALLOWED_PATHS = Object.freeze([
  ...PRODUCT_PACKAGE_SOURCE_PATHS,
  "product/",
]);

type PackFile = {
  readonly path: string;
  readonly size: number;
  readonly mode: number;
};

type PackResult = {
  readonly filename: string;
  readonly size: number;
  readonly unpackedSize: number;
  readonly entryCount: number;
  readonly files: ReadonlyArray<PackFile>;
};

export type ReleasePackageReport = {
  readonly schema: "dome.release-package/v1";
  readonly artifact: {
    readonly filename: string;
    readonly entries: number;
    readonly packedBytes: number;
    readonly unpackedBytes: number;
  };
  readonly installed: true;
  readonly exports: ReadonlyArray<string>;
  readonly cliHelp: true;
  readonly scaffold: {
    readonly canonicalAgents: true;
    readonly canonicalClaude: true;
    readonly canonicalConfig: true;
    readonly installedAssets: true;
    readonly bundlesResolved: true;
  };
  readonly currentSchemaReopen: {
    readonly attempts: 2;
    readonly succeeded: true;
    readonly semanticRefsStable: true;
    readonly priorVersionUpgradeClaimed: false;
  };
};

export function validatePackResult(result: PackResult): void {
  if (result.filename !== "marktoda-dome-0.4.0.tgz") {
    throw new Error(`release artifact filename is unexpected: ${result.filename}`);
  }
  if (result.entryCount !== result.files.length) {
    throw new Error(`npm pack entry count mismatch: ${result.entryCount} != ${result.files.length}`);
  }
  if (result.entryCount > RELEASE_PACKAGE_CAPS.entries) {
    throw new Error(`release artifact has ${result.entryCount} entries (cap ${RELEASE_PACKAGE_CAPS.entries})`);
  }
  if (result.size > RELEASE_PACKAGE_CAPS.packedBytes) {
    throw new Error(`release artifact is ${result.size} packed bytes (cap ${RELEASE_PACKAGE_CAPS.packedBytes})`);
  }
  if (result.unpackedSize > RELEASE_PACKAGE_CAPS.unpackedBytes) {
    throw new Error(`release artifact is ${result.unpackedSize} unpacked bytes (cap ${RELEASE_PACKAGE_CAPS.unpackedBytes})`);
  }
  if (new Set(result.files.map((file) => file.path)).size !== result.files.length) {
    throw new Error("release artifact contains duplicate paths");
  }

  for (const file of result.files) {
    if (!isAllowedPackagePath(file.path)) {
      throw new Error(`release artifact contains forbidden path: ${file.path}`);
    }
    const segments = file.path.split("/");
    if (segments.some((segment) => segment.startsWith("."))) {
      throw new Error(`release artifact contains dotfile path: ${file.path}`);
    }
    if (/^(docs|tests|scripts|pwa)(\/|$)/i.test(file.path)) {
      throw new Error(`release artifact contains development prefix: ${file.path}`);
    }
    if (/(^|\/)(\.codex|worktrees)(\/|$)/i.test(file.path)) {
      throw new Error(`release artifact contains worktree state: ${file.path}`);
    }
    if (/(^|\/)(bun\.lock|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/i.test(file.path)) {
      throw new Error(`release artifact contains lockfile: ${file.path}`);
    }
  }

  const domeBin = result.files.find((file) => file.path === "bin/dome");
  if (domeBin === undefined || (domeBin.mode & 0o111) === 0) {
    throw new Error("release artifact bin/dome is missing or not executable");
  }
  for (const required of [
    "LICENSE",
    "README.md",
    "package.json",
    "contracts/agent-stream.ts",
    "contracts/capture.ts",
    "contracts/product-readiness.ts",
    "contracts/source-document.ts",
    "contracts/task-backlog.ts",
    "contracts/task-backlog-review.ts",
    "assets/extensions/dome.markdown/manifest.yaml",
    "assets/model-providers/anthropic.ts",
    "assets/source-handlers/claude-slack.sh",
    "product/manifest.json",
    "product/pwa/index.html",
  ]) {
    if (!result.files.some((file) => file.path === required)) {
      throw new Error(`release artifact is missing runtime path: ${required}`);
    }
  }
  const homeArchives = result.files.filter((file) =>
    /^product\/home\/dome-home-0\.4\.0-darwin-arm64\.tar\.gz$/.test(file.path)
  );
  if (homeArchives.length !== 1 || (homeArchives[0]!.mode & 0o111) !== 0) {
    throw new Error("release artifact must contain exactly one non-executable Home archive");
  }
}

export function validateReleasePackageManifest(manifest: unknown): ReadonlyArray<string> {
  if (!isRecord(manifest)) {
    throw new Error("installed release package manifest is not an object");
  }
  for (const forbidden of ["private", "os", "cpu"] as const) {
    if (forbidden in manifest) {
      throw new Error(`installed release package manifest must not declare ${forbidden}`);
    }
  }
  for (const [field, expected] of Object.entries(EXPECTED_MANIFEST_FIELDS)) {
    if (!isDeepStrictEqual(manifest[field], expected)) {
      throw new Error(`installed release package manifest has unexpected ${field}`);
    }
  }
  return Object.freeze(
    Object.keys(EXPECTED_EXPORTS).map((key) =>
      key === "." ? RELEASE_PACKAGE_NAME : `${RELEASE_PACKAGE_NAME}${key.slice(1)}`
    ),
  );
}

function isAllowedPackagePath(path: string): boolean {
  return ALLOWED_PATHS.some((allowed) =>
    allowed.endsWith("/") ? path.startsWith(allowed) : path === allowed
  );
}

export async function rehearseReleasePackage(): Promise<ReleasePackageReport> {
  const temporary = await mkdtemp(join(tmpdir(), "dome-release-package-"));
  try {
    const product = await assembleCompleteProductPackage({
      repoRoot,
      outputDir: join(temporary, "complete-product"),
    });
    const packed = product.packed;
    validatePackResult(packed);
    const tarball = product.tarball;
    if (!existsSync(tarball)) throw new Error(`npm pack did not create ${tarball}`);
    if ((await stat(tarball)).size !== packed.size) {
      throw new Error("npm pack reported a different tarball size than the file on disk");
    }

    const consumer = join(temporary, "consumer");
    await mkdir(consumer);
    await Bun.write(join(consumer, "package.json"), JSON.stringify({
      name: "dome-release-rehearsal-consumer",
      private: true,
      type: "module",
    }, null, 2));
    await run([process.execPath, "add", "--offline", tarball], consumer);

    const installedRoot = join(consumer, "node_modules", ...PACKAGE_PATH_SEGMENTS);
    const installedPackage = JSON.parse(
      await readFile(join(installedRoot, "package.json"), "utf8"),
    ) as unknown;
    const exportSpecifiers = validateReleasePackageManifest(installedPackage);
    const importProgram = exportSpecifiers
      .map((specifier) => `await import(${JSON.stringify(specifier)});`)
      .join("\n");
    await writeFile(join(consumer, "verify-exports.ts"), importProgram);
    await run([process.execPath, "verify-exports.ts"], consumer);

    const domeBin = join(consumer, "node_modules", ".bin", "dome");
    const help = await run([domeBin, "--help"], consumer);
    if (!help.stdout.includes("Dome vault compiler")) {
      throw new Error("installed dome --help did not render the Dome CLI");
    }

    const offlineEnv = {
      ANTHROPIC_API_KEY: "",
      HTTP_PROXY: "http://127.0.0.1:1",
      HTTPS_PROXY: "http://127.0.0.1:1",
      NO_PROXY: "",
    };
    const consumerEvidence = await verifyInstalledConsumerWorkflow({
      domeBin,
      installedRoot,
      workspace: consumer,
      env: offlineEnv,
      run: async (command, cwd, env) => await run(command, cwd, env),
    });

    return Object.freeze({
      schema: "dome.release-package/v1" as const,
      artifact: Object.freeze({
        filename: packed.filename,
        entries: packed.entryCount,
        packedBytes: packed.size,
        unpackedBytes: packed.unpackedSize,
      }),
      installed: true as const,
      exports: Object.freeze(exportSpecifiers),
      cliHelp: true as const,
      scaffold: consumerEvidence.scaffold,
      currentSchemaReopen: consumerEvidence.currentSchemaReopen,
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function packagePathSegments(packageName: string): ReadonlyArray<string> {
  const match = /^(@[^/]+)\/([^/]+)$/.exec(packageName);
  if (match === null) throw new Error(`release package name is not scoped: ${packageName}`);
  return Object.freeze([match[1]!, match[2]!]);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type CommandResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

async function run(
  command: ReadonlyArray<string>,
  cwd: string,
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<CommandResult> {
  const proc = Bun.spawn({
    cmd: [...command],
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} failed with exit ${exitCode}: ${stderr.trim() || stdout.trim()}`,
    );
  }
  return { stdout, stderr, exitCode };
}

if (import.meta.main) {
  rehearseReleasePackage()
    .then((report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`release-package: ${message}`);
      process.exit(1);
    });
}
