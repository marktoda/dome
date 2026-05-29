// cli/commands/view-shared: shared runtime boundary for view commands.
//
// `dome run` and first-class view command wrappers such as `dome query` all
// need the same engine-host ceremony: resolve the adopted commit, open the
// runtime, ensure projection rows are fresh for the loaded processors, build
// read-only view sinks, dispatch `runViewCommand`, and close the runtime.

import { resolve } from "node:path";

import { getAdoptedRef, getCurrentBranch } from "../../adopted-ref";
import type { ViewEffect } from "../../core/effect";
import { commitOid, type CommitOid } from "../../core/source-ref";
import type { ApplyEffectSinks } from "../../engine/apply-effect";
import { runViewCommand, type RunCommandResult } from "../../engine/commands";
import { rebuildProjectionIfStale } from "../../engine/compiler-host";
import { openVaultRuntime } from "../../engine/vault-runtime";
import { buildSqliteSinks } from "../../projections/sinks";

import { resolveShippedBundlesRoot } from "./sync-shared";

export type ViewCommandOptions = {
  readonly commandLabel: string;
  readonly commandName: string;
  readonly commandArgs?: unknown;
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
};

export type ViewCommandRunResult =
  | {
      readonly kind: "usage-error";
      readonly message: string;
    }
  | {
      readonly kind: "runtime-error";
      readonly message: string;
    }
  | {
      readonly kind: "ok";
      readonly vaultPath: string;
      readonly adopted: CommitOid;
      readonly result: RunCommandResult;
      readonly capturedViews: ReadonlyArray<ViewEffect>;
    };

export async function runSharedViewCommand(
  opts: ViewCommandOptions,
): Promise<ViewCommandRunResult> {
  const vaultPath = resolve(opts.vault ?? process.cwd());
  const bundlesRoot = opts.bundlesRoot ?? resolveShippedBundlesRoot();

  const branch = await getCurrentBranch(vaultPath);
  if (branch === null) {
    return Object.freeze({
      kind: "usage-error" as const,
      message:
        `${opts.commandLabel}: HEAD is detached. Check out a branch and retry.`,
    });
  }

  const adoptedSha = await getAdoptedRef(vaultPath, branch);
  if (adoptedSha === null) {
    return Object.freeze({
      kind: "usage-error" as const,
      message:
        `${opts.commandLabel}: vault has no adopted ref for branch '${branch}'. Run \`dome sync\` first to initialize.`,
    });
  }
  const adopted = commitOid(adoptedSha);

  const runtimeResult = await openVaultRuntime({ vaultPath, bundlesRoot });
  if (!runtimeResult.ok) {
    return Object.freeze({
      kind: "runtime-error" as const,
      message:
        `${opts.commandLabel}: openVaultRuntime failed (${runtimeResult.error.kind}). Run \`dome init\` to initialize the vault.`,
    });
  }

  const runtime = runtimeResult.value;
  try {
    await rebuildProjectionIfStale({
      runtime,
      adopted,
      branch,
    });

    const capturedViews: ViewEffect[] = [];
    const captureView: ApplyEffectSinks["captureView"] = async ({ effect }) => {
      capturedViews.push(effect);
    };
    const applyPatch: ApplyEffectSinks["applyPatch"] = async () => null;
    const recoverQuarantine: ApplyEffectSinks["recoverQuarantine"] =
      async () => undefined;
    const sinks = buildSqliteSinks({
      projectionDb: runtime.projectionDb,
      outboxDb: runtime.outboxDb,
      adoptedCommit: adopted,
      captureView,
      applyPatch,
      externalHandlers: runtime.externalHandlers,
      recoverQuarantine,
    });

    const result = await runViewCommand({
      vault: {
        path: vaultPath,
        config: { git: { auto_commit_workflows: false } },
      },
      adopted,
      commandName: opts.commandName,
      commandArgs: opts.commandArgs ?? null,
      viewRunner: runtime.processorRuntime.viewRunner,
      sinks,
      ledger: runtime.ledgerDb,
    });

    return Object.freeze({
      kind: "ok" as const,
      vaultPath,
      adopted,
      result,
      capturedViews: Object.freeze([...capturedViews]),
    });
  } finally {
    await runtime.close();
  }
}
