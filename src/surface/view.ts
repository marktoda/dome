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
import { vaultOpenFailureMessage } from "./adapter";
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
