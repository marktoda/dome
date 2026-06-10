// VaultPath: canonical POSIX paths relative to a Dome vault root.
//
// This is a value-boundary helper, not a filesystem API. Processor-facing
// surfaces still accept ordinary strings for ergonomics; constructors and
// runtime boundaries canonicalize those strings into VaultPath before the
// engine uses them for git reads, patch application, provenance, or capability
// matching.

import { z } from "zod";

export type VaultPath = string & { readonly __brand: "VaultPath" };

export type VaultPathParseError =
  | "empty"
  | "absolute"
  | "backslash"
  | "dot-segment"
  | "trailing-slash";

export type VaultPathParseResult =
  | { readonly ok: true; readonly path: VaultPath }
  | { readonly ok: false; readonly error: VaultPathParseError };

/**
 * Parse a user/processor supplied path into Dome's canonical vault-relative
 * representation. Duplicate slashes are collapsed; absolute paths, backslash
 * paths, `.` / `..` segments, empty strings, and trailing slashes are rejected.
 */
export function parseVaultPath(raw: string): VaultPathParseResult {
  if (raw.length === 0) return Object.freeze({ ok: false, error: "empty" });
  if (raw.startsWith("/")) {
    return Object.freeze({ ok: false, error: "absolute" });
  }
  if (raw.includes("\\")) {
    return Object.freeze({ ok: false, error: "backslash" });
  }
  if (raw.endsWith("/")) {
    return Object.freeze({ ok: false, error: "trailing-slash" });
  }

  const segments: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment.length === 0) continue;
    if (segment === "." || segment === "..") {
      return Object.freeze({ ok: false, error: "dot-segment" });
    }
    segments.push(segment);
  }

  if (segments.length === 0) {
    return Object.freeze({ ok: false, error: "empty" });
  }
  return Object.freeze({
    ok: true,
    path: segments.join("/") as VaultPath,
  });
}

export function canonicalVaultPath(raw: string): VaultPath | null {
  const result = parseVaultPath(raw);
  return result.ok ? result.path : null;
}

export function requireVaultPath(raw: string, label = "vault path"): VaultPath {
  const result = parseVaultPath(raw);
  if (result.ok) return result.path;
  throw new Error(
    `${label} must be a vault-relative POSIX file path (${result.error})`,
  );
}

export const VaultPathSchema = z
  .string()
  .superRefine((value, ctx) => {
    const result = parseVaultPath(value);
    if (!result.ok) {
      ctx.addIssue({
        code: "custom",
        message: `must be a vault-relative POSIX file path (${result.error})`,
      });
    }
  })
  .transform((value) => requireVaultPath(value));
