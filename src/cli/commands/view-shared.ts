// cli/commands/view-shared: CLI helpers for view commands.
//
// `dome run` and first-class view command wrappers such as `dome query` all
// share error translation, structured-view validation, and message printing.
// Runtime opening and view dispatch live in `src/engine/view-command.ts` so
// future non-CLI surfaces can reuse the same command boundary.

import { resolve } from "node:path";

import type {
  DiagnosticEffect,
  ViewContent,
  ViewEffect,
} from "../../core/effect";
import type { CommitOid } from "../../core/source-ref";
import type { RunCommandResult } from "../../engine/commands";
import { runRuntimeViewCommand } from "../../engine/view-command";

import { resolveBundleRoots } from "./sync-shared";

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

export type StructuredViewCommandOptions = ViewCommandOptions & {
  readonly expectedViewName: string;
  readonly expectedSchema: string;
  readonly notFoundMessage: string;
  readonly noStructuredResultMessage: string;
};

export type StructuredViewCommandResult =
  | {
      readonly kind: "ok";
      readonly data: unknown;
      readonly view: StructuredViewEffect;
      readonly brokerDiagnostics: ReadonlyArray<DiagnosticEffect>;
    }
  | {
      readonly kind: "error";
      readonly exitCode: number;
      readonly messages: ReadonlyArray<string>;
    };

const OLD_FIRST_PARTY_CONFIG_HINT =
  "For older vault configs, run `dome init --refresh-config` to add current first-party defaults.";

export function firstPartyViewNotFoundMessage(opts: {
  readonly commandLabel: string;
  readonly bundleId: string;
  readonly processorName: string;
}): string {
  return (
    `${opts.commandLabel}: ${opts.bundleId} is not installed or no ` +
    `${opts.processorName} processor is enabled. ${OLD_FIRST_PARTY_CONFIG_HINT}`
  );
}

export async function runSharedViewCommand(
  opts: ViewCommandOptions,
): Promise<ViewCommandRunResult> {
  const vaultPath = resolve(opts.vault ?? process.cwd());
  const bundleRoots = resolveBundleRoots({
    vaultPath,
    bundlesRoot: opts.bundlesRoot,
  });

  const run = await runRuntimeViewCommand({
    vaultPath,
    ...bundleRoots,
    commandName: opts.commandName,
    commandArgs: opts.commandArgs ?? null,
  });

  if (run.kind === "detached-head") {
    return Object.freeze({
      kind: "usage-error" as const,
      message:
        `${opts.commandLabel}: HEAD is detached. Check out a branch and retry.`,
    });
  }
  if (run.kind === "missing-adopted-ref") {
    return Object.freeze({
      kind: "usage-error" as const,
      message:
        `${opts.commandLabel}: vault has no adopted ref for branch '${run.branch}'. Run \`dome sync\` first to initialize.`,
    });
  }
  if (run.kind === "runtime-open-failed") {
    return Object.freeze({
      kind: "runtime-error" as const,
      message:
        `${opts.commandLabel}: openVaultRuntime failed (${run.errorKind}). Run \`dome init\` to initialize the vault.`,
    });
  }

  return Object.freeze({
    kind: "ok" as const,
    vaultPath,
    adopted: run.adopted,
    result: run.result,
    capturedViews: run.capturedViews,
  });
}

export async function runStructuredViewCommand(
  opts: StructuredViewCommandOptions,
): Promise<StructuredViewCommandResult> {
  try {
    const run = await runSharedViewCommand(opts);
    if (run.kind === "usage-error") {
      return structuredError(64, [run.message]);
    }
    if (run.kind === "runtime-error") {
      return structuredError(1, [run.message]);
    }

    const result = run.result;
    if (result.kind === "not-found") {
      return structuredError(64, [opts.notFoundMessage]);
    }
    if (result.kind === "failed") {
      const messages = [
        `${opts.commandLabel}: processor '${result.processorId}' finished with ${result.executionStatus}.`,
      ];
      if (result.executionError !== undefined) {
        messages.push(
          `${opts.commandLabel}: ${result.executionError.code}: ${result.executionError.message}`,
        );
      }
      for (const d of [...result.diagnostics, ...result.brokerDiagnostics]) {
        messages.push(
          `${opts.commandLabel}: diagnostic [${d.severity}] ${d.code}: ${d.message}`,
        );
      }
      return structuredError(1, messages);
    }

    const viewResult = validateStructuredViewResult({
      opts,
      capturedViews: run.capturedViews,
      result,
    });
    if (viewResult.kind === "error") return viewResult;

    const view = viewResult.view;

    return Object.freeze({
      kind: "ok" as const,
      data: view.content.data,
      view,
      brokerDiagnostics: Object.freeze([...result.brokerDiagnostics]),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return structuredError(1, [`${opts.commandLabel}: failed: ${msg}`]);
  }
}

type StructuredViewEffect = ViewEffect & {
  readonly content: Extract<ViewContent, { readonly kind: "structured" }>;
};

function validateStructuredViewResult(
  input: {
    readonly opts: StructuredViewCommandOptions;
    readonly capturedViews: ReadonlyArray<ViewEffect>;
    readonly result: Extract<RunCommandResult, { readonly kind: "found" }>;
  },
):
  | {
      readonly kind: "ok";
      readonly view: StructuredViewEffect;
    }
  | Extract<StructuredViewCommandResult, { readonly kind: "error" }> {
  const { opts } = input;
  const views = input.capturedViews.length > 0
    ? input.capturedViews
    : input.result.effects;
  if (views.length === 0) {
    return structuredError(1, [opts.noStructuredResultMessage]);
  }
  if (views.length !== 1) {
    return structuredError(1, [
      `${opts.commandLabel}: expected exactly one view '${opts.expectedViewName}', got ${views.length}.`,
    ]);
  }

  const view = views[0];
  if (view === undefined) {
    return structuredError(1, [opts.noStructuredResultMessage]);
  }
  if (view.name !== opts.expectedViewName) {
    return structuredError(1, [
      `${opts.commandLabel}: expected view '${opts.expectedViewName}', got '${view.name}'.`,
    ]);
  }
  const content = view.content;
  if (content.kind !== "structured") {
    return structuredError(1, [opts.noStructuredResultMessage]);
  }
  if (content.schema !== opts.expectedSchema) {
    return structuredError(1, [
      `${opts.commandLabel}: expected structured schema '${opts.expectedSchema}', got '${content.schema}'.`,
    ]);
  }

  const structuredView: StructuredViewEffect = Object.freeze({
    ...view,
    content,
  });
  return Object.freeze({ kind: "ok" as const, view: structuredView });
}

export function structuredViewBrokerMessages(
  commandLabel: string,
  diagnostics: ReadonlyArray<DiagnosticEffect>,
): ReadonlyArray<string> {
  return Object.freeze(
    diagnostics.map((d) =>
      `${commandLabel}: broker diagnostic [${d.severity}] ${d.code}: ${d.message}`
    ),
  );
}

export function printViewCommandMessages(
  messages: ReadonlyArray<string>,
): void {
  for (const message of messages) console.error(message);
}

function structuredError(
  exitCode: number,
  messages: ReadonlyArray<string>,
): StructuredViewCommandResult {
  return Object.freeze({
    kind: "error" as const,
    exitCode,
    messages: Object.freeze([...messages]),
  });
}
