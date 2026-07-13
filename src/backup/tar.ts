import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { compareStrings } from "../core/compare";

export type TarEntry = {
  readonly path: string;
  readonly type: "file" | "directory";
  readonly mode: number;
  readonly size: number;
  readonly sha256?: string;
};

const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024 * 1024;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_ENTRIES = 1_000_000;

/** Write a normalized ustar archive without buffering file bodies in memory. */
export async function writeTarTree(root: string, output: string): Promise<ReadonlyArray<TarEntry>> {
  const paths = await treePaths(root);
  const handle = await open(output, "wx", 0o600);
  const inventory: TarEntry[] = [];
  try {
    for (const path of paths) {
      const absolute = join(root, path);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`backup payload contains a symlink: ${path}`);
      if (!info.isDirectory() && !info.isFile()) throw new Error(`backup payload contains an unsupported entry: ${path}`);
      const type = info.isDirectory() ? "directory" : "file";
      const archivePath = `${path}${type === "directory" ? "/" : ""}`;
      await writeAll(handle, tarHeader(archivePath, info.mode & 0o777, type === "file" ? info.size : 0, type));
      if (type === "directory") {
        inventory.push(Object.freeze({ path, type, mode: info.mode & 0o777, size: 0 }));
        continue;
      }
      const input = await open(absolute, "r");
      const hash = createHash("sha256");
      let offset = 0;
      try {
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let remaining = info.size;
        while (remaining > 0) {
          const length = Math.min(buffer.length, remaining);
          await readExact(input, buffer, 0, length, offset, `backup source is truncated while archiving: ${path}`);
          const chunk = buffer.subarray(0, length);
          hash.update(chunk);
          await writeAll(handle, chunk);
          offset += length;
          remaining -= length;
        }
        if (offset !== info.size || (await input.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0) {
          throw new Error(`backup source size changed while archiving: ${path}`);
        }
      } finally {
        await input.close();
      }
      const after = await lstat(absolute);
      if (!after.isFile() || after.size !== info.size || after.mtimeMs !== info.mtimeMs) {
        throw new Error(`backup source changed while archiving: ${path}`);
      }
      const remainder = info.size % 512;
      if (remainder !== 0) await writeAll(handle, Buffer.alloc(512 - remainder));
      inventory.push(Object.freeze({
        path,
        type,
        mode: info.mode & 0o777,
        size: info.size,
        sha256: hash.digest("hex"),
      }));
    }
    await writeAll(handle, Buffer.alloc(1024));
    await handle.sync();
  } finally {
    await handle.close();
  }
  return Object.freeze(inventory);
}

/** Parse and authenticate the logical shape of a ustar archive. No extraction. */
export async function inspectTar(input: string): Promise<ReadonlyArray<TarEntry>> {
  const archiveInfo = await lstat(input);
  if (!archiveInfo.isFile() || archiveInfo.size > MAX_ARCHIVE_BYTES) throw new Error("backup archive exceeds the verification size budget");
  const handle = await open(input, "r");
  const entries: TarEntry[] = [];
  const seen = new Set<string>();
  let offset = 0;
  try {
    for (;;) {
      const header = Buffer.alloc(512);
      await readExact(handle, header, 0, 512, offset, "backup archive is truncated");
      offset += 512;
      if (header.every((byte) => byte === 0)) {
        await requireArchiveEnd(handle, offset);
        break;
      }
      validateHeaderChecksum(header);
      validateUstar(header);
      const typeFlag = header[156];
      if (typeFlag !== 0x30 && typeFlag !== 0x35 && typeFlag !== 0) {
        throw new Error("backup archive contains an unsupported tar entry type");
      }
      const name = stringField(header, 0, 100);
      const prefix = stringField(header, 345, 155);
      const rawPath = prefix === "" ? name : `${prefix}/${name}`;
      const type = typeFlag === 0x35 ? "directory" : "file";
      const path = validateArchivePath(type === "directory" && rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath);
      if (seen.has(path)) throw new Error(`backup archive contains duplicate entry: ${path}`);
      seen.add(path);
      if (seen.size > MAX_ENTRIES) throw new Error("backup archive exceeds the entry-count limit");
      const mode = octalField(header, 100, 8);
      const size = octalField(header, 124, 12);
      if (size > MAX_ENTRY_BYTES) throw new Error(`backup archive entry exceeds the size budget: ${path}`);
      if (type === "directory" && size !== 0) throw new Error(`backup directory has a body: ${path}`);
      let sha256: string | undefined;
      if (type === "file") {
        const hash = createHash("sha256");
        let remaining = size;
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        while (remaining > 0) {
          const length = Math.min(remaining, buffer.length);
          await readExact(handle, buffer, 0, length, offset, `backup archive body is truncated: ${path}`);
          hash.update(buffer.subarray(0, length));
          offset += length;
          remaining -= length;
        }
        sha256 = hash.digest("hex");
      }
      offset = await consumeZeroPadding(handle, offset, size, path);
      entries.push(Object.freeze({ path, type, mode, size, ...(sha256 === undefined ? {} : { sha256 }) }));
    }
  } finally {
    await handle.close();
  }
  return Object.freeze(entries);
}

/**
 * Strict single-pass extraction. The archive handle is opened exactly once;
 * each body is streamed directly to an exclusive destination file while the
 * same traversal validates path, type, header, checksum, padding, and EOF.
 */
export async function extractTarTree(
  input: string,
  destination: string,
  deps: { readonly openArchive?: typeof open } = {},
): Promise<ReadonlyArray<TarEntry>> {
  const archiveInfo = await lstat(input);
  if (!archiveInfo.isFile() || archiveInfo.size > MAX_ARCHIVE_BYTES) throw new Error("backup archive exceeds the extraction size budget");
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const handle = await (deps.openArchive ?? open)(input, "r");
  const entries: TarEntry[] = [];
  const seen = new Set<string>();
  let offset = 0;
  try {
    for (;;) {
      const header = Buffer.alloc(512);
      await readExact(handle, header, 0, 512, offset, "backup archive is truncated");
      offset += 512;
      if (header.every((byte) => byte === 0)) { await requireArchiveEnd(handle, offset); break; }
      validateHeaderChecksum(header);
      validateUstar(header);
      const typeFlag = header[156];
      if (typeFlag !== 0x30 && typeFlag !== 0x35 && typeFlag !== 0) throw new Error("backup archive contains an unsupported tar entry type");
      const name = stringField(header, 0, 100);
      const prefix = stringField(header, 345, 155);
      const rawPath = prefix === "" ? name : `${prefix}/${name}`;
      const type = typeFlag === 0x35 ? "directory" : "file";
      const path = validateArchivePath(type === "directory" && rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath);
      if (seen.has(path)) throw new Error(`backup archive contains duplicate entry: ${path}`);
      seen.add(path);
      if (seen.size > MAX_ENTRIES) throw new Error("backup archive exceeds the entry-count limit");
      const mode = octalField(header, 100, 8);
      const size = octalField(header, 124, 12);
      if (size > MAX_ENTRY_BYTES) throw new Error(`backup archive entry exceeds the size budget: ${path}`);
      const target = join(destination, ...path.split("/"));
      if (type === "directory") {
        if (size !== 0) throw new Error(`backup directory has a body: ${path}`);
        await mkdir(target, { recursive: true, mode });
        await chmod(target, mode);
        entries.push(Object.freeze({ path, type, mode, size: 0 }));
        continue;
      }
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const output = await open(target, "wx", mode);
      const hash = createHash("sha256");
      try {
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let remaining = size;
        while (remaining > 0) {
          const length = Math.min(remaining, buffer.length);
          await readExact(handle, buffer, 0, length, offset, `backup archive body is truncated: ${path}`);
          const chunk = buffer.subarray(0, length);
          hash.update(chunk);
          await writeAll(output, chunk);
          offset += length;
          remaining -= length;
        }
        await output.sync();
      } finally { await output.close(); }
      await chmod(target, mode);
      offset = await consumeZeroPadding(handle, offset, size, path);
      entries.push(Object.freeze({ path, type, mode, size, sha256: hash.digest("hex") }));
    }
  } finally { await handle.close(); }
  return Object.freeze(entries);
}

export async function readTarFile(input: string, wantedPath: string, maxBytes = 4 * 1024 * 1024): Promise<Buffer> {
  const handle = await open(input, "r");
  let offset = 0;
  try {
    for (;;) {
      const header = Buffer.alloc(512);
      await readExact(handle, header, 0, 512, offset, "backup archive is truncated");
      offset += 512;
      if (header.every((byte) => byte === 0)) {
        await requireArchiveEnd(handle, offset);
        break;
      }
      validateHeaderChecksum(header);
      validateUstar(header);
      const name = stringField(header, 0, 100);
      const prefix = stringField(header, 345, 155);
      const rawPath = prefix === "" ? name : `${prefix}/${name}`;
      const path = validateArchivePath(rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath);
      const size = octalField(header, 124, 12);
      if (path === wantedPath) {
        if (size > maxBytes) throw new Error(`${wantedPath} exceeds the verification limit`);
        const body = Buffer.alloc(size);
        await readExact(handle, body, 0, size, offset, `backup archive body is truncated: ${path}`);
        return body;
      }
      offset += size;
      offset = await consumeZeroPadding(handle, offset, size, path);
    }
  } finally {
    await handle.close();
  }
  throw new Error(`backup archive is missing ${wantedPath}`);
}

/** Stream one already-validated regular entry to a private exclusive file. */
export async function extractTarFile(input: string, wantedPath: string, output: string, maxBytes = MAX_ENTRY_BYTES): Promise<void> {
  const handle = await open(input, "r");
  let offset = 0;
  try {
    for (;;) {
      const header = Buffer.alloc(512);
      await readExact(handle, header, 0, 512, offset, "backup archive is truncated");
      offset += 512;
      if (header.every((byte) => byte === 0)) { await requireArchiveEnd(handle, offset); break; }
      validateHeaderChecksum(header);
      validateUstar(header);
      const name = stringField(header, 0, 100);
      const prefix = stringField(header, 345, 155);
      const rawPath = prefix === "" ? name : `${prefix}/${name}`;
      const path = validateArchivePath(rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath);
      const size = octalField(header, 124, 12);
      if (path === wantedPath) {
        if (header[156] !== 0x30 && header[156] !== 0) throw new Error(`${wantedPath} is not a regular file`);
        if (size > maxBytes) throw new Error(`${wantedPath} exceeds the extraction size budget`);
        const destination = await open(output, "wx", 0o600);
        try {
          const buffer = Buffer.allocUnsafe(1024 * 1024);
          let remaining = size;
          while (remaining > 0) {
            const length = Math.min(remaining, buffer.length);
            await readExact(handle, buffer, 0, length, offset, `backup archive body is truncated: ${path}`);
            await writeAll(destination, buffer.subarray(0, length));
            offset += length;
            remaining -= length;
          }
          await destination.sync();
          return;
        } finally { await destination.close(); }
      }
      offset += size;
      offset = await consumeZeroPadding(handle, offset, size, path);
    }
  } finally { await handle.close(); }
  throw new Error(`backup archive is missing ${wantedPath}`);
}

async function treePaths(root: string): Promise<string[]> {
  const found: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).split(sep).join("/");
      validateArchivePath(path);
      found.push(path);
      if (entry.isDirectory()) await visit(absolute);
    }
  }
  await visit(root);
  return found.sort(compareStrings);
}

function validateArchivePath(path: string): string {
  if (path === "" || path.startsWith("/") || path.includes("\0") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`unsafe backup archive path: ${JSON.stringify(path)}`);
  }
  const resolved = resolve("/payload", path);
  if (resolved === "/payload" || !resolved.startsWith("/payload/")) throw new Error(`unsafe backup archive path: ${JSON.stringify(path)}`);
  return path;
}

function tarHeader(path: string, mode: number, size: number, type: TarEntry["type"]): Buffer {
  const header = Buffer.alloc(512);
  const split = splitTarPath(path);
  field(header, 0, 100, split.name);
  octal(header, 100, 8, mode);
  octal(header, 108, 8, 0);
  octal(header, 116, 8, 0);
  octal(header, 124, 12, size);
  octal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  field(header, 156, 1, type === "directory" ? "5" : "0");
  field(header, 257, 6, "ustar\0");
  field(header, 263, 2, "00");
  field(header, 265, 32, "root");
  field(header, 297, 32, "wheel");
  field(header, 345, 155, split.prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  field(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function splitTarPath(path: string): { readonly name: string; readonly prefix: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  for (let index = path.lastIndexOf("/"); index > 0; index = path.lastIndexOf("/", index - 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`backup path exceeds ustar limits: ${path}`);
}

function validateHeaderChecksum(header: Buffer): void {
  const expected = octalField(header, 148, 8);
  const copy = Buffer.from(header);
  copy.fill(0x20, 148, 156);
  const actual = copy.reduce((sum, byte) => sum + byte, 0);
  if (expected !== actual) throw new Error("backup archive tar header checksum is invalid");
}

function validateUstar(header: Buffer): void {
  if (!header.subarray(257, 263).equals(Buffer.from("ustar\0")) || !header.subarray(263, 265).equals(Buffer.from("00"))) {
    throw new Error("backup archive is not normalized ustar");
  }
}

async function requireArchiveEnd(handle: Awaited<ReturnType<typeof open>>, offset: number): Promise<void> {
  const second = Buffer.alloc(512);
  await readExact(handle, second, 0, 512, offset, "backup archive is missing the second zero terminator block");
  if (!second.every((byte) => byte === 0)) {
    throw new Error("backup archive is missing the second zero terminator block");
  }
  const trailing = Buffer.alloc(1);
  if ((await handle.read(trailing, 0, 1, offset + 512)).bytesRead !== 0) {
    throw new Error("backup archive contains trailing data");
  }
}

async function consumeZeroPadding(
  handle: Awaited<ReturnType<typeof open>>,
  offset: number,
  bodySize: number,
  path: string,
): Promise<number> {
  const paddingSize = (512 - (bodySize % 512)) % 512;
  if (paddingSize === 0) return offset;
  const padding = Buffer.alloc(paddingSize);
  await readExact(handle, padding, 0, paddingSize, offset, `backup archive padding is truncated: ${path}`);
  if (!padding.every((byte) => byte === 0)) throw new Error(`backup archive padding is not zero-filled: ${path}`);
  return offset + paddingSize;
}

async function readExact(
  handle: Awaited<ReturnType<typeof open>>,
  buffer: Uint8Array,
  bufferOffset: number,
  length: number,
  position: number,
  error: string,
): Promise<void> {
  let readTotal = 0;
  while (readTotal < length) {
    const read = await handle.read(buffer, bufferOffset + readTotal, length - readTotal, position + readTotal);
    if (read.bytesRead <= 0) throw new Error(error);
    readTotal += read.bytesRead;
  }
}

function stringField(buffer: Buffer, offset: number, length: number): string {
  const end = buffer.indexOf(0, offset);
  return new TextDecoder("utf-8", { fatal: true }).decode(
    buffer.subarray(offset, end === -1 || end > offset + length ? offset + length : end),
  );
}

function octalField(buffer: Buffer, offset: number, length: number): number {
  const raw = stringField(buffer, offset, length).trim().replace(/\0+$/g, "");
  if (!/^[0-7]+$/.test(raw)) throw new Error("backup archive contains an invalid numeric tar field");
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value)) throw new Error("backup archive numeric tar field exceeds the safe integer range");
  return value;
}

function field(buffer: Buffer, offset: number, length: number, value: string): void {
  const encoded = Buffer.from(value);
  if (encoded.length > length) throw new Error(`tar field exceeds ${length} bytes`);
  encoded.copy(buffer, offset);
}

function octal(buffer: Buffer, offset: number, length: number, value: number): void {
  field(buffer, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, buffer: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const written = await handle.write(buffer, offset, buffer.byteLength - offset);
    if (written.bytesWritten <= 0) throw new Error("backup archive write made no progress");
    offset += written.bytesWritten;
  }
}
