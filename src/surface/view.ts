// surface/view: the shared view-command runners.
//
// `dome run`, the first-class view command wrappers (`dome query`,
// `dome export-context`, `dome lint`, ...), and the MCP view tools all share
// error translation and structured-view validation. View dispatch flows
// through the public `openVault` wrapper — `vault.runView` is the same
// boundary every consumer surface uses. Results come back as data; the
// adapter owns its message channel (stderr for the CLI, tool errors for MCP).

import type { DiagnosticEffect, ViewEffect } from "../core/effect";
import {
  openVault,
  type StructuredView,
  type VaultViewResult,
} from "../vault";
import {
  catalogViewProblemMessage,
  validateStructuredRun,
  vaultOpenFailureMessage,
  viewNotFoundMessage,
} from "./adapter";
import type { FirstPartyViewEntry } from "./view-catalog";
import { resolveVaultPath } from "./resolve-vault";

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

export type StructuredViewCommandOptions<TPayload = unknown> = {
  readonly commandLabel: string;
  readonly entry: FirstPartyViewEntry<TPayload>;
  readonly commandArgs?: unknown;
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  /**
   * Per-caller override for the `no-structured-result` wording. The shared
   * `catalogViewProblemMessage` would say
   * "<label>: <processorName> processor returned no structured result.";
   * some callers (e.g. export-context) ship a different sentence and we keep
   * it byte-identical rather than re-render.
   */
  readonly noStructuredResultMessage: string;
};

export type StructuredViewCommandResult<TPayload = unknown> =
  | {
      readonly kind: "ok";
      readonly data: TPayload;
      readonly view: StructuredView;
      readonly brokerDiagnostics: ReadonlyArray<DiagnosticEffect>;
    }
  | {
      readonly kind: "error";
      readonly exitCode: number;
      readonly messages: ReadonlyArray<string>;
    };

export async function runSharedViewCommand(
  opts: ViewCommandOptions,
): Promise<ViewCommandRunResult> {
  const vaultPath = resolveVaultPath(opts.vault);

  const opened = await openVault({
    path: vaultPath,
    bundlesRoot: opts.bundlesRoot,
  });
  if (!opened.ok) {
    return Object.freeze({
      kind: opened.error.kind === "not-a-vault"
        ? ("usage-error" as const)
        : ("runtime-error" as const),
      message: vaultOpenFailureMessage(opts.commandLabel, opened.error),
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

export async function runStructuredViewCommand<TPayload>(
  opts: StructuredViewCommandOptions<TPayload>,
): Promise<StructuredViewCommandResult<TPayload>> {
  const { commandLabel, entry } = opts;
  try {
    const run = await runSharedViewCommand({
      commandLabel,
      commandName: entry.command,
      commandArgs: opts.commandArgs,
      vault: opts.vault,
      bundlesRoot: opts.bundlesRoot,
    });
    if (run.kind === "usage-error") {
      return structuredError(64, [run.message]);
    }
    if (run.kind === "runtime-error") {
      return structuredError(1, [run.message]);
    }
    if (run.kind === "not-found") {
      return structuredError(64, [viewNotFoundMessage(commandLabel, entry)]);
    }
    if (run.kind === "failed") {
      const messages = [
        // `catalogViewProblemMessage` renders only this first line; the
        // structured CLI wrapper also surfaces the execution error + each
        // diagnostic, so we expand them here rather than delegate.
        catalogViewProblemMessage(commandLabel, entry, {
          kind: "processor-failed",
          processorId: run.processorId,
          executionStatus: run.executionStatus,
          executionError: run.executionError,
          diagnostics: run.diagnostics,
        }),
      ];
      if (run.executionError !== null) {
        messages.push(
          `${commandLabel}: ${run.executionError.code}: ${run.executionError.message}`,
        );
      }
      for (const d of run.diagnostics) {
        messages.push(
          `${commandLabel}: diagnostic [${d.severity}] ${d.code}: ${d.message}`,
        );
      }
      return structuredError(1, messages);
    }

    const validated = validateStructuredRun(
      { views: run.views, structured: run.structured },
      { viewName: entry.viewName, schemaTag: entry.schemaTag, payload: entry.payload },
    );
    if (validated.kind === "problem") {
      // `no-structured-result` keeps the per-caller override wording; every
      // other problem renders through the shared `catalogViewProblemMessage`.
      const message = validated.problem.kind === "no-structured-result"
        ? opts.noStructuredResultMessage
        : catalogViewProblemMessage(commandLabel, entry, validated.problem);
      return structuredError(1, [message]);
    }

    return Object.freeze({
      kind: "ok" as const,
      // run.structured is non-null whenever validation succeeds.
      data: validated.data,
      view: run.structured as StructuredView,
      brokerDiagnostics: run.brokerDiagnostics,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return structuredError(1, [`${commandLabel}: failed: ${msg}`]);
  }
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

function structuredError(
  exitCode: number,
  messages: ReadonlyArray<string>,
): {
  readonly kind: "error";
  readonly exitCode: number;
  readonly messages: ReadonlyArray<string>;
} {
  return Object.freeze({
    kind: "error" as const,
    exitCode,
    messages: Object.freeze([...messages]),
  });
}
