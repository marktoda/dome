// cli/commands/retry: explicit recovery for one scheduled garden processor.
//
// This does not widen `dome run`: command triggers remain view-only. The
// public Vault engine-control interface replays the processor's declared
// schedule trigger through the ordinary garden dispatcher without touching
// the schedule cursor.

import {
  openVaultErrorKind,
  vaultOpenFailureMessage,
} from "../../surface/adapter";
import { formatJson } from "../../surface/format";
import { resolveVaultPath } from "../../surface/resolve-vault";
import { resolveHomeModelRuntime } from "../../product-host/home-model-provider";
import { openVault } from "../../vault";
import { EX_TEMPFAIL, EX_USAGE } from "../exit-codes";

export type RetryCommandOptions = {
  readonly processorId?: string | undefined;
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly json?: boolean | undefined;
};

type RetryCommandDeps = {
  readonly resolveModel?: typeof resolveHomeModelRuntime;
  readonly open?: typeof openVault;
};

export async function runRetry(
  options: RetryCommandOptions = {},
  deps: RetryCommandDeps = {},
): Promise<number> {
  const processorId = options.processorId?.trim();
  if (processorId === undefined || processorId.length === 0) {
    console.error("dome retry: missing processor id. Usage: dome retry <processor-id>");
    return EX_USAGE;
  }

  const command = "dome retry";
  const vaultPath = resolveVaultPath(options.vault);
  // The canonical Home setup keeps the shipped provider credential in the
  // Keychain and replaces `.dome/model-provider.ts` with a closed helper at
  // runtime. Resolve that same runtime here; a generic openVault() would miss
  // the Home-managed credential and repeat the original exit-44 failure.
  const modelRuntime = await (deps.resolveModel ?? resolveHomeModelRuntime)(
    vaultPath,
  );
  const useManagedModelRuntime =
    modelRuntime.configuration === "shipped-anthropic";
  const opened = await (deps.open ?? openVault)({
    path: vaultPath,
    ...(options.bundlesRoot !== undefined
      ? { bundlesRoot: options.bundlesRoot }
      : {}),
    ...(useManagedModelRuntime && modelRuntime.modelProvider !== undefined
      ? { modelProvider: modelRuntime.modelProvider }
      : {}),
    ...(useManagedModelRuntime && modelRuntime.modelStepProvider !== undefined
      ? { modelStepProvider: modelRuntime.modelStepProvider }
      : {}),
  });
  if (!opened.ok) {
    const message = vaultOpenFailureMessage(command, opened.error);
    emit(options.json, {
      schema: "dome.retry/v1",
      status: "error",
      processorId,
      error: openVaultErrorKind(opened.error),
      message,
    }, message);
    return 1;
  }

  try {
    const vault = opened.value;
    const result = await vault.retryScheduled(processorId);
    if (result.kind === "completed") {
        const hasProblemDiagnostic = result.diagnostics.some((diagnostic) =>
          diagnostic.severity !== "info"
        );
        const status =
          result.executionStatus === "succeeded" &&
            result.subProposals.blocked === 0 &&
            !hasProblemDiagnostic
          ? "succeeded"
          : "failed";
        const message = status === "succeeded"
          ? `Retried ${processorId}.`
          : `Retry of ${processorId} finished with ${result.executionStatus}.`;
        emit(options.json, {
          schema: "dome.retry/v1",
          status,
          processorId,
          runId: result.runId,
          executionStatus: result.executionStatus,
          executionError: result.executionError,
          adoptedRef: result.adopted,
          routing: result.routing,
          subProposals: result.subProposals,
          diagnostics: result.diagnostics,
        }, message);
        return status === "succeeded" ? 0 : 1;
    }

    if (result.kind === "busy") {
        const message =
          `dome retry: ${result.branch} is already being processed; retry shortly.`;
        emit(options.json, {
          schema: "dome.retry/v1",
          status: "busy",
          processorId,
          error: "compiler-host-busy",
          message,
        }, message);
        return EX_TEMPFAIL;
    }

    if (result.kind === "branch-changed") {
        const message =
          `dome retry: the checked-out branch changed to ${result.branch}; retry.`;
        emit(options.json, {
          schema: "dome.retry/v1",
          status: "busy",
          processorId,
          error: "branch-changed",
          message,
        }, message);
        return EX_TEMPFAIL;
    }

    let error: string;
    let message: string;
    let exitCode = EX_USAGE;
    switch (result.kind) {
        case "not-found":
          error = "processor-not-found";
          message = `dome retry: no installed processor named '${processorId}'.`;
          break;
        case "not-scheduled-garden":
          error = "not-scheduled-garden";
          message =
            `dome retry: '${processorId}' is not a schedule-triggered garden processor. ` +
            "Use `dome run <name>` only for command-triggered views.";
          break;
        case "sync-needed":
          error = "sync-needed";
          message = "dome retry: adopt pending vault changes with `dome sync`, then retry.";
          exitCode = 1;
          break;
        case "diverged":
          error = "adopted-ref-diverged";
          message = "dome retry: adopted history diverged; inspect and run `dome reanchor` before retrying.";
          exitCode = 1;
          break;
        case "detached-head":
          error = "detached-head";
          message = "dome retry: HEAD is detached; check out a branch first.";
          break;
        case "no-commits":
          error = "no-commits";
          message = "dome retry: the vault has no commits to run against.";
          break;
    }
    emit(options.json, {
        schema: "dome.retry/v1",
        status: "error",
        processorId,
        error,
        message,
    }, message);
    return exitCode;
  } finally {
    await opened.value.close();
  }
}

function emit(
  json: boolean | undefined,
  payload: Readonly<Record<string, unknown>>,
  message: string,
): void {
  if (json === true) console.log(formatJson(payload));
  else if (payload.status === "succeeded") console.log(message);
  else console.error(message);
}
