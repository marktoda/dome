// macOS filesystem publication boundary. renamex_np(RENAME_EXCL) provides the
// no-replace atomicity that Node's rename API cannot express.

import { dlopen, FFIType } from "bun:ffi";

const RENAME_EXCL = 0x4;

export async function publishPathExclusive(input: {
  readonly source: string;
  readonly target: string;
  readonly platform?: NodeJS.Platform;
}): Promise<void> {
  if ((input.platform ?? process.platform) !== "darwin") {
    throw new Error("exclusive path publication is currently supported only on macOS");
  }

  const library = dlopen("/usr/lib/libSystem.B.dylib", {
    renamex_np: {
      args: [FFIType.cstring, FFIType.cstring, FFIType.uint32_t],
      returns: FFIType.int32_t,
    },
  });
  try {
    const source = Buffer.from(`${input.source}\0`);
    const target = Buffer.from(`${input.target}\0`);
    const result = library.symbols.renamex_np(source, target, RENAME_EXCL);
    if (result !== 0) {
      throw new Error(`exclusive publication failed; target may already exist: ${input.target}`);
    }
  } finally {
    library.close();
  }
}

/** Compatibility name for existing directory publishers. */
export const publishDirectoryExclusive = publishPathExclusive;
