#!/usr/bin/env bun

import { basename, resolve } from "node:path";

import {
  assembleProductPackageForTests,
  type PortableProductPackageAssembly,
} from "./product-package/assembler";
import { materializeHomeArtifactArchive } from "../src/product-host/home-artifact-archive";
import { publishDirectoryExclusive } from "../src/platform/exclusive-rename";
import { buildHomeArtifact } from "./home-artifact";
import type { ReleaseProgressReporter } from "./release-progress";

const REPO_ROOT = resolve(import.meta.dir, "..");

export type CompleteProductPackage = Omit<PortableProductPackageAssembly, "evidence"> & Readonly<{
  evidence: "complete-product-package";
}>;

/** The only release-capable adapter: real Home build plus shipped archive verifier. */
export async function assembleCompleteProductPackage(input: Readonly<{
  repoRoot?: string;
  outputDir: string;
  reportProgress?: ReleaseProgressReporter;
}>): Promise<CompleteProductPackage> {
  const repoRoot = resolve(input.repoRoot ?? REPO_ROOT);
  const reportProgress = input.reportProgress;
  const portable = await assembleProductPackageForTests({
    repoRoot,
    outputDir: resolve(input.outputDir),
  }, {
    buildHome: async ({ repoRoot: buildRoot, outputDir }) => await buildHomeArtifact({
      repoRoot: buildRoot,
      outputDir,
      ...(reportProgress === undefined ? {} : { reportProgress }),
    }),
    inspectHome: async (archiveInput) => await materializeHomeArtifactArchive(archiveInput),
    publish: async ({ source, target }) => await publishDirectoryExclusive({ source, target }),
  });
  return Object.freeze({ ...portable, evidence: "complete-product-package" as const });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let outputDir: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument !== "--output") throw new Error(`unknown option: ${argument}`);
    if (outputDir !== undefined) throw new Error("--output may be supplied only once");
    outputDir = args[index + 1];
    if (outputDir === undefined || outputDir.startsWith("--")) {
      throw new Error("--output requires an absent directory");
    }
    index += 1;
  }
  if (outputDir === undefined) throw new Error("--output is required");
  const result = await assembleCompleteProductPackage({ outputDir });
  process.stdout.write(`${JSON.stringify({
    schema: result.manifest.schema,
    artifact: basename(result.tarball),
    tarball: result.tarball,
    sourceCommit: result.manifest.package.sourceCommit,
    homeArtifactId: result.manifest.home.artifactId,
    evidence: result.evidence,
  }, null, 2)}\n`);
}

if (import.meta.main) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      process.stderr.write(`dome product package: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
