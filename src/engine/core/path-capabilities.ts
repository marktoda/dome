// Path-bearing capability helpers.
//
// The broker and processor runtime both need the same declared ∩ granted
// semantics for vault-relative paths. Keeping the logic here avoids two subtly
// different glob filters for PatchEffect enforcement and ctx.snapshot reads.

import type { Capability } from "../../core/processor";
import {
  canonicalVaultPath,
  type VaultPath,
} from "../../core/vault-path";
import { globMatch } from "./glob-cache";

export type PathCapabilityKind =
  | "patch.auto"
  | "patch.propose"
  | "owns.path"
  | "search.write"
  | "read";

export function pathCapabilityEffectiveFor(
  kind: PathCapabilityKind,
  rawPath: string,
  declared: ReadonlyArray<Capability>,
  granted: ReadonlyArray<Capability>,
): boolean {
  const path = canonicalVaultPath(rawPath);
  if (path === null) return false;
  return (
    pathCapabilityMatches(kind, path, declared) &&
    pathCapabilityMatches(kind, path, granted)
  );
}

export function readablePath(
  rawPath: string,
  declared: ReadonlyArray<Capability>,
  granted: ReadonlyArray<Capability>,
): VaultPath | null {
  const path = canonicalVaultPath(rawPath);
  if (path === null) return null;
  return pathCapabilityMatches("read", path, declared) &&
    pathCapabilityMatches("read", path, granted)
    ? path
    : null;
}

export function filterReadablePaths(
  rawPaths: ReadonlyArray<string>,
  declared: ReadonlyArray<Capability>,
  granted: ReadonlyArray<Capability>,
): ReadonlyArray<VaultPath> {
  const out: VaultPath[] = [];
  for (const rawPath of rawPaths) {
    const path = readablePath(rawPath, declared, granted);
    if (path !== null) out.push(path);
  }
  return Object.freeze(out);
}

export function pathCapabilityMatches(
  kind: PathCapabilityKind,
  path: VaultPath,
  caps: ReadonlyArray<Capability>,
): boolean {
  for (const cap of caps) {
    if (!isPathCapability(cap) || cap.kind !== kind) continue;
    for (const pattern of cap.paths) {
      if (globMatch(pattern, path)) return true;
    }
  }
  return false;
}

export function pathIsOwnedByThirdParty(
  rawPath: string,
  declared: ReadonlyArray<Capability>,
  granted: ReadonlyArray<Capability>,
): boolean {
  const path = canonicalVaultPath(rawPath);
  if (path === null) return false;
  const ownedByPolicy = pathCapabilityMatches("owns.path", path, granted);
  if (!ownedByPolicy) return false;
  const declaredOwn = pathCapabilityMatches("owns.path", path, declared);
  return !declaredOwn;
}

function isPathCapability(
  cap: Capability,
): cap is Extract<Capability, { readonly paths: ReadonlyArray<string> }> {
  return (
    cap.kind === "patch.auto" ||
    cap.kind === "patch.propose" ||
    cap.kind === "owns.path" ||
    cap.kind === "search.write" ||
    cap.kind === "read"
  );
}
