// surface/adapter: the shared plumbing every protocol adapter needs.
//
// MCP, HTTP, and the CLI verbs all repeat the same four moves around the
// public `openVault` wrapper: serialize work so one runtime is open at a
// time, open-use-close a vault per request, flatten vault-open failures to
// an error kind + operator message, and run a catalog view with
// expected-name/schema validation. This module owns those moves once; each
// adapter keeps only its protocol-specific envelope mapping (HTTP status
// codes, MCP tool results, CLI exit codes + stderr).
//
// This is `AbstractSurface` arriving bottom-up: the catalog + runner pair is
// what [[wiki/specs/sdk-surface]] §"Consumer surfaces" calls
// `surface.commands`, grown consumer-by-consumer instead of designed
// speculatively.

import {
  openVault,
  type OpenVaultError,
  type Vault,
} from "../vault";
import type { DiagnosticEffect } from "../core/effect";
import type { FirstPartyViewEntry } from "./view-catalog";

// ----- Vault-open helpers -------------------------------------------------------

/** Flatten an `OpenVaultError` to the kind string operator envelopes carry. */
export function openVaultErrorKind(error: OpenVaultError): string {
  return error.kind === "runtime-open-failed" ? error.cause.kind : error.kind;
}

/**
 * The standard operator message for a vault-open failure: the typed
 * `not-a-vault` explanation when the target isn't a vault, the
 * `dome init` hint otherwise.
 */
export function vaultOpenFailureMessage(
  commandLabel: string,
  error: OpenVaultError,
): string {
  return error.kind === "not-a-vault"
    ? `${commandLabel}: ${error.message}`
    : `${commandLabel}: openVaultRuntime failed (${error.cause.kind}). ` +
      "Run `dome init` to initialize the vault.";
}

/**
 * Serialize adapter work so at most one VaultRuntime is open at a time —
 * the one-CLI-invocation-at-a-time posture every surface assumes.
 */
export function makeVaultMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn, fn);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
}

export type WithVaultOutcome<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "open-failed"; readonly error: OpenVaultError };

/**
 * Open the vault, run `fn`, always close — the per-request lifecycle every
 * adapter shares. Open failures come back typed; the adapter maps them to
 * its envelope (`openVaultErrorKind` / `vaultOpenFailureMessage`).
 */
export async function withVault<T>(
  opts: { readonly path: string; readonly bundlesRoot?: string | undefined },
  fn: (vault: Vault) => Promise<T>,
): Promise<WithVaultOutcome<T>> {
  const opened = await openVault(opts);
  if (!opened.ok) {
    return { kind: "open-failed", error: opened.error };
  }
  try {
    return { kind: "ok", value: await fn(opened.value) };
  } finally {
    await opened.value.close();
  }
}

// ----- Catalog-view running -------------------------------------------------------

/**
 * Everything that can go wrong running a catalog view, as data. Adapters map
 * these to their envelopes; `catalogViewProblemMessage` renders the shared
 * operator wording.
 */
export type CatalogViewProblem =
  | { readonly kind: "detached-head" }
  | { readonly kind: "missing-adopted-ref"; readonly branch: string }
  | { readonly kind: "adopted-ref-unstable"; readonly branch: string }
  | { readonly kind: "view-not-found" }
  | {
      readonly kind: "processor-failed";
      readonly processorId: string;
      readonly executionStatus: string;
      readonly executionError: { code: string; message: string } | null;
      readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
    }
  | { readonly kind: "no-structured-result" }
  | { readonly kind: "multiple-views"; readonly count: number }
  | { readonly kind: "wrong-view"; readonly got: string }
  | { readonly kind: "wrong-schema"; readonly got: string };

export type CatalogViewOutcome =
  | {
      readonly kind: "ok";
      readonly data: unknown;
      readonly brokerDiagnostics: ReadonlyArray<DiagnosticEffect>;
    }
  | { readonly kind: "problem"; readonly problem: CatalogViewProblem };

/**
 * Run one catalog view on an open vault and validate the result: exactly
 * one view, matching the expected name and structured schema.
 */
export async function runCatalogView(
  vault: Vault,
  entry: FirstPartyViewEntry,
  args?: unknown,
): Promise<CatalogViewOutcome> {
  const run = await vault.runView(entry.command, args ?? null);
  switch (run.kind) {
    case "detached-head":
    case "missing-adopted-ref":
    case "adopted-ref-unstable":
      return { kind: "problem", problem: run };
    case "not-found":
      return { kind: "problem", problem: { kind: "view-not-found" } };
    case "failed":
      return {
        kind: "problem",
        problem: {
          kind: "processor-failed",
          processorId: run.processorId,
          executionStatus: run.executionStatus,
          executionError: run.executionError,
          diagnostics: run.diagnostics,
        },
      };
    case "ok": {
      const validated = validateStructuredRun(
        { views: run.views, structured: run.structured },
        { viewName: entry.viewName, schema: entry.schema },
      );
      if (validated.kind === "problem") return validated;
      return {
        kind: "ok",
        data: validated.data,
        brokerDiagnostics: run.brokerDiagnostics,
      };
    }
  }
}

/**
 * The pure expected-view validation every consumer shares: exactly one
 * view, matching name, structured content, matching schema. The CLI's
 * structured-view wrapper and `runCatalogView` both delegate here; only
 * the message rendering differs per surface.
 */
export function validateStructuredRun(
  run: {
    readonly views: ReadonlyArray<{ readonly name: string }>;
    readonly structured: { readonly schema: string; readonly data: unknown } | null;
  },
  expected: { readonly viewName: string; readonly schema: string },
):
  | { readonly kind: "ok"; readonly data: unknown }
  | { readonly kind: "problem"; readonly problem: CatalogViewProblem } {
  if (run.views.length === 0) {
    return { kind: "problem", problem: { kind: "no-structured-result" } };
  }
  if (run.views.length !== 1) {
    return {
      kind: "problem",
      problem: { kind: "multiple-views", count: run.views.length },
    };
  }
  const view = run.views[0];
  if (view !== undefined && view.name !== expected.viewName) {
    return { kind: "problem", problem: { kind: "wrong-view", got: view.name } };
  }
  if (run.structured === null) {
    return { kind: "problem", problem: { kind: "no-structured-result" } };
  }
  if (run.structured.schema !== expected.schema) {
    return {
      kind: "problem",
      problem: { kind: "wrong-schema", got: run.structured.schema },
    };
  }
  return { kind: "ok", data: run.structured.data };
}

const OLD_FIRST_PARTY_CONFIG_HINT =
  "For older vault configs, run `dome init --refresh-config` to add current first-party defaults.";

/** The shared not-found wording for a first-party view. */
export function viewNotFoundMessage(
  commandLabel: string,
  entry: FirstPartyViewEntry,
): string {
  return (
    `${commandLabel}: ${entry.bundleId} is not installed or no ` +
    `${entry.processorName} processor is enabled. ${OLD_FIRST_PARTY_CONFIG_HINT}`
  );
}

/** Render the shared operator wording for a catalog-view problem. */
export function catalogViewProblemMessage(
  commandLabel: string,
  entry: FirstPartyViewEntry,
  problem: CatalogViewProblem,
): string {
  switch (problem.kind) {
    case "detached-head":
      return `${commandLabel}: HEAD is detached. Check out a branch and retry.`;
    case "missing-adopted-ref":
      return `${commandLabel}: vault has no adopted ref for branch '${problem.branch}'. Run \`dome sync\` first to initialize.`;
    case "adopted-ref-unstable":
      return `${commandLabel}: adopted ref for branch '${problem.branch}' changed repeatedly while rendering. Retry the command after the current sync finishes.`;
    case "view-not-found":
      return viewNotFoundMessage(commandLabel, entry);
    case "processor-failed":
      return `${commandLabel}: processor '${problem.processorId}' finished with ${problem.executionStatus}.`;
    case "no-structured-result":
      return `${commandLabel}: ${entry.processorName} processor returned no structured result.`;
    case "multiple-views":
      return `${commandLabel}: expected exactly one view '${entry.viewName}', got ${problem.count}.`;
    case "wrong-view":
      return `${commandLabel}: expected view '${entry.viewName}', got '${problem.got}'.`;
    case "wrong-schema":
      return `${commandLabel}: expected structured schema '${entry.schema}', got '${problem.got}'.`;
  }
}

/** CLI exit-code semantics for a catalog-view problem (64 usage, 1 runtime). */
export function catalogViewProblemExitCode(
  problem: CatalogViewProblem,
): number {
  switch (problem.kind) {
    case "detached-head":
    case "missing-adopted-ref":
    case "view-not-found":
      return 64;
    default:
      return 1;
  }
}
