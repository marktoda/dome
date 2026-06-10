// cli/commands/view-shared: CLI helpers for view commands.
//
// `dome run` and first-class view command wrappers such as `dome query` all
// share error translation, structured-view validation, and message printing.
// View dispatch flows through the public `openVault` wrapper —
// `vault.runView` is the same boundary the MCP adapter and future non-CLI
// surfaces consume; this module owns only the CLI's message vocabulary.

import type { DiagnosticEffect, ViewEffect } from "../../core/effect";
import {
  openVault,
  type StructuredView,
  type VaultViewResult,
} from "../../vault";
import { resolveVaultPath } from "../resolve-vault";

import { formatJson } from "../format";

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
  | { readonly kind: "not-found" }
  | {
      readonly kind: "failed";
      readonly processorId: string;
      readonly executionStatus: string;
      readonly executionError: { code: string; message: string } | null;
      readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
    }
  | {
      readonly kind: "ok";
      readonly vaultPath: string;
      readonly views: ReadonlyArray<ViewEffect>;
      readonly structured: StructuredView | null;
      readonly brokerDiagnostics: ReadonlyArray<DiagnosticEffect>;
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
      readonly view: StructuredView;
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
  const vaultPath = resolveVaultPath(opts.vault);

  const opened = await openVault({
    path: vaultPath,
    bundlesRoot: opts.bundlesRoot,
  });
  if (!opened.ok) {
    if (opened.error.kind === "not-a-vault") {
      return Object.freeze({
        kind: "usage-error" as const,
        message: `${opts.commandLabel}: ${opened.error.message}`,
      });
    }
    return Object.freeze({
      kind: "runtime-error" as const,
      message:
        `${opts.commandLabel}: openVaultRuntime failed (${opened.error.cause.kind}). Run \`dome init\` to initialize the vault.`,
    });
  }

  const vault = opened.value;
  try {
    const run = await vault.runView(opts.commandName, opts.commandArgs ?? null);
    return translateViewResult(opts.commandLabel, vaultPath, run);
  } finally {
    await vault.close();
  }
}

function translateViewResult(
  commandLabel: string,
  vaultPath: string,
  run: VaultViewResult,
): ViewCommandRunResult {
  switch (run.kind) {
    case "detached-head":
      return Object.freeze({
        kind: "usage-error" as const,
        message:
          `${commandLabel}: HEAD is detached. Check out a branch and retry.`,
      });
    case "missing-adopted-ref":
      return Object.freeze({
        kind: "usage-error" as const,
        message:
          `${commandLabel}: vault has no adopted ref for branch '${run.branch}'. Run \`dome sync\` first to initialize.`,
      });
    case "adopted-ref-unstable":
      return Object.freeze({
        kind: "runtime-error" as const,
        message:
          `${commandLabel}: adopted ref for branch '${run.branch}' changed repeatedly while rendering. Retry the command after the current sync finishes.`,
      });
    case "not-found":
      return Object.freeze({ kind: "not-found" as const });
    case "failed":
      return Object.freeze({
        kind: "failed" as const,
        processorId: run.processorId,
        executionStatus: run.executionStatus,
        executionError: run.executionError,
        diagnostics: run.diagnostics,
      });
    case "ok":
      return Object.freeze({
        kind: "ok" as const,
        vaultPath,
        views: run.views,
        structured: run.structured,
        brokerDiagnostics: run.brokerDiagnostics,
      });
  }
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
    if (run.kind === "not-found") {
      return structuredError(64, [opts.notFoundMessage]);
    }
    if (run.kind === "failed") {
      const messages = [
        `${opts.commandLabel}: processor '${run.processorId}' finished with ${run.executionStatus}.`,
      ];
      if (run.executionError !== null) {
        messages.push(
          `${opts.commandLabel}: ${run.executionError.code}: ${run.executionError.message}`,
        );
      }
      for (const d of run.diagnostics) {
        messages.push(
          `${opts.commandLabel}: diagnostic [${d.severity}] ${d.code}: ${d.message}`,
        );
      }
      return structuredError(1, messages);
    }

    const viewResult = validateStructuredViewResult({ opts, run });
    if (viewResult.kind === "error") return viewResult;

    return Object.freeze({
      kind: "ok" as const,
      data: viewResult.view.data,
      view: viewResult.view,
      brokerDiagnostics: run.brokerDiagnostics,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return structuredError(1, [`${opts.commandLabel}: failed: ${msg}`]);
  }
}

function validateStructuredViewResult(
  input: {
    readonly opts: StructuredViewCommandOptions;
    readonly run: Extract<ViewCommandRunResult, { readonly kind: "ok" }>;
  },
):
  | {
      readonly kind: "ok";
      readonly view: StructuredView;
    }
  | Extract<StructuredViewCommandResult, { readonly kind: "error" }> {
  const { opts, run } = input;
  if (run.views.length === 0) {
    return structuredError(1, [opts.noStructuredResultMessage]);
  }
  if (run.views.length !== 1) {
    return structuredError(1, [
      `${opts.commandLabel}: expected exactly one view '${opts.expectedViewName}', got ${run.views.length}.`,
    ]);
  }

  const view = run.views[0];
  if (view === undefined) {
    return structuredError(1, [opts.noStructuredResultMessage]);
  }
  if (view.name !== opts.expectedViewName) {
    return structuredError(1, [
      `${opts.commandLabel}: expected view '${opts.expectedViewName}', got '${view.name}'.`,
    ]);
  }
  if (run.structured === null) {
    return structuredError(1, [opts.noStructuredResultMessage]);
  }
  if (run.structured.schema !== opts.expectedSchema) {
    return structuredError(1, [
      `${opts.commandLabel}: expected structured schema '${opts.expectedSchema}', got '${run.structured.schema}'.`,
    ]);
  }

  return Object.freeze({ kind: "ok" as const, view: run.structured });
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

export function printViewCommandError(opts: {
  readonly commandLabel: string;
  readonly json: boolean;
  readonly messages: ReadonlyArray<string>;
  readonly error?: string;
}): void {
  if (!opts.json) {
    printViewCommandMessages(opts.messages);
    return;
  }
  const message = opts.messages[0] ?? `${opts.commandLabel}: failed.`;
  console.log(
    formatJson({
      status: "error",
      error: opts.error ?? "view-command-failed",
      message,
      messages: opts.messages,
    }),
  );
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
