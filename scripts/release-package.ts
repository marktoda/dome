#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");

export const RELEASE_PACKAGE_CAPS = Object.freeze({
  entries: 500,
  packedBytes: 2_000_000,
  unpackedBytes: 5_000_000,
});

const ALLOWED_PATHS = Object.freeze([
  "src/",
  "assets/extensions/",
  "assets/model-providers/",
  "assets/source-handlers/",
  "bin/dome",
  "README.md",
  // npm always includes package.json independently of the files allowlist.
  "package.json",
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
    readonly modelProvider: "anthropic";
    readonly source: "slack";
    readonly bundlesResolved: true;
  };
  readonly currentSchemaReopen: {
    readonly attempts: 2;
    readonly idempotent: true;
    readonly priorVersionUpgradeClaimed: false;
  };
};

export function validatePackResult(result: PackResult): void {
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
    "README.md",
    "package.json",
    "assets/extensions/dome.markdown/manifest.yaml",
    "assets/model-providers/anthropic.ts",
    "assets/source-handlers/claude-slack.sh",
  ]) {
    if (!result.files.some((file) => file.path === required)) {
      throw new Error(`release artifact is missing runtime path: ${required}`);
    }
  }
}

function isAllowedPackagePath(path: string): boolean {
  return ALLOWED_PATHS.some((allowed) =>
    allowed.endsWith("/") ? path.startsWith(allowed) : path === allowed
  );
}

export async function rehearseReleasePackage(): Promise<ReleasePackageReport> {
  const temporary = await mkdtemp(join(tmpdir(), "dome-release-package-"));
  try {
    const packOutput = await run([
      "npm",
      "pack",
      "--json",
      "--pack-destination",
      temporary,
    ], repoRoot);
    const parsed = JSON.parse(packOutput.stdout) as ReadonlyArray<PackResult>;
    const packed = parsed[0];
    if (packed === undefined || parsed.length !== 1) {
      throw new Error(`npm pack returned ${parsed.length} artifacts; expected exactly one`);
    }
    validatePackResult(packed);
    const tarball = join(temporary, basename(packed.filename));
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

    const installedRoot = join(consumer, "node_modules", "@dome", "sdk");
    const installedPackage = JSON.parse(
      await readFile(join(installedRoot, "package.json"), "utf8"),
    ) as { readonly exports: Readonly<Record<string, unknown>> };
    const exportSpecifiers = Object.keys(installedPackage.exports).map((key) =>
      key === "." ? "@dome/sdk" : `@dome/sdk${key.slice(1)}`
    );
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

    const vault = join(temporary, "external-vault");
    const offlineEnv = {
      ANTHROPIC_API_KEY: "",
      HTTP_PROXY: "http://127.0.0.1:1",
      HTTPS_PROXY: "http://127.0.0.1:1",
      NO_PROXY: "",
    };
    await run([
      domeBin,
      "init",
      vault,
      "--with-model-provider",
      "anthropic",
      "--with-source",
      "slack",
    ], consumer, offlineEnv);

    for (const required of [
      join(installedRoot, "assets", "extensions", "dome.markdown", "manifest.yaml"),
      join(installedRoot, "assets", "model-providers", "anthropic.ts"),
      join(installedRoot, "assets", "source-handlers", "claude-slack.sh"),
      join(vault, ".dome", "model-provider.ts"),
      join(vault, ".dome", "bin", "fetch-slack.sh"),
    ]) {
      if (!existsSync(required)) throw new Error(`installed package did not resolve asset: ${required}`);
    }
    if (
      await readFile(join(vault, ".dome", "model-provider.ts"), "utf8") !==
      await readFile(join(installedRoot, "assets", "model-providers", "anthropic.ts"), "utf8")
    ) {
      throw new Error("installed model-provider scaffold differs from its shipped asset");
    }
    if (
      await readFile(join(vault, ".dome", "bin", "fetch-slack.sh"), "utf8") !==
      await readFile(join(installedRoot, "assets", "source-handlers", "claude-slack.sh"), "utf8")
    ) {
      throw new Error("installed Slack scaffold differs from its shipped asset");
    }

    await run([domeBin, "sync", "--vault", vault, "--quiet"], consumer, offlineEnv);
    const firstStatus = parseStatus(await run([
      domeBin, "status", "--vault", vault, "--json",
    ], consumer, offlineEnv));
    const secondStatus = parseStatus(await run([
      domeBin, "status", "--vault", vault, "--json",
    ], consumer, offlineEnv));
    if (
      firstStatus.head !== secondStatus.head ||
      firstStatus.adopted !== secondStatus.adopted ||
      firstStatus.head === null ||
      firstStatus.adopted === null
    ) {
      throw new Error("installed package current-schema reopen was not idempotent");
    }

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
      scaffold: Object.freeze({
        modelProvider: "anthropic" as const,
        source: "slack" as const,
        bundlesResolved: true as const,
      }),
      currentSchemaReopen: Object.freeze({
        attempts: 2 as const,
        idempotent: true as const,
        priorVersionUpgradeClaimed: false as const,
      }),
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function parseStatus(result: CommandResult): { readonly head: string | null; readonly adopted: string | null } {
  const parsed = JSON.parse(result.stdout) as { readonly head?: unknown; readonly adopted?: unknown };
  return {
    head: typeof parsed.head === "string" ? parsed.head : null,
    adopted: typeof parsed.adopted === "string" ? parsed.adopted : null,
  };
}

type CommandResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

async function run(
  command: ReadonlyArray<string>,
  cwd: string,
  env: Readonly<Record<string, string>> = {},
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
