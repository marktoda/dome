// vault: the public SDK wrapper — `openVault(opts)` per
// docs/wiki/specs/sdk-surface.md §"The four concepts" / §"Vault surface".
//
// One `Vault` instance per process per vault path. The surface is **read or
// engine control** — there is no write method, no Proposal constructor, no
// `submitProposal`. External writes stay ordinary git commits that `sync()`
// (or the daemon) adopts; garden writes stay engine-internal sub-Proposals.
// Pinned by [[wiki/invariants/PROPOSALS_ARE_THE_ONLY_WRITE_PATH]].
//
// The wrapper composes engine-internal boundaries and adds nothing of its
// own:
//
//   getAdoptionStatus → src/engine/adoption-status.ts (cheap git reads)
//   sync              → src/engine/compiler-host.ts `runCompilerHostTick`
//   runView           → src/engine/view-command.ts `runViewCommandWithRuntime`
//   query             → src/projections/* read accessors (adopted-state recall)
//   readDocument      → adopted-ref blob read via the git boundary
//   listQuestions / getQuestion / resolve
//                     → src/projections/questions.ts +
//                       src/engine/question-answering.ts (durable answers)
//
// Recall semantics: projection reads reflect the **last adopted sync** —
// never HEAD, never mid-sync drafts ([[wiki/specs/sdk-surface]] §"Recall
// API"). A consumer that needs the projection to include fresh commits calls
// `sync()` first, exactly like the CLI's status → next_actions loop.
//
// Layering: this module imports engine/projections/git boundaries only — no
// `src/cli/`, no LLM SDK, no MCP transport. It is re-exported from
// `src/index.ts`, so the ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY fence
// (tests/integration/bundle-deps.test.ts) covers it.
//
// Entry-point convention: `openVault` is the STANDARD entry point for every
// surface — CLI verbs (resolve/answer, rebuild, and all view commands via
// cli/commands/view-shared.ts), the MCP adapter, and future HTTP/voice
// shells all consume this wrapper. Direct `openVaultRuntime` use is reserved
// for the daemon and operator internals that report on runtime guts the
// wrapper intentionally hides (serve, sync's tick events + health, the
// status/check collectors, doctor, inspect). New consumers start here; reach
// for the runtime only when a feature genuinely needs those internals.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { getAdoptedRef, getCurrentBranch } from "./adopted-ref";
import type {
  DiagnosticEffect,
  FactEffect,
  ViewEffect,
} from "./core/effect";
import { nodeRef } from "./core/effect";
import type { SearchDocumentResult } from "./core/processor";
import { commitOid } from "./core/source-ref";
import {
  collectAdoptionStatus,
  type AdoptionStatus,
} from "./engine/adoption-status";
import {
  runCompilerHostTick,
  type CompilerHostTickResult,
} from "./engine/compiler-host";
import { rebuildProjection } from "./engine/projection-rebuild";
import {
  answerQuestionDurably,
  dispatchAnswerHandlersIfNeeded,
  type AnswerHandlerDispatchResult,
} from "./engine/question-answering";
import {
  openVaultRuntime,
  type OpenVaultRuntimeError,
  type VaultRuntime,
} from "./engine/vault-runtime";
import { runViewCommandWithRuntime } from "./engine/view-command";
import { resolveBundleRoots } from "./extensions/bundle-roots";
import { findGitRoot, readBlob } from "./git";
import { queryDiagnostics } from "./projections/diagnostics";
import { factsBySubject } from "./projections/facts";
import {
  getQuestionRecord,
  queryQuestionRecords,
  type QuestionRecord,
} from "./projections/questions";
import { searchDocuments } from "./projections/search";
import { err, ok, type Result } from "./types";

// ----- Public types ---------------------------------------------------------

export type OpenVaultOptions = {
  /** Vault root directory (absolute or relative to cwd). */
  readonly path: string;
  /** Exact bundles-root override for tests and ad-hoc development. */
  readonly bundlesRoot?: string | undefined;
};

export type OpenVaultError =
  | { readonly kind: "not-a-vault"; readonly message: string }
  | {
      readonly kind: "runtime-open-failed";
      readonly cause: OpenVaultRuntimeError;
    };

export type QueryInput = {
  /** FTS query over adopted-state search documents. */
  readonly text: string;
  readonly category?: string | undefined;
  readonly type?: string | undefined;
  readonly limit?: number | undefined;
  /** Attach facts whose subject page is among the matched paths. */
  readonly includeFacts?: boolean | undefined;
  /** Attach diagnostics whose source refs touch the matched paths. */
  readonly includeDiagnostics?: boolean | undefined;
  /** Attach open questions whose source refs touch the matched paths. */
  readonly includeQuestions?: boolean | undefined;
};

export type QueryResult = {
  readonly matches: ReadonlyArray<SearchDocumentResult>;
  readonly facts: ReadonlyArray<FactEffect>;
  readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
  readonly questions: ReadonlyArray<QuestionRecord>;
};

/** A document read from the adopted commit (never HEAD). */
export type AdoptedDocument = {
  readonly path: string;
  readonly content: string;
  /** The adopted commit the content was read at. */
  readonly commit: string;
};

/** The single structured view of a command run, when exactly one exists. */
export type StructuredView = {
  readonly name: string;
  readonly schema: string;
  readonly data: unknown;
};

export type VaultViewResult =
  | {
      readonly kind: "ok";
      readonly views: ReadonlyArray<ViewEffect>;
      /** Set when the run produced exactly one structured view. */
      readonly structured: StructuredView | null;
      readonly brokerDiagnostics: ReadonlyArray<DiagnosticEffect>;
    }
  | { readonly kind: "not-found" }
  | {
      readonly kind: "failed";
      readonly processorId: string;
      readonly executionStatus: string;
      readonly executionError: { code: string; message: string } | null;
      readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
    }
  | { readonly kind: "detached-head" }
  | { readonly kind: "missing-adopted-ref"; readonly branch: string }
  | { readonly kind: "adopted-ref-unstable"; readonly branch: string };

export type ResolveOutcome =
  | {
      readonly kind: "answered" | "already-answered";
      readonly record: QuestionRecord;
      readonly handlers: AnswerHandlerDispatchResult;
    }
  | {
      readonly kind: "invalid-option";
      readonly record: QuestionRecord;
      readonly options: ReadonlyArray<string>;
    }
  | { readonly kind: "not-found" };

export type ListQuestionsFilter = {
  readonly resolved?: boolean | undefined;
};

export type VaultSyncOptions = {
  readonly signal?: AbortSignal | undefined;
};

export type RebuildOutcome =
  | {
      readonly kind: "ok";
      readonly branch: string;
      /** The adopted commit the projection was rebuilt from. */
      readonly adopted: string;
      readonly files: number;
      readonly processors: number;
      readonly effects: number;
    }
  | { readonly kind: "detached-head" }
  | { readonly kind: "missing-adopted-ref"; readonly branch: string };

/**
 * The public vault handle. Read + engine control only; closed over an
 * engine-internal `VaultRuntime` that callers never see.
 */
export type Vault = {
  readonly path: string;
  /** Installed extension bundles (manifest id + version). */
  readonly extensions: ReadonlyArray<{
    readonly name: string;
    readonly version: string;
  }>;

  // Recall — read-only queries against adopted state
  readonly query: (input: QueryInput) => Promise<QueryResult>;
  readonly readDocument: (path: string) => Promise<AdoptedDocument | null>;
  readonly runView: (
    name: string,
    args?: unknown,
  ) => Promise<VaultViewResult>;

  // Engine control
  readonly sync: (opts?: VaultSyncOptions) => Promise<CompilerHostTickResult>;
  readonly rebuild: () => Promise<RebuildOutcome>;
  readonly getAdoptionStatus: () => Promise<AdoptionStatus>;

  // Decisions — durable questions and answers
  readonly listQuestions: (
    filter?: ListQuestionsFilter,
  ) => Promise<ReadonlyArray<QuestionRecord>>;
  readonly getQuestion: (id: number) => Promise<QuestionRecord | null>;
  readonly resolve: (id: number, value: string) => Promise<ResolveOutcome>;

  // Lifecycle
  readonly close: () => Promise<void>;
};

// ----- openVault ------------------------------------------------------------

/**
 * Open a Dome vault for in-process use. Validates the two structural
 * preconditions every Dome vault carries — a git repository
 * ([[wiki/invariants/VAULT_IS_GIT_REPO]]) and a `.dome/config.yaml` — then
 * composes the engine runtime over the canonical bundle roots (SDK-shipped
 * plus vault-local, exactly like the CLI).
 *
 * The returned handle holds open SQLite connections; callers own the
 * lifecycle and must `close()` it. Failure modes surface as typed errors,
 * never throws.
 */
export async function openVault(
  opts: OpenVaultOptions,
): Promise<Result<Vault, OpenVaultError>> {
  const vaultPath = resolve(opts.path);

  if ((await findGitRoot(vaultPath)) === null) {
    return err({
      kind: "not-a-vault",
      message: `${vaultPath} is not inside a git repository; run \`dome init\` first`,
    });
  }
  // `.dome/` presence is the vault marker. A `.dome/` without `config.yaml`
  // is the documented config-less compat mode (test/dev vaults load all
  // bundles with declared grants — see src/engine/vault-runtime.ts), so the
  // check is for the directory, not the config file.
  if (!existsSync(join(vaultPath, ".dome"))) {
    return err({
      kind: "not-a-vault",
      message: `${vaultPath} has no .dome directory; run \`dome init\` first`,
    });
  }

  const runtimeResult = await openVaultRuntime({
    vaultPath,
    ...resolveBundleRoots({ vaultPath, bundlesRoot: opts.bundlesRoot }),
  });
  if (!runtimeResult.ok) {
    return err({ kind: "runtime-open-failed", cause: runtimeResult.error });
  }

  return ok(bindVault(runtimeResult.value));
}

// ----- internals ------------------------------------------------------------

function bindVault(runtime: VaultRuntime): Vault {
  return Object.freeze({
    path: runtime.path,
    extensions: runtime.extensions,

    query: (input: QueryInput) => queryAdoptedState(runtime, input),
    readDocument: (path: string) => readAdoptedDocument(runtime.path, path),
    runView: (name: string, args?: unknown) =>
      runVaultView(runtime, name, args),

    sync: (opts?: VaultSyncOptions) =>
      runCompilerHostTick({
        runtime,
        ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
      }),
    rebuild: () => rebuildVaultProjection(runtime),
    getAdoptionStatus: () => collectAdoptionStatus(runtime.path),

    listQuestions: async (filter?: ListQuestionsFilter) =>
      queryQuestionRecords(runtime.projectionDb, {
        ...(filter?.resolved !== undefined
          ? { resolved: filter.resolved }
          : {}),
      }),
    getQuestion: async (id: number) =>
      getQuestionRecord(runtime.projectionDb, id),
    resolve: (id: number, value: string) =>
      resolveQuestion(runtime, id, value),

    close: () => runtime.close(),
  });
}

async function queryAdoptedState(
  runtime: VaultRuntime,
  input: QueryInput,
): Promise<QueryResult> {
  const matches = searchDocuments(runtime.projectionDb, {
    query: input.text,
    ...(input.category !== undefined ? { category: input.category } : {}),
    ...(input.type !== undefined ? { type: input.type } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  });
  const matchPaths = new Set(matches.map((match) => match.path));

  const facts = input.includeFacts === true
    ? Object.freeze(
        [...matchPaths].flatMap((path) =>
          factsBySubject(runtime.projectionDb, nodeRef({ kind: "page", path })),
        ),
      )
    : EMPTY_FACTS;

  const diagnostics = input.includeDiagnostics === true
    ? Object.freeze(
        queryDiagnostics(runtime.projectionDb).filter((diagnostic) =>
          diagnostic.sourceRefs.some((ref) => matchPaths.has(ref.path)),
        ),
      )
    : EMPTY_DIAGNOSTICS;

  const questions = input.includeQuestions === true
    ? Object.freeze(
        queryQuestionRecords(runtime.projectionDb, { resolved: false }).filter(
          (record) =>
            record.effect.sourceRefs.some((ref) => matchPaths.has(ref.path)),
        ),
      )
    : EMPTY_QUESTIONS;

  return Object.freeze({ matches, facts, diagnostics, questions });
}

const EMPTY_FACTS: ReadonlyArray<FactEffect> = Object.freeze([]);
const EMPTY_DIAGNOSTICS: ReadonlyArray<DiagnosticEffect> = Object.freeze([]);
const EMPTY_QUESTIONS: ReadonlyArray<QuestionRecord> = Object.freeze([]);

async function readAdoptedDocument(
  vaultPath: string,
  documentPath: string,
): Promise<AdoptedDocument | null> {
  const branch = await getCurrentBranch(vaultPath);
  if (branch === null) return null;
  const adopted = await getAdoptedRef(vaultPath, branch);
  if (adopted === null) return null;

  const content = await readBlob({
    path: vaultPath,
    commit: adopted,
    filepath: documentPath,
  });
  if (content === null) return null;
  return Object.freeze({ path: documentPath, content, commit: adopted });
}

async function runVaultView(
  runtime: VaultRuntime,
  name: string,
  args: unknown,
): Promise<VaultViewResult> {
  const run = await runViewCommandWithRuntime({
    runtime,
    commandName: name,
    commandArgs: args ?? null,
  });

  if (run.kind !== "ok") return run;

  const result = run.result;
  if (result.kind === "not-found") {
    return Object.freeze({ kind: "not-found" as const });
  }
  if (result.kind === "failed") {
    return Object.freeze({
      kind: "failed" as const,
      processorId: result.processorId,
      executionStatus: result.executionStatus,
      executionError: result.executionError ?? null,
      diagnostics: Object.freeze([
        ...result.diagnostics,
        ...result.brokerDiagnostics,
      ]),
    });
  }

  const views =
    run.capturedViews.length > 0 ? run.capturedViews : result.effects;
  return Object.freeze({
    kind: "ok" as const,
    views,
    structured: deriveStructuredView(views),
    brokerDiagnostics: result.brokerDiagnostics,
  });
}

function deriveStructuredView(
  views: ReadonlyArray<ViewEffect>,
): StructuredView | null {
  if (views.length !== 1) return null;
  const view = views[0];
  if (view === undefined || view.content.kind !== "structured") return null;
  return Object.freeze({
    name: view.name,
    schema: view.content.schema,
    data: view.content.data,
  });
}

async function rebuildVaultProjection(
  runtime: VaultRuntime,
): Promise<RebuildOutcome> {
  const branch = await getCurrentBranch(runtime.path);
  if (branch === null) {
    return Object.freeze({ kind: "detached-head" as const });
  }
  const adopted = await getAdoptedRef(runtime.path, branch);
  if (adopted === null) {
    return Object.freeze({ kind: "missing-adopted-ref" as const, branch });
  }

  const result = await rebuildProjection({
    runtime,
    adopted: commitOid(adopted),
    branch,
  });
  return Object.freeze({
    kind: "ok" as const,
    branch,
    adopted,
    files: result.fileCount,
    processors: result.processorCount,
    effects: result.effectCount,
  });
}

async function resolveQuestion(
  runtime: VaultRuntime,
  id: number,
  value: string,
): Promise<ResolveOutcome> {
  const result = answerQuestionDurably({
    projection: runtime.projectionDb,
    answers: runtime.answersDb,
    id,
    answer: value,
  });

  switch (result.kind) {
    case "not-found":
      return Object.freeze({ kind: "not-found" as const });
    case "invalid-option":
      return Object.freeze({
        kind: "invalid-option" as const,
        record: result.record,
        options: result.options,
      });
    case "answered":
    case "already-answered": {
      const handlers = await dispatchAnswerHandlersIfNeeded({
        runtime,
        question: result.record,
      });
      return Object.freeze({
        kind: result.kind,
        record: result.record,
        handlers,
      });
    }
  }
}

// ----- Re-exports for consumers ----------------------------------------------

export type { AdoptionStatus } from "./engine/adoption-status";
export type { CompilerHostTickResult } from "./engine/compiler-host";
export type { AnswerHandlerDispatchResult } from "./engine/question-answering";
export type { QuestionRecord } from "./projections/questions";
export type { SearchDocumentResult } from "./core/processor";
