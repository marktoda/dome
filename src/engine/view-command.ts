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
import { openVaultRuntime, type VaultRuntime } from "./vault-runtime";
import { buildSqliteSinks } from "../projections/sinks";
import { withProjectionWriteLock } from "./projection-lock";

export type RuntimeViewCommandOptions = {
  readonly vaultPath: string;
  readonly bundlesRoot: string;
  readonly additionalBundlesRoots?: ReadonlyArray<string>;
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
      readonly kind: "adopted-ref-unstable";
      readonly branch: string;
    }
  | {
      readonly kind: "ok";
      readonly adopted: CommitOid;
      readonly result: RunCommandResult;
      readonly capturedViews: ReadonlyArray<ViewEffect>;
    };

export type OpenRuntimeViewCommandOptions = {
  readonly runtime: VaultRuntime;
  readonly commandName: string;
  readonly commandArgs?: unknown;
  /**
   * Optional adopted cursor for callers that already resolved it. When omitted,
   * the helper reads the current branch/adopted ref from the runtime's vault.
   */
  readonly adopted?: CommitOid;
  readonly branch?: string;
  readonly readAdoptedForBranch?: (opts: {
    readonly vaultPath: string;
    readonly branch: string;
  }) => Promise<CommitOid | null>;
};

export type OpenRuntimeViewCommandResult = Exclude<
  RuntimeViewCommandResult,
  { readonly kind: "runtime-open-failed" }
>;

export async function runRuntimeViewCommand(
  opts: RuntimeViewCommandOptions,
): Promise<RuntimeViewCommandResult> {
  const runtimeResult = await openVaultRuntime({
    vaultPath: opts.vaultPath,
    bundlesRoot: opts.bundlesRoot,
    ...(opts.additionalBundlesRoots !== undefined
      ? { additionalBundlesRoots: opts.additionalBundlesRoots }
      : {}),
  });
  if (!runtimeResult.ok) {
    return Object.freeze({
      kind: "runtime-open-failed" as const,
      errorKind: runtimeResult.error.kind,
    });
  }

  const runtime = runtimeResult.value;
  try {
    return await runViewCommandWithRuntime({
      runtime,
      commandName: opts.commandName,
      commandArgs: opts.commandArgs ?? null,
    });
  } finally {
    await runtime.close();
  }
}

export async function runViewCommandWithRuntime(
  opts: OpenRuntimeViewCommandOptions,
): Promise<OpenRuntimeViewCommandResult> {
  const branch = opts.branch ?? await getCurrentBranch(opts.runtime.path);
  if (branch === null) {
    return Object.freeze({ kind: "detached-head" as const });
  }

  const readAdoptedForBranch = opts.readAdoptedForBranch ?? adoptedForBranch;
  let adopted = opts.adopted ?? await readAdoptedForBranch({
    vaultPath: opts.runtime.path,
    branch,
  });
  if (adopted === null) {
    return Object.freeze({
      kind: "missing-adopted-ref" as const,
      branch,
    });
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await rebuildProjectionIfStale({
      runtime: opts.runtime,
      adopted,
      branch,
    });
    if (opts.adopted !== undefined) break;
    const latestAdopted = await readAdoptedForBranch({
      vaultPath: opts.runtime.path,
      branch,
    });
    if (latestAdopted === null) {
      return Object.freeze({
        kind: "missing-adopted-ref" as const,
        branch,
      });
    }
    if (latestAdopted === adopted) break;
    adopted = latestAdopted;
    if (attempt === 2) {
      return Object.freeze({
        kind: "adopted-ref-unstable" as const,
        branch,
      });
    }
  }

  const capturedViews: ViewEffect[] = [];
  const sinks = buildViewCommandSinks({
    runtime: opts.runtime,
    adopted,
    capturedViews,
  });

  const result = await runViewCommand({
    vault: {
      path: opts.runtime.path,
      config: opts.runtime.config,
    },
    adopted,
    commandName: opts.commandName,
    commandArgs: opts.commandArgs ?? null,
    viewRunner: opts.runtime.processorRuntime.viewRunner,
    sinks,
    ledger: opts.runtime.ledgerDb,
  });

  return Object.freeze({
    kind: "ok" as const,
    adopted,
    result,
    capturedViews: Object.freeze([...capturedViews]),
  });
}

async function adoptedForBranch(opts: {
  readonly vaultPath: string;
  readonly branch: string;
}): Promise<CommitOid | null> {
  const adoptedSha = await getAdoptedRef(opts.vaultPath, opts.branch);
  return adoptedSha === null ? null : commitOid(adoptedSha);
}

function buildViewCommandSinks(opts: {
  readonly runtime: VaultRuntime;
  readonly adopted: CommitOid;
  readonly capturedViews: ViewEffect[];
}): ApplyEffectSinks {
  const captureView: ApplyEffectSinks["captureView"] = async ({ effect }) => {
    opts.capturedViews.push(effect);
  };
  const applyPatch: ApplyEffectSinks["applyPatch"] = async () => null;
  const recoverQuarantine: ApplyEffectSinks["recoverQuarantine"] =
    async () => undefined;
  const recoverRun: ApplyEffectSinks["recoverRun"] = async () => true;

  return buildSqliteSinks({
    projectionDb: opts.runtime.projectionDb,
    outboxDb: opts.runtime.outboxDb,
    adoptedCommit: opts.adopted,
    projectionWriteLock: (fn) =>
      withProjectionWriteLock(
        { vaultPath: opts.runtime.path, command: "projection-view-sink" },
        fn,
      ),
    captureView,
    applyPatch,
    externalHandlers: opts.runtime.externalHandlers,
    recoverQuarantine,
    recoverRun,
  });
}
