import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { currentSha } from "../git";
import {
  verifyHomeArtifactEvidence,
  type HomeArtifactEvidenceVerifier,
} from "../product-host/home-artifact";
import {
  PRODUCT_PACKAGE_NAME,
  PRODUCT_PACKAGE_VERSION,
} from "../product-package/manifest";
import type { SetupProductEvidence } from "./compiler";
import { discoverSetupProduct } from "./discovery";

/**
 * Resolve the product identity that authorizes `dome init`.
 *
 * A packaged distribution is always verified through the closed product
 * manifest. Presence of that manifest selects the packaged path permanently:
 * verification failure never falls back to weaker source-tree evidence.
 * Developer checkouts are admitted only when this exact package root owns a
 * direct `.git` file or directory, so an installed package nested beneath an
 * unrelated repository cannot borrow its identity.
 */
export async function discoverInitProduct(
  packageRootInput = resolve(import.meta.dir, "../.."),
  verifyArtifact: HomeArtifactEvidenceVerifier = verifyHomeArtifactEvidence,
): Promise<SetupProductEvidence> {
  const packageRoot = resolve(packageRootInput);
  if (await entryExists(join(packageRoot, "product", "manifest.json"))) {
    return discoverSetupProduct(packageRoot);
  }

  const artifactRoot = dirname(packageRoot);
  if (basename(packageRoot) === "app" && await entryExists(join(artifactRoot, "manifest.json"))) {
    await requireExactArtifactAppRoot(packageRoot, artifactRoot);
    const evidence = await verifyArtifact(artifactRoot);
    return Object.freeze({
      distribution: "home-artifact" as const,
      packageName: PRODUCT_PACKAGE_NAME,
      packageVersion: evidence.manifest.product.version,
      sourceCommit: evidence.manifest.build.gitCommit,
      homeArtifactManifestSha256: evidence.manifestSha256,
      packagedHome: null,
    });
  }

  const gitEntry = await directGitEntry(packageRoot);
  if (gitEntry === "unavailable") {
    throw new Error(
      "Dome init product evidence is unavailable: expected a verified product manifest, verified Home artifact, or direct package-root Git metadata",
    );
  }
  const sourceCommit = await currentSha(packageRoot);
  if (sourceCommit === null) {
    throw new Error("source-tree init requires Dome to run from a Git commit");
  }
  return Object.freeze({
    distribution: "source-tree" as const,
    packageName: PRODUCT_PACKAGE_NAME,
    packageVersion: PRODUCT_PACKAGE_VERSION,
    sourceCommit,
    sourceTreeSha256: createHash("sha256")
      .update(`dome-source-tree/v1\0${sourceCommit}`)
      .digest("hex"),
    packagedHome: null,
  });
}

async function requireExactArtifactAppRoot(packageRoot: string, artifactRoot: string): Promise<void> {
  const [appEntry, rootEntry, canonicalApp, canonicalRoot] = await Promise.all([
    lstat(packageRoot),
    lstat(artifactRoot),
    realpath(packageRoot),
    realpath(artifactRoot),
  ]);
  if (!appEntry.isDirectory() || appEntry.isSymbolicLink() ||
    !rootEntry.isDirectory() || rootEntry.isSymbolicLink() ||
    canonicalApp !== packageRoot || canonicalRoot !== artifactRoot ||
    dirname(canonicalApp) !== canonicalRoot) {
    throw new Error("Home artifact init requires its exact canonical app directory");
  }
}

async function entryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function directGitEntry(packageRoot: string): Promise<"available" | "unavailable"> {
  try {
    const entry = await lstat(join(packageRoot, ".git"));
    return !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile())
      ? "available"
      : "unavailable";
  } catch (error) {
    if (hasCode(error, "ENOENT")) return "unavailable";
    throw error;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { readonly code?: unknown }).code === code;
}
