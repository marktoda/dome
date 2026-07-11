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
// This is shared operation plumbing, not another product-shaped surface
// object. The second real protocol consumer earned each extraction; adapters
// retain only transport concerns.

import type { ZodType } from "zod";

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
 * The `openVaultRuntime failed (<kind>)` operator message keyed by a
 * pre-flattened error kind — the form every adapter envelope that only
 * carries the kind string (MCP/HTTP `commandError*`, the CLI's
 * `emitRuntimeOpenFailure`) renders.
 */
export function runtimeOpenFailureMessage(
  commandLabel: string,
  errorKind: string,
): string {
  return (
    `${commandLabel}: openVaultRuntime failed (${errorKind}). ` +
    "Run `dome init` to initialize the vault."
  );
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
    : runtimeOpenFailureMessage(commandLabel, error.cause.kind);
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
  | { readonly kind: "wrong-schema"; readonly got: string }
  | { readonly kind: "invalid-payload"; readonly issues: string };

export type CatalogViewOutcome<TPayload = unknown> =
  | {
      readonly kind: "ok";
      readonly data: TPayload;
      readonly brokerDiagnostics: ReadonlyArray<DiagnosticEffect>;
    }
  | { readonly kind: "problem"; readonly problem: CatalogViewProblem };

/**
 * Run one catalog view on an open vault and validate the result against the
 * entry's View Contract: exactly one view, matching the expected name and
 * version tag, and a structured payload that parses against `entry.payload`.
 * The ok branch carries the typed `TPayload` — `data: unknown` dies here.
 */
export async function runCatalogView<TPayload>(
  vault: Vault,
  entry: FirstPartyViewEntry<TPayload>,
  args?: unknown,
): Promise<CatalogViewOutcome<TPayload>> {
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
        { viewName: entry.viewName, schemaTag: entry.schemaTag, payload: entry.payload },
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
 * view, matching name, structured content, matching version tag, and a
 * payload that parses against the contract schema. The CLI's structured-view
 * wrapper and `runCatalogView` both delegate here; only the message rendering
 * differs per surface. The version tag (`schemaTag`) is a cheap handshake that
 * fast-fails before the schema parse; a tag match with a malformed payload is
 * a distinct `invalid-payload` problem (a processor bug).
 */
export function validateStructuredRun<TPayload>(
  run: {
    readonly views: ReadonlyArray<{ readonly name: string }>;
    readonly structured: { readonly schema: string; readonly data: unknown } | null;
  },
  expected: {
    readonly viewName: string;
    readonly schemaTag: string;
    readonly payload: ZodType<TPayload>;
  },
):
  | { readonly kind: "ok"; readonly data: TPayload }
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
  if (run.structured.schema !== expected.schemaTag) {
    return {
      kind: "problem",
      problem: { kind: "wrong-schema", got: run.structured.schema },
    };
  }
  const parsed = expected.payload.safeParse(run.structured.data);
  if (!parsed.success) {
    return {
      kind: "problem",
      problem: {
        kind: "invalid-payload",
        issues: parsed.error.issues
          .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
          .join("; "),
      },
    };
  }
  return { kind: "ok", data: parsed.data };
}

const OLD_FIRST_PARTY_CONFIG_HINT =
  "For older vault configs, run `dome init --refresh-config` to add current first-party defaults.";

/**
 * The label fields the operator-message renderers read. Narrowed from the
 * full entry so a generic `FirstPartyViewEntry<TPayload>` passes without the
 * contravariant `buildViewModel` param tripping `exactOptionalPropertyTypes`.
 */
type ViewEntryLabels = Pick<
  FirstPartyViewEntry,
  "viewName" | "schemaTag" | "bundleId" | "processorName"
>;

/** The shared not-found wording for a first-party view. */
export function viewNotFoundMessage(
  commandLabel: string,
  entry: ViewEntryLabels,
): string {
  return (
    `${commandLabel}: ${entry.bundleId} is not installed or no ` +
    `${entry.processorName} processor is enabled. ${OLD_FIRST_PARTY_CONFIG_HINT}`
  );
}

/** Render the shared operator wording for a catalog-view problem. */
export function catalogViewProblemMessage(
  commandLabel: string,
  entry: ViewEntryLabels,
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
      return `${commandLabel}: expected structured schema '${entry.schemaTag}', got '${problem.got}'.`;
    case "invalid-payload":
      return `${commandLabel}: ${entry.processorName} processor returned a payload that failed validation (${problem.issues}).`;
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

// ----- View dispatch (the shared adapter core) -----------------------------------

/**
 * The per-protocol error-rendering seam. The two outcomes that are uniform
 * within a protocol — a vault-open failure and a catalog-view problem — render
 * here; the `ok` outcome varies per route (JSON / HTML / stderr) so the caller
 * owns it. CLI/MCP/HTTP each supply one `ViewRenderer`.
 */
export type ViewRenderer<TEnvelope> = {
  readonly openFailed: (error: OpenVaultError) => TEnvelope;
  readonly problem: (problem: CatalogViewProblem) => TEnvelope;
};

/**
 * What `dispatchView` returns: either an already-rendered error envelope, or
 * the validated, typed `ok` payload for the caller to render its own way.
 */
export type ViewDispatch<TPayload, TEnvelope> =
  | {
      readonly kind: "ok";
      readonly data: TPayload;
      readonly brokerDiagnostics: ReadonlyArray<DiagnosticEffect>;
    }
  | { readonly kind: "rendered"; readonly envelope: TEnvelope };

/**
 * Open the vault, run one catalog view against its View Contract, and route the
 * three outcomes to the renderer (open-failed, problem) or back to the caller
 * (ok). The adapter analog of `dispatchGardenRun`: one small interface, all the
 * open-use-close + validate + branch behaviour behind it. Every protocol
 * adapter's view path flows through here.
 */
export async function dispatchView<TPayload, TEnvelope>(
  locator: { readonly path: string; readonly bundlesRoot?: string | undefined },
  entry: FirstPartyViewEntry<TPayload>,
  args: unknown,
  renderer: ViewRenderer<TEnvelope>,
): Promise<ViewDispatch<TPayload, TEnvelope>> {
  const outcome = await withVault(locator, (v) =>
    runCatalogView(v, entry, args),
  );
  if (outcome.kind === "open-failed") {
    return { kind: "rendered", envelope: renderer.openFailed(outcome.error) };
  }
  const run = outcome.value;
  if (run.kind === "problem") {
    return { kind: "rendered", envelope: renderer.problem(run.problem) };
  }
  return {
    kind: "ok",
    data: run.data,
    brokerDiagnostics: run.brokerDiagnostics,
  };
}
