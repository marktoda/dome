import { constants, type BigIntStats } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { dlopen, FFIType, ptr, read } from "bun:ffi";
import { assertSupportedSetupHost } from "./platform";

export type AnchoredFilesystemMutation =
  | "create-exclusive"
  | "link-exclusive"
  | "unlink"
  | "directory-created";
export type AnchoredFilesystemMutationHook = (
  operation: AnchoredFilesystemMutation,
  relativePath: string,
) => Promise<void>;

export type AnchoredRegularFile = Readonly<{
  body: string;
  mode: number;
  dev: bigint;
  ino: bigint;
  nlink: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;

type HeldDirectory = Readonly<{
  fd: number;
  parentFd: number | null;
  name: string | null;
  proof: BigIntStats;
}>;

type NativeOps = ReturnType<typeof nativeOps>;

/**
 * A kernel-relative filesystem Module for setup publication. It opens every
 * directory component with O_NOFOLLOW, holds the resulting descriptors, and
 * performs final-name operations relative to the held parent. Namespace races
 * can make a name stop referring to a held directory, but cannot redirect an
 * operation through a replacement symlink.
 */
export class AnchoredVaultFiles {
  private closed = false;

  private constructor(
    private readonly native: NativeOps,
    private readonly vaultChain: ReadonlyArray<HeldDirectory>,
    private readonly filesystemRoot: Awaited<ReturnType<typeof open>>,
    private readonly beforeFinalMutation?: AnchoredFilesystemMutationHook | undefined,
  ) {}

  static async open(
    root: string,
    options: Readonly<{ beforeFinalMutation?: AnchoredFilesystemMutationHook | undefined }> = {},
  ): Promise<AnchoredVaultFiles> {
    const absolute = resolve(root);
    if (!isAbsolute(absolute)) throw new Error("anchored vault root must be absolute");
    assertSupportedSetupHost();
    const native = nativeOps();
    let filesystemRoot: Awaited<ReturnType<typeof open>>;
    try {
      filesystemRoot = await open("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    } catch (error) {
      native.dispose();
      throw error;
    }
    const chain: HeldDirectory[] = [];
    const opened: number[] = [];
    try {
      const firstProof = await filesystemRoot.stat({ bigint: true });
      chain.push({ fd: filesystemRoot.fd, parentFd: null, name: null, proof: firstProof });
      for (const name of segments(absolute)) {
        const parent = chain.at(-1)!;
        const fd = native.openDirectory(parent.fd, name);
        if (fd === null) throw new Error(`setup cannot bind direct directory ${name} in ${absolute}`);
        opened.push(fd);
        chain.push({
          fd,
          parentFd: parent.fd,
          name,
          proof: await statFd(fd),
        });
      }
      const files = new AnchoredVaultFiles(native, chain, filesystemRoot, options.beforeFinalMutation);
      await files.revalidate(chain);
      return files;
    } catch (error) {
      for (const fd of opened.reverse()) native.close(fd);
      try { await filesystemRoot.close(); }
      catch { /* Preserve admission failure while still disposing FFI. */ }
      finally { native.dispose(); }
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    let failure: unknown;
    try {
      for (const held of this.vaultChain.slice(1).reverse()) {
        try { this.native.close(held.fd); } catch (error) { failure ??= error; }
      }
      try { await this.filesystemRoot.close(); } catch (error) { failure ??= error; }
    } finally {
      this.native.dispose();
    }
    if (failure !== undefined) throw failure;
  }

  async ensureDirectory(relativePath: string, mode: number, exactLeaf = false): Promise<void> {
    const names = relativeSegments(relativePath);
    let chain = [...this.vaultChain];
    const opened: number[] = [];
    try {
      for (const [index, name] of names.entries()) {
        const parent = chain.at(-1)!;
        let fd = this.native.openDirectory(parent.fd, name);
        let created = false;
        if (fd === null) {
          if (!this.native.mkdir(parent.fd, name, mode)) {
            fd = this.native.openDirectory(parent.fd, name);
            if (fd === null) throw new Error(`setup directory collision at ${relativePath}`);
          } else {
            fd = this.native.openDirectory(parent.fd, name);
            if (fd === null) throw new Error(`setup could not bind created directory ${relativePath}`);
            created = true;
          }
        }
        opened.push(fd);
        if (created && this.beforeFinalMutation !== undefined) {
          await this.beforeFinalMutation("directory-created", relativePath);
        }
        if (created || (exactLeaf && index === names.length - 1)) {
          this.native.chmod(fd, mode);
        }
        this.native.sync(fd);
        this.native.sync(parent.fd);
        chain.push({ fd, parentFd: parent.fd, name, proof: await statFd(fd) });
      }
      await this.revalidate(chain);
    } finally {
      for (const fd of opened.reverse()) this.native.close(fd);
    }
  }

  async readRegular(
    relativePath: string,
    options: Readonly<{ maxBytes?: number | undefined }> = {},
  ): Promise<AnchoredRegularFile | null> {
    return this.withParent(relativePath, async (parent, name, chain) => {
      const fd = this.native.openFile(parent.fd, name, constants.O_RDONLY | constants.O_NOFOLLOW, 0);
      if (fd === null) return null;
      try {
        const handle = await open(fdPath(fd), constants.O_RDONLY);
        try {
          const before = await handle.stat({ bigint: true });
          if (!before.isFile()) throw new Error(`setup requires a direct regular file at ${relativePath}`);
          const maxBytes = options.maxBytes;
          if (maxBytes !== undefined &&
            (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || before.size > BigInt(maxBytes))) {
            throw new Error(`setup direct regular file exceeds the admitted size at ${relativePath}`);
          }
          const body = maxBytes === undefined
            ? await handle.readFile("utf8")
            : await readUtf8Bounded(handle, maxBytes, relativePath);
          const after = await handle.stat({ bigint: true });
          if (!sameProof(before, after)) throw new Error(`setup detected a concurrent read of ${relativePath}`);
          await this.revalidate(chain);
          return Object.freeze({
            body,
            mode: Number(after.mode) & 0o777,
            dev: after.dev,
            ino: after.ino,
            nlink: after.nlink,
            size: after.size,
            mtimeNs: after.mtimeNs,
            ctimeNs: after.ctimeNs,
          });
        } finally { await handle.close(); }
      } finally { this.native.close(fd); }
    });
  }

  async createExclusive(relativePath: string, body: string, mode: number): Promise<void> {
    await this.withParent(relativePath, async (parent, name, chain) => {
      if (this.beforeFinalMutation !== undefined) {
        await this.beforeFinalMutation("create-exclusive", relativePath);
      }
      const fd = this.native.openFile(
        parent.fd,
        name,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        mode,
      );
      if (fd === null) throw new Error(`setup exclusive create collision at ${relativePath}`);
      try {
        this.native.write(fd, Buffer.from(body, "utf8"));
        this.native.chmod(fd, mode);
        this.native.sync(fd);
      } finally { this.native.close(fd); }
      await this.revalidate(chain);
    });
  }

  async linkExclusive(source: string, destination: string): Promise<void> {
    await this.withParent(source, async (sourceParent, sourceName, sourceChain) => {
      await this.withParent(destination, async (destinationParent, destinationName, destinationChain) => {
        if (this.beforeFinalMutation !== undefined) {
          await this.beforeFinalMutation("link-exclusive", destination);
        }
        if (!this.native.link(
          sourceParent.fd,
          sourceName,
          destinationParent.fd,
          destinationName,
        )) {
          throw new Error(`setup refused concurrent publication of ${destination}`);
        }
        await this.revalidate(sourceChain);
        await this.revalidate(destinationChain);
      });
    });
  }

  async unlink(relativePath: string): Promise<void> {
    await this.withParent(relativePath, async (parent, name, chain) => {
      if (this.beforeFinalMutation !== undefined) {
        await this.beforeFinalMutation("unlink", relativePath);
      }
      const removed = this.native.unlink(parent.fd, name);
      if (!removed.ok && removed.errno !== ERRNO_ENOENT) {
        throw new Error(`setup could not remove ${relativePath} (errno ${removed.errno})`);
      }
      await this.revalidate(chain);
    });
  }

  async syncParent(relativePath: string): Promise<void> {
    await this.withParent(relativePath, async (parent, _name, chain) => {
      this.native.sync(parent.fd);
      await this.revalidate(chain);
    });
  }

  private async withParent<T>(
    relativePath: string,
    callback: (parent: HeldDirectory, name: string, chain: ReadonlyArray<HeldDirectory>) => Promise<T>,
  ): Promise<T> {
    const names = relativeSegments(relativePath);
    const finalName = names.pop()!;
    const chain = [...this.vaultChain];
    try {
      for (const name of names) {
        const parent = chain.at(-1)!;
        const fd = this.native.openDirectory(parent.fd, name);
        if (fd === null) throw new Error(`setup parent directory is not direct: ${relativePath}`);
        chain.push({ fd, parentFd: parent.fd, name, proof: await statFd(fd) });
      }
      await this.revalidate(chain);
      return await callback(chain.at(-1)!, finalName, chain);
    } finally {
      for (const held of chain.slice(this.vaultChain.length).reverse()) this.native.close(held.fd);
    }
  }

  private async revalidate(chain: ReadonlyArray<HeldDirectory>): Promise<void> {
    for (const held of chain.slice(1)) {
      const reopened = this.native.openDirectory(held.parentFd!, held.name!);
      if (reopened === null) throw new Error("setup directory identity changed during publication");
      try {
        if (!sameIdentity(held.proof, await statFd(reopened))) {
          throw new Error("setup directory identity changed during publication");
        }
      } finally { this.native.close(reopened); }
    }
  }
}

async function readUtf8Bounded(
  handle: Awaited<ReturnType<typeof open>>,
  maxBytes: number,
  relativePath: string,
): Promise<string> {
  const bytes = Buffer.alloc(maxBytes + 1);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > maxBytes) {
    throw new Error(`setup direct regular file exceeds the admitted size at ${relativePath}`);
  }
  return bytes.subarray(0, offset).toString("utf8");
}

function nativeOps() {
  assertSupportedSetupHost();
  const darwin = process.platform === "darwin";
  const commonSymbols = {
    openat: { args: [FFIType.int32_t, FFIType.cstring, FFIType.int32_t, FFIType.uint32_t], returns: FFIType.int32_t },
    mkdirat: { args: [FFIType.int32_t, FFIType.cstring, FFIType.uint32_t], returns: FFIType.int32_t },
    linkat: { args: [FFIType.int32_t, FFIType.cstring, FFIType.int32_t, FFIType.cstring, FFIType.int32_t], returns: FFIType.int32_t },
    unlinkat: { args: [FFIType.int32_t, FFIType.cstring, FFIType.int32_t], returns: FFIType.int32_t },
    write: { args: [FFIType.int32_t, FFIType.ptr, FFIType.uint64_t], returns: FFIType.int64_t },
    fchmod: { args: [FFIType.int32_t, FFIType.uint32_t], returns: FFIType.int32_t },
    fsync: { args: [FFIType.int32_t], returns: FFIType.int32_t },
    close: { args: [FFIType.int32_t], returns: FFIType.int32_t },
  } as const;
  const library = darwin
    ? dlopen("/usr/lib/libSystem.B.dylib", {
      ...commonSymbols,
      __error: { args: [], returns: FFIType.ptr },
    })
    : dlopen("libc.so.6", {
      ...commonSymbols,
      __errno_location: { args: [], returns: FFIType.ptr },
    });
  const symbols = library.symbols as unknown as Record<string, (...args: unknown[]) => unknown>;
  const c = (value: string) => Buffer.from(`${value}\0`);
  const errno = (): number => read.i32(
    (darwin ? symbols["__error"]!() : symbols["__errno_location"]!()) as never,
  );
  return {
    openDirectory: (parent: number, name: string): number | null => {
      const fd = Number(symbols["openat"]!(parent, c(name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW, 0));
      return fd < 0 ? null : fd;
    },
    openFile: (parent: number, name: string, flags: number, mode: number): number | null => {
      const fd = Number(symbols["openat"]!(parent, c(name), flags, mode));
      return fd < 0 ? null : fd;
    },
    mkdir: (parent: number, name: string, mode: number) => Number(symbols["mkdirat"]!(parent, c(name), mode)) === 0,
    link: (from: number, fromName: string, to: number, toName: string) =>
      Number(symbols["linkat"]!(from, c(fromName), to, c(toName), 0)) === 0,
    unlink: (parent: number, name: string): NativeResult => {
      const result = Number(symbols["unlinkat"]!(parent, c(name), 0));
      return result === 0 ? { ok: true } : { ok: false, errno: errno() };
    },
    write: (fd: number, bytes: Uint8Array) => {
      let offset = 0;
      while (offset < bytes.byteLength) {
        const count = Number(symbols["write"]!(fd, ptr(bytes, offset), bytes.byteLength - offset));
        const writeErrno = count < 0 ? errno() : null;
        if (writeErrno === ERRNO_EINTR) continue;
        if (count <= 0) {
          throw new Error(
            `setup could not write exclusive publication bytes${writeErrno === null ? "" : ` (errno ${writeErrno})`}`,
          );
        }
        offset += count;
      }
    },
    chmod: (fd: number, mode: number) => {
      if (Number(symbols["fchmod"]!(fd, mode)) !== 0) {
        throw new Error(`setup could not set publication mode (errno ${errno()})`);
      }
    },
    sync: (fd: number) => {
      if (Number(symbols["fsync"]!(fd)) !== 0) {
        throw new Error(`setup could not sync publication (errno ${errno()})`);
      }
    },
    close: (fd: number) => { symbols["close"]!(fd); },
    dispose: () => library.close(),
  };
}

type NativeResult = Readonly<{ ok: true }> | Readonly<{ ok: false; errno: number }>;
const ERRNO_ENOENT = 2;
const ERRNO_EINTR = 4;

function segments(path: string): string[] {
  return path.split("/").filter((part) => part.length > 0);
}

function relativeSegments(path: string): string[] {
  if (isAbsolute(path) || path.includes("\\")) throw new Error(`setup path must be vault-relative: ${path}`);
  const names = path.split("/");
  if (names.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`setup path is not direct: ${path}`);
  }
  return names;
}

function fdPath(fd: number): string {
  return process.platform === "darwin" ? `/dev/fd/${fd}` : `/proc/self/fd/${fd}`;
}

async function statFd(fd: number): Promise<BigIntStats> {
  const handle = await open(fdPath(fd), constants.O_RDONLY);
  try { return await handle.stat({ bigint: true }); } finally { await handle.close(); }
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function sameProof(left: BigIntStats, right: BigIntStats): boolean {
  return sameIdentity(left, right) && left.nlink === right.nlink && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
