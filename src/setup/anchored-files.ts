import { constants, type BigIntStats } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { dlopen, FFIType, ptr } from "bun:ffi";

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
  private constructor(
    private readonly native: NativeOps,
    private readonly vaultChain: ReadonlyArray<HeldDirectory>,
    private readonly filesystemRoot: Awaited<ReturnType<typeof open>>,
    private readonly beforeFinalMutation?: (() => Promise<void>) | undefined,
  ) {}

  static async open(
    root: string,
    options: Readonly<{ beforeFinalMutation?: (() => Promise<void>) | undefined }> = {},
  ): Promise<AnchoredVaultFiles> {
    const absolute = resolve(root);
    if (!isAbsolute(absolute)) throw new Error("anchored vault root must be absolute");
    const native = nativeOps();
    const filesystemRoot = await open("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const firstProof = await filesystemRoot.stat({ bigint: true });
    const chain: HeldDirectory[] = [{
      fd: filesystemRoot.fd,
      parentFd: null,
      name: null,
      proof: firstProof,
    }];
    try {
      for (const name of segments(absolute)) {
        const parent = chain.at(-1)!;
        const fd = native.openDirectory(parent.fd, name);
        if (fd === null) throw new Error(`setup cannot bind direct directory ${name} in ${absolute}`);
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
      for (const held of chain.slice(1).reverse()) native.close(held.fd);
      await filesystemRoot.close();
      native.dispose();
      throw error;
    }
  }

  async close(): Promise<void> {
    for (const held of this.vaultChain.slice(1).reverse()) this.native.close(held.fd);
    await this.filesystemRoot.close();
    this.native.dispose();
  }

  async ensureDirectory(relativePath: string, mode: number): Promise<void> {
    const names = relativeSegments(relativePath);
    let chain = [...this.vaultChain];
    try {
      for (const name of names) {
        const parent = chain.at(-1)!;
        let fd = this.native.openDirectory(parent.fd, name);
        if (fd === null) {
          if (!this.native.mkdir(parent.fd, name, mode)) {
            fd = this.native.openDirectory(parent.fd, name);
            if (fd === null) throw new Error(`setup directory collision at ${relativePath}`);
          } else {
            fd = this.native.openDirectory(parent.fd, name);
            if (fd === null) throw new Error(`setup could not bind created directory ${relativePath}`);
            this.native.chmod(fd, mode);
            this.native.sync(fd);
            this.native.sync(parent.fd);
          }
        }
        chain.push({ fd, parentFd: parent.fd, name, proof: await statFd(fd) });
      }
      await this.revalidate(chain);
    } finally {
      for (const held of chain.slice(this.vaultChain.length).reverse()) this.native.close(held.fd);
    }
  }

  async readRegular(relativePath: string): Promise<AnchoredRegularFile | null> {
    return this.withParent(relativePath, async (parent, name, chain) => {
      const fd = this.native.openFile(parent.fd, name, constants.O_RDONLY | constants.O_NOFOLLOW, 0);
      if (fd === null) return null;
      try {
        const handle = await open(fdPath(fd), constants.O_RDONLY);
        try {
          const before = await handle.stat({ bigint: true });
          if (!before.isFile()) throw new Error(`setup requires a direct regular file at ${relativePath}`);
          const body = await handle.readFile("utf8");
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
      if (this.beforeFinalMutation !== undefined) await this.beforeFinalMutation();
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
    await this.withSameParent(source, destination, async (parent, sourceName, destinationName, chain) => {
      if (this.beforeFinalMutation !== undefined) await this.beforeFinalMutation();
      if (!this.native.link(parent.fd, sourceName, parent.fd, destinationName)) {
        throw new Error(`setup refused concurrent publication of ${destination}`);
      }
      await this.revalidate(chain);
    });
  }

  async rename(source: string, destination: string): Promise<void> {
    await this.withSameParent(source, destination, async (parent, sourceName, destinationName, chain) => {
      if (this.beforeFinalMutation !== undefined) await this.beforeFinalMutation();
      if (!this.native.rename(parent.fd, sourceName, parent.fd, destinationName)) {
        throw new Error(`setup could not publish ${destination}`);
      }
      await this.revalidate(chain);
    });
  }

  async unlink(relativePath: string): Promise<void> {
    await this.withParent(relativePath, async (parent, name, chain) => {
      if (!this.native.unlink(parent.fd, name)) {
        const existing = this.native.openFile(parent.fd, name, constants.O_RDONLY | constants.O_NOFOLLOW, 0);
        if (existing !== null) {
          this.native.close(existing);
          throw new Error(`setup could not remove ${relativePath}`);
        }
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

  private async withSameParent<T>(
    left: string,
    right: string,
    callback: (
      parent: HeldDirectory,
      leftName: string,
      rightName: string,
      chain: ReadonlyArray<HeldDirectory>,
    ) => Promise<T>,
  ): Promise<T> {
    const leftNames = relativeSegments(left);
    const rightNames = relativeSegments(right);
    const leftParent = leftNames.slice(0, -1).join("/");
    const rightParent = rightNames.slice(0, -1).join("/");
    if (leftParent !== rightParent) throw new Error("setup publication must stay in one directory");
    return this.withParent(left, (parent, leftName, chain) =>
      callback(parent, leftName, rightNames.at(-1)!, chain));
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

function nativeOps() {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error(`anchored setup publication is unsupported on ${process.platform}`);
  }
  const library = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    openat: { args: [FFIType.int32_t, FFIType.cstring, FFIType.int32_t, FFIType.uint32_t], returns: FFIType.int32_t },
    mkdirat: { args: [FFIType.int32_t, FFIType.cstring, FFIType.uint32_t], returns: FFIType.int32_t },
    linkat: { args: [FFIType.int32_t, FFIType.cstring, FFIType.int32_t, FFIType.cstring, FFIType.int32_t], returns: FFIType.int32_t },
    renameat: { args: [FFIType.int32_t, FFIType.cstring, FFIType.int32_t, FFIType.cstring], returns: FFIType.int32_t },
    unlinkat: { args: [FFIType.int32_t, FFIType.cstring, FFIType.int32_t], returns: FFIType.int32_t },
    write: { args: [FFIType.int32_t, FFIType.ptr, FFIType.uint64_t], returns: FFIType.int64_t },
    fchmod: { args: [FFIType.int32_t, FFIType.uint32_t], returns: FFIType.int32_t },
    fsync: { args: [FFIType.int32_t], returns: FFIType.int32_t },
    close: { args: [FFIType.int32_t], returns: FFIType.int32_t },
  });
  const c = (value: string) => Buffer.from(`${value}\0`);
  return {
    openDirectory: (parent: number, name: string): number | null => {
      const fd = Number(library.symbols.openat(parent, c(name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW, 0));
      return fd < 0 ? null : fd;
    },
    openFile: (parent: number, name: string, flags: number, mode: number): number | null => {
      const fd = Number(library.symbols.openat(parent, c(name), flags, mode));
      return fd < 0 ? null : fd;
    },
    mkdir: (parent: number, name: string, mode: number) => Number(library.symbols.mkdirat(parent, c(name), mode)) === 0,
    link: (from: number, fromName: string, to: number, toName: string) =>
      Number(library.symbols.linkat(from, c(fromName), to, c(toName), 0)) === 0,
    rename: (from: number, fromName: string, to: number, toName: string) =>
      Number(library.symbols.renameat(from, c(fromName), to, c(toName))) === 0,
    unlink: (parent: number, name: string) => Number(library.symbols.unlinkat(parent, c(name), 0)) === 0,
    write: (fd: number, bytes: Uint8Array) => {
      let offset = 0;
      let interruptedRetries = 0;
      while (offset < bytes.byteLength) {
        const count = Number(library.symbols.write(fd, ptr(bytes, offset), bytes.byteLength - offset));
        // Bun FFI does not expose errno on this supported runtime. A negative
        // result may be EINTR, so retry it within a small closed budget; hard
        // errors deterministically exhaust the same budget. A zero write can
        // never make progress and fails immediately.
        if (count < 0 && interruptedRetries < 8) {
          interruptedRetries += 1;
          continue;
        }
        if (count <= 0) throw new Error("setup could not write exclusive publication bytes");
        offset += count;
        interruptedRetries = 0;
      }
    },
    chmod: (fd: number, mode: number) => {
      if (Number(library.symbols.fchmod(fd, mode)) !== 0) throw new Error("setup could not set publication mode");
    },
    sync: (fd: number) => {
      if (Number(library.symbols.fsync(fd)) !== 0) throw new Error("setup could not sync publication");
    },
    close: (fd: number) => { library.symbols.close(fd); },
    dispose: () => library.close(),
  };
}

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
