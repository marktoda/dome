// cli/commands/rebuild: rebuild projection.db from the adopted commit.

import { resolve } from "node:path";

import { getAdoptedRef, getCurrentBranch } from "../../adopted-ref";
import { commitOid } from "../../core/source-ref";
import { rebuildProjection } from "../../engine/projection-rebuild";
import { openVaultRuntime } from "../../engine/vault-runtime";
import { formatJson } from "../format";
import { resolveShippedBundlesRoot } from "./sync-shared";

export type RunRebuildOptions = {
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly json?: boolean | undefined;
};

type RebuildJsonResult =
  | {
      readonly status: "rebuilt";
      readonly branch: string;
      readonly adopted: string;
      readonly files: number;
      readonly processors: number;
      readonly effects: number;
    }
  | {
      readonly status: "error";
      readonly branch: string | null;
      readonly adopted: string | null;
      readonly error: string;
    };

export async function runRebuild(
  options: RunRebuildOptions = {},
): Promise<number> {
  const vaultPath = resolve(options.vault ?? process.cwd());
  const bundlesRoot = options.bundlesRoot ?? resolveShippedBundlesRoot();
  const jsonMode = options.json === true;

  const branch = await getCurrentBranch(vaultPath);
  if (branch === null) {
    return emitError({
      jsonMode,
      branch: null,
      adopted: null,
      error: "detached-head",
      message:
        `dome rebuild: HEAD is detached at ${vaultPath}. ` +
        "Check out a branch and retry.",
    });
  }

  const adopted = await getAdoptedRef(vaultPath, branch);
  if (adopted === null) {
    return emitError({
      jsonMode,
      branch,
      adopted: null,
      error: "adopted-ref-uninitialized",
      message: `dome rebuild: adopted ref for ${branch} is uninitialized. Run \`dome sync\` first.`,
    });
  }

  const runtimeResult = await openVaultRuntime({ vaultPath, bundlesRoot });
  if (!runtimeResult.ok) {
    return emitError({
      jsonMode,
      branch,
      adopted,
      error: runtimeResult.error.kind,
      message:
        `dome rebuild: openVaultRuntime failed (${runtimeResult.error.kind}). ` +
        "Run `dome init` to initialize the vault.",
    });
  }

  const runtime = runtimeResult.value;
  try {
    if (!jsonMode) {
      console.log(
        `dome rebuild: rebuilding projection.db from adopted commit ${adopted.slice(0, 7)}...`,
      );
    }
    const result = await rebuildProjection({
      runtime,
      adopted: commitOid(adopted),
      branch,
    });
    if (jsonMode) {
      const payload: RebuildJsonResult = {
        status: "rebuilt",
        branch,
        adopted,
        files: result.fileCount,
        processors: result.processorCount,
        effects: result.effectCount,
      };
      console.log(formatJson(payload));
    } else {
      console.log(
        `dome rebuild: done (${result.fileCount} files, ` +
          `${result.processorCount} processors, ${result.effectCount} effects)`,
      );
    }
    return 0;
  } finally {
    await runtime.close();
  }
}

function emitError(opts: {
  readonly jsonMode: boolean;
  readonly branch: string | null;
  readonly adopted: string | null;
  readonly error: string;
  readonly message: string;
}): number {
  if (opts.jsonMode) {
    const payload: RebuildJsonResult = {
      status: "error",
      branch: opts.branch,
      adopted: opts.adopted,
      error: opts.error,
    };
    console.log(formatJson(payload));
  } else {
    console.error(opts.message);
  }
  return opts.error === "detached-head" || opts.error === "adopted-ref-uninitialized"
    ? 64
    : 1;
}
