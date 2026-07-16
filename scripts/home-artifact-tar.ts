// Shared normalized USTAR format for Dome Home artifact creation and installed
// rehearsal admission. Keeping this parser independent prevents the installed
// gate from importing the builder it gates.

import { dirname, isAbsolute, resolve, sep } from "node:path";

export const MAX_HOME_ARTIFACT_TAR_BYTES = 512 * 1024 * 1024;

export type HomeArtifactTarEntry = Readonly<{
  path: string;
  type: "file" | "directory" | "symlink" | "hardlink";
  size: number;
  linkTarget: string | null;
}>;

/** Parse the exact normalized USTAR contract before any extraction. */
export function inspectHomeArtifactTar(input: Uint8Array): Readonly<{
  root: string;
  entries: ReadonlyArray<HomeArtifactTarEntry>;
}> {
  if (input.byteLength > MAX_HOME_ARTIFACT_TAR_BYTES) {
    throw new Error("Home artifact tar exceeds its uncompressed size budget");
  }
  const tar = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const entries: HomeArtifactTarEntry[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for (;;) {
    if (offset + 512 > tar.length) throw new Error("Home artifact tar is truncated");
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      if (offset + 512 !== tar.length || !tar.subarray(offset).every((byte) => byte === 0)) {
        throw new Error("Home artifact tar has invalid termination or trailing data");
      }
      break;
    }
    assertHomeTarHeader(header);
    const typeFlag = String.fromCharCode(header[156]!);
    const type = typeFlag === "0" ? "file" : typeFlag === "5" ? "directory" :
      typeFlag === "2" ? "symlink" : typeFlag === "1" ? "hardlink" : null;
    if (type === null) throw new Error(`Home artifact tar contains unsupported entry type ${JSON.stringify(typeFlag)}`);
    const name = homeTarString(header, 0, 100);
    const prefix = homeTarString(header, 345, 155);
    const rawPath = prefix === "" ? name : `${prefix}/${name}`;
    if ((type === "directory") !== rawPath.endsWith("/")) {
      throw new Error(`Home artifact tar member type disagrees with path: ${rawPath}`);
    }
    const path = validateHomeTarPath(type === "directory" ? rawPath.slice(0, -1) : rawPath);
    if (seen.has(path)) throw new Error(`Home artifact tar contains duplicate member: ${path}`);
    seen.add(path);
    const size = homeTarOctal(header, 124, 12);
    if ((type === "directory" || type === "symlink" || type === "hardlink") && size !== 0) {
      throw new Error(`Home artifact tar ${type} has a body: ${path}`);
    }
    const linkTarget = type === "symlink" || type === "hardlink"
      ? homeTarString(header, 157, 100)
      : null;
    if (offset + size > tar.length) throw new Error(`Home artifact tar body is truncated: ${path}`);
    offset += size;
    const padding = (512 - (size % 512)) % 512;
    if (offset + padding > tar.length || !tar.subarray(offset, offset + padding).every((byte) => byte === 0)) {
      throw new Error(`Home artifact tar padding is invalid: ${path}`);
    }
    offset += padding;
    entries.push(Object.freeze({ path, type, size, linkTarget }));
  }
  if (entries.length === 0) throw new Error("Home artifact tar is empty");
  const roots = new Set(entries.map((entry) => entry.path.split("/")[0]!));
  if (roots.size !== 1) throw new Error("Home artifact tar must contain exactly one root");
  const root = [...roots][0]!;
  if (!entries.some((entry) => entry.path === root && entry.type === "directory")) {
    throw new Error("Home artifact tar root must be an explicit directory");
  }
  const rootAbsolute = resolve("/payload", root);
  const reservedAlias = `${root}/runtime/Dome Home`;
  const reservedEntry = entries.find((entry) => entry.path === reservedAlias);
  if (reservedEntry !== undefined && reservedEntry.type !== "hardlink") {
    throw new Error(`Home artifact tar reserved runtime alias is not the canonical hardlink: ${reservedAlias}`);
  }
  const hardlinks = entries.filter((entry) => entry.type === "hardlink");
  for (const link of hardlinks) {
    const expectedPath = reservedAlias;
    const expectedTarget = `${root}/runtime/bun`;
    const target = entries.find((entry) => entry.path === expectedTarget);
    if (link.path !== expectedPath || link.linkTarget !== expectedTarget ||
      target?.type !== "file" || entries.indexOf(target) >= entries.indexOf(link) ||
      entries.some((entry) => entry.path.startsWith(`${link.path}/`))) {
      throw new Error(`Home artifact tar contains unsupported hardlink: ${link.path}`);
    }
  }
  const symlinks = entries.filter((entry) => entry.type === "symlink");
  for (const link of symlinks) {
    const target = link.linkTarget;
    if (target === null || target === "" || target.includes("\0") || isAbsolute(target)) {
      throw new Error(`Home artifact tar symlink target is unsafe: ${link.path}`);
    }
    const resolvedTarget = resolve("/payload", dirname(link.path), target);
    if (resolvedTarget !== rootAbsolute && !resolvedTarget.startsWith(`${rootAbsolute}${sep}`)) {
      throw new Error(`Home artifact tar symlink escapes its root: ${link.path}`);
    }
    if (entries.some((entry) => entry.path.startsWith(`${link.path}/`))) {
      throw new Error(`Home artifact tar contains a member beneath symlink: ${link.path}`);
    }
  }
  return Object.freeze({ root, entries: Object.freeze(entries) });
}

function assertHomeTarHeader(header: Buffer): void {
  if (!header.subarray(257, 263).equals(Buffer.from("ustar\0")) ||
    !header.subarray(263, 265).equals(Buffer.from("00"))) {
    throw new Error("Home artifact tar is not normalized USTAR");
  }
  const expected = homeTarOctal(header, 148, 8);
  const copy = Buffer.from(header);
  copy.fill(0x20, 148, 156);
  const actual = copy.reduce((sum, byte) => sum + byte, 0);
  if (expected !== actual) throw new Error("Home artifact tar header checksum is invalid");
}

function validateHomeTarPath(path: string): string {
  if (path === "" || path.startsWith("/") || path.includes("\\") || path.includes("\0") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Home artifact tar path is unsafe: ${JSON.stringify(path)}`);
  }
  return path;
}

function homeTarString(buffer: Buffer, offset: number, length: number): string {
  const field = buffer.subarray(offset, offset + length);
  const zero = field.indexOf(0);
  return new TextDecoder("utf-8", { fatal: true }).decode(zero === -1 ? field : field.subarray(0, zero));
}

function homeTarOctal(buffer: Buffer, offset: number, length: number): number {
  const raw = homeTarString(buffer, offset, length).trim().replace(/\0+$/g, "");
  if (!/^[0-7]+$/.test(raw)) throw new Error("Home artifact tar contains an invalid numeric field");
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value)) throw new Error("Home artifact tar numeric field is too large");
  return value;
}
