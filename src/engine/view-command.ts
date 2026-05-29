// Engine-owned runtime boundary for command-triggered view processors.
//
// CLI, MCP, HTTP, and future surfaces all need the same ceremony before a
// view command can run: open the vault runtime, resolve the adopted commit,
// rebuild stale projections, capture ViewEffects, and dispatch the command
// through the processor runtime. Surface adapters own argument parsing and
// rendering; this module owns the shared runtime semantics.

import { getAdoptedRef, getCurrentBranch } from "../adopted-ref";
import type { ViewEffect } from "../core/effect";
import { commitOid, type CommitOid } from "../core/source-ref";
import type { ApplyEffectSinks } from "./apply-effect";
import { runViewCommand, type RunCommandResult } from "./commands";
import { rebuildProjectionIfStale } from "./compiler-host";
import { openVaultRuntime } from "./vault-runtime";
import { buildSqliteSinks } from "../projections/sinks";

export type RuntimeViewCommandOptions = {
  readonly vaultPath: string;
  readonly bundlesRoot: string;
  readonly commandName: string;
  readonly commandArgs?: unknown;
};

export type RuntimeViewCommandResult =
  | { readonly kind: "detached-head" }
  | {
      readonly kind: "missing-adopted-ref";
      readonly branch: string;
    }
  | {
      readonly kind: "runtime-open-failed";
      readonly errorKind: string;
    }
  | {
      readonly kind: "ok";
      readonly adopted: CommitOid;
      readonly result: RunCommandResult;
      readonly capturedViews: ReadonlyArray<ViewEffect>;
    };

export async function runRuntimeViewCommand(
  opts: RuntimeViewCommandOptions,
): Promise<RuntimeViewCommandResult> {
  const branch = await getCurrentBranch(opts.vaultPath);
  if (branch === null) {
    return Object.freeze({ kind: "detached-head" as const });
  }

  const adoptedSha = await getAdoptedRef(opts.vaultPath, branch);
  if (adoptedSha === null) {
    return Object.freeze({
      kind: "missing-adopted-ref" as const,
      branch,
    });
  }
  const adopted = commitOid(adoptedSha);

  const runtimeResult = await openVaultRuntime({
    vaultPath: opts.vaultPath,
    bundlesRoot: opts.bundlesRoot,
  });
  if (!runtimeResult.ok) {
    return Object.freeze({
      kind: "runtime-open-failed" as const,
      errorKind: runtimeResult.error.kind,
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
    const recoverRun: ApplyEffectSinks["recoverRun"] = async () => true;
    const sinks = buildSqliteSinks({
      projectionDb: runtime.projectionDb,
      outboxDb: runtime.outboxDb,
      adoptedCommit: adopted,
      captureView,
      applyPatch,
      externalHandlers: runtime.externalHandlers,
      recoverQuarantine,
      recoverRun,
    });

    const result = await runViewCommand({
      vault: {
        path: opts.vaultPath,
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
      adopted,
      result,
      capturedViews: Object.freeze([...capturedViews]),
    });
  } finally {
    await runtime.close();
  }
}
