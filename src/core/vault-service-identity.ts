import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";

/**
 * Deterministic identity shared by every per-vault host surface. Resolving the
 * path here keeps setup previews and lifecycle application on the same seam.
 */
export function vaultServiceSlug(vaultPath: string): string {
  const resolved = resolve(vaultPath);
  const base = basename(resolved)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 8);
  return `${base.length > 0 ? base : "vault"}-${hash}`;
}

export function serveServiceLabelForVault(vaultPath: string): string {
  return `com.dome.serve.${vaultServiceSlug(vaultPath)}`;
}

export function serveServiceUnitNameForVault(vaultPath: string): string {
  return `dome-serve-${vaultServiceSlug(vaultPath)}.service`;
}

export function homeServiceLabelForVault(vaultPath: string): string {
  return `com.dome.home.${vaultServiceSlug(vaultPath)}`;
}
