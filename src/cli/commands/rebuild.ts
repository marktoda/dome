// cli/commands/rebuild: rebuild projection.db from the adopted commit.

import { resolve } from "node:path";

import { getAdoptedRef, getCurrentBranch } from "../../adopted-ref";
import { commitOid } from "../../core/source-ref";
import { rebuildProjection } from "../../engine/projection-rebuild";
import { openVaultRuntime } from "../../engine/vault-runtime";
import { formatJson } from "../format";
import {
  formatHeadline,
  formatShortOid,
  formatSummaryRows,
  pushSection,
} from "../human-output";
import { resolveBundleRoots } from "./sync-shared";

export type RunRebuildOptions = {
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly json?: boolean | undefined;
};

type RebuildJsonResult =
  | {
      readonly schema: "dome.rebuild/v1";
      readonly status: "rebuilt";
      readonly branch: string;
      readonly adopted: string;
      readonly files: number;
      readonly processors: number;
      readonly effects: number;
    }
  | {
      readonly schema: "dome.rebuild/v1";
      readonly status: "error";
      readonly branch: string | null;
      readonly adopted: string | null;
      readonly error: string;
    };

export async function runRebuild(
  options: RunRebuildOptions = {},
): Promise<number> {
  const vaultPath = resolve(options.vault ?? process.cwd());
  const bundleRoots = resolveBundleRoots({
    vaultPath,
    bundlesRoot: options.bundlesRoot,
  });
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

  const runtimeResult = await openVaultRuntime({ vaultPath, ...bundleRoots });
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
    const result = await rebuildProjection({
      runtime,
      adopted: commitOid(adopted),
      branch,
    });
    if (jsonMode) {
      const payload: RebuildJsonResult = {
        schema: "dome.rebuild/v1",
        status: "rebuilt",
        branch,
        adopted,
        files: result.fileCount,
        processors: result.processorCount,
        effects: result.effectCount,
      };
      console.log(formatJson(payload));
    } else {
      printRebuildText({
        branch,
        adopted,
        files: result.fileCount,
        processors: result.processorCount,
        effects: result.effectCount,
      });
    }
    return 0;
  } finally {
    await runtime.close();
  }
}

function printRebuildText(result: {
  readonly branch: string;
  readonly adopted: string;
  readonly files: number;
  readonly processors: number;
  readonly effects: number;
}): void {
  const lines = [formatHeadline("Dome rebuild", "rebuilt")];
  pushSection(lines, "Summary", formatSummaryRows([
    ["branch", result.branch],
    ["adopted", formatShortOid(result.adopted)],
    ["files", String(result.files)],
    ["processors", String(result.processors)],
    ["effects", String(result.effects)],
  ]));
  console.log(lines.join("\n"));
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
      schema: "dome.rebuild/v1",
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
