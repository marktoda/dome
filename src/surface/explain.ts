// surface/explain: the provenance collector behind `dome explain` — the
// answer to "why do I believe X" for a vault page or one anchored claim on
// it. Read-only; degrades gracefully (a path with no claims or facts still
// explains its commits).
//
// The chain it renders, target `"<path>"` or `"<path>#^<anchor>"`:
//
//   claim   — when the target carries a `^c…` anchor, the adopted-state
//             `dome.claims.claim` fact whose sourceRef stableId is that
//             anchor, decoded via the canonical claim-fact codec
//             (assets/extensions/dome.claims/processors/claim-fact.ts —
//             same asset-import precedent as src/surface/settle.ts). The
//             projection row IS the adopted-state truth: value/asOf ride
//             the fact object, anchor/line ride the sourceRef, so nothing
//             re-parses markdown here.
//   facts   — projection fact rows whose page subject is the target path
//             (narrowed to the anchor's sourceRefs when one is given), with
//             the inspection provenance `queryFactRecords` carries:
//             namespace, predicate, processorId, runId, adoptedCommit,
//             writtenAt, and the first path-matching sourceRef.
//   runs    — the distinct runIds above joined against the run ledger
//             (src/ledger/runs.ts `getRun`). A run the retention pass has
//             pruned still appears, marked `inLedger: false` — provenance
//             should be loud about aged-out evidence, not silently shorter.
//   commits — the newest 10 commits touching the path (`logWithTrailers`,
//             src/git.ts), Dome-Run / Dome-Extension trailers pre-parsed —
//             the engine-commit end of the chain.
//
// Posture: like the status/check collectors, this is an operator internal
// over runtime guts the public `Vault` wrapper hides (projectionDb +
// ledgerDb), so `buildExplain` opens `openVaultRuntime` directly — the
// documented exception in src/vault.ts's entry-point convention. The core
// `collectExplain(runtime, target)` is pure over an already-open runtime so
// adapters that hold one (or tests) can call it without the open/close.

import { join } from "node:path";
import {
  runtimeOpenFailureInfo,
  type RuntimeOpenFailureInfo,
} from "./adapter";

import {
  CLAIM_PREDICATE,
  parseClaimFact,
} from "../../assets/extensions/dome.claims/processors/claim-fact";
import { getAdoptedRef, getCurrentBranch } from "../adopted-ref";
import type { SourceRef } from "../core/source-ref";
import {
  openVaultRuntime,
  type VaultRuntime,
} from "../engine/host/vault-runtime";
import { resolveBundleRoots } from "../extensions/bundle-roots";
import { logWithTrailers, readBlob } from "../git";
import { getRun, type RunId, type RunStatus } from "../ledger/runs";
import { queryFactRecords, type FactRecord } from "../projections/facts";
import { resolveVaultPath } from "./resolve-vault";

// ----- Public types ----------------------------------------------------------

export const EXPLAIN_SCHEMA = "dome.explain/v1";

/** How many commits touching the path the view carries (newest first). */
const COMMIT_LIMIT = 10;

export type ExplainClaim = {
  readonly key: string;
  readonly value: string;
  readonly asOf: string | null;
  readonly anchor: string;
  /** 1-based start line of the claim in the adopted blob (from the fact's sourceRef). */
  readonly line: number | null;
};

export type ExplainSourceRef = {
  readonly path: string;
  readonly commit: string;
  readonly anchor: string | null;
  readonly startLine: number | null;
  readonly endLine: number | null;
};

export type ExplainFact = {
  readonly namespace: string;
  readonly predicate: string;
  readonly processorId: string;
  readonly runId: string;
  readonly adoptedCommit: string;
  readonly writtenAt: string;
  readonly sourceRef: ExplainSourceRef | null;
};

export type ExplainRun = {
  readonly runId: string;
  readonly processorId: string;
  readonly startedAt: string | null;
  readonly status: RunStatus | null;
  readonly costUsd: number | null;
  /** false when the run ledger no longer holds the row (retention aged it out). */
  readonly inLedger: boolean;
};

export type ExplainCommit = {
  readonly sha: string;
  readonly subject: string;
  /** ISO-8601 committer timestamp. */
  readonly committedAt: string;
  readonly domeRun: string | null;
  readonly domeExtension: string | null;
};

export type ExplainView = {
  readonly schema: typeof EXPLAIN_SCHEMA;
  readonly target: string;
  readonly path: string;
  readonly anchor: string | null;
  readonly adoptedCommit: string;
  readonly claim: ExplainClaim | null;
  readonly facts: ReadonlyArray<ExplainFact>;
  readonly runs: ReadonlyArray<ExplainRun>;
  readonly commits: ReadonlyArray<ExplainCommit>;
};

export type ExplainOutcome =
  | { readonly kind: "ok"; readonly view: ExplainView }
  | { readonly kind: "unknown-path"; readonly message: string }
  | { readonly kind: "invalid-target"; readonly message: string };

export type BuildExplainOutcome =
  | ExplainOutcome
  | ({ readonly kind: "runtime-open-failed" } & RuntimeOpenFailureInfo);

// ----- collectExplain ----------------------------------------------------------

/**
 * Collect the `dome.explain/v1` view for one target over an already-open
 * runtime. `target` is `"<path>"` or `"<path>#^<anchor>"`. A path absent
 * from the adopted state is `unknown-path`; a path with no claims or facts
 * still returns its commits.
 */
export async function collectExplain(
  runtime: VaultRuntime,
  target: string,
): Promise<ExplainOutcome> {
  const parsed = parseExplainTarget(target);
  if (parsed === null) {
    return Object.freeze({
      kind: "invalid-target" as const,
      message:
        `"${target}" is not a valid explain target; expected ` +
        `"<path>" or "<path>#^<anchor>"`,
    });
  }
  const { path, anchor } = parsed;

  const branch = await getCurrentBranch(runtime.path);
  const adopted =
    branch === null ? null : await getAdoptedRef(runtime.path, branch);
  if (adopted === null) {
    return Object.freeze({
      kind: "invalid-target" as const,
      message:
        branch === null
          ? "detached HEAD: explain reads adopted state; check out a branch first"
          : `no adopted state yet on branch ${branch}; run \`dome sync\` first`,
    });
  }

  const content = await readBlob({
    path: runtime.path,
    commit: adopted,
    filepath: path,
  });
  if (content === null) {
    return Object.freeze({
      kind: "unknown-path" as const,
      message: `${path} does not exist in the adopted state (${adopted.slice(0, 7)})`,
    });
  }

  const pageRecords = queryFactRecords(runtime.projectionDb, {
    subjectKind: "page",
    subjectId: path,
  });
  const records =
    anchor === null
      ? pageRecords
      : pageRecords.filter((record) =>
          record.effect.sourceRefs.some((ref) => ref.stableId === anchor),
        );

  const facts = records.map((record) => toExplainFact(record, path));
  const claim = anchor === null ? null : decodeClaim(records, anchor);
  const runs = joinRuns(runtime, records);

  const commits = (
    await logWithTrailers({ path: join(runtime.path, path), limit: COMMIT_LIMIT })
  ).map((entry) =>
    Object.freeze({
      sha: entry.sha,
      subject: entry.subject,
      committedAt: entry.at,
      domeRun: entry.domeRun,
      domeExtension: entry.domeExtension,
    }),
  );

  return Object.freeze({
    kind: "ok" as const,
    view: Object.freeze({
      schema: EXPLAIN_SCHEMA,
      target,
      path,
      anchor,
      adoptedCommit: adopted,
      claim,
      facts: Object.freeze(facts),
      runs,
      commits: Object.freeze(commits),
    }),
  });
}

// ----- buildExplain --------------------------------------------------------------

/**
 * Open the vault runtime, collect the explain view, always close — the
 * per-invocation lifecycle the CLI verb and MCP tool share (mirrors
 * `buildCheckReport`).
 */
export async function buildExplain(opts: {
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly target: string;
}): Promise<BuildExplainOutcome> {
  const vaultPath = resolveVaultPath(opts.vault);
  const bundleRoots = resolveBundleRoots({
    vaultPath,
    bundlesRoot: opts.bundlesRoot,
  });
  const runtimeResult = await openVaultRuntime({ vaultPath, ...bundleRoots });
  if (!runtimeResult.ok) {
    return Object.freeze({
      kind: "runtime-open-failed" as const,
      ...runtimeOpenFailureInfo(runtimeResult.error),
    });
  }
  const runtime = runtimeResult.value;
  try {
    return await collectExplain(runtime, opts.target);
  } finally {
    await runtime.close();
  }
}

// ----- JSON mapper -----------------------------------------------------------------

/** Render an `ExplainView` as its `dome.explain/v1` document body. */
export function explainJson(view: ExplainView): Record<string, unknown> {
  return {
    schema: view.schema,
    target: view.target,
    path: view.path,
    anchor: view.anchor,
    adopted_commit: view.adoptedCommit,
    claim:
      view.claim === null
        ? null
        : {
            key: view.claim.key,
            value: view.claim.value,
            as_of: view.claim.asOf,
            anchor: view.claim.anchor,
            line: view.claim.line,
          },
    facts: view.facts.map((fact) => ({
      namespace: fact.namespace,
      predicate: fact.predicate,
      processor_id: fact.processorId,
      run_id: fact.runId,
      adopted_commit: fact.adoptedCommit,
      written_at: fact.writtenAt,
      source_ref:
        fact.sourceRef === null
          ? null
          : {
              path: fact.sourceRef.path,
              commit: fact.sourceRef.commit,
              anchor: fact.sourceRef.anchor,
              start_line: fact.sourceRef.startLine,
              end_line: fact.sourceRef.endLine,
            },
    })),
    runs: view.runs.map((run) => ({
      run_id: run.runId,
      processor_id: run.processorId,
      started_at: run.startedAt,
      status: run.status,
      cost_usd: run.costUsd,
      in_ledger: run.inLedger,
    })),
    commits: view.commits.map((commit) => ({
      sha: commit.sha,
      subject: commit.subject,
      committed_at: commit.committedAt,
      dome_run: commit.domeRun,
      dome_extension: commit.domeExtension,
    })),
  };
}

// ----- internals -----------------------------------------------------------------

/**
 * Split `"<path>#^<anchor>"` / `"<path>"`. The stored anchor id has no `^`
 * (sourceRef stableIds are bare ids), so a leading `^` is stripped; a bare
 * `path#anchor` is accepted too. Empty path or empty anchor → null.
 */
function parseExplainTarget(
  target: string,
): { readonly path: string; readonly anchor: string | null } | null {
  const trimmed = target.trim();
  if (trimmed.length === 0) return null;
  const hash = trimmed.indexOf("#");
  if (hash === -1) return { path: trimmed, anchor: null };
  const path = trimmed.slice(0, hash).trim();
  const anchor = trimmed.slice(hash + 1).replace(/^\^/, "").trim();
  if (path.length === 0 || anchor.length === 0) return null;
  return { path, anchor };
}

/** The first sourceRef on the record whose path matches the target. */
function refForPath(record: FactRecord, path: string): SourceRef | null {
  return record.effect.sourceRefs.find((ref) => ref.path === path) ?? null;
}

function toExplainFact(record: FactRecord, path: string): ExplainFact {
  const ref = refForPath(record, path);
  return Object.freeze({
    namespace: record.namespace,
    predicate: record.effect.predicate,
    processorId: record.processorId,
    runId: record.runId,
    adoptedCommit: record.adoptedCommit,
    writtenAt: record.writtenAt,
    sourceRef:
      ref === null
        ? null
        : Object.freeze({
            path: ref.path,
            commit: ref.commit,
            anchor: ref.stableId ?? null,
            startLine: ref.range?.startLine ?? null,
            endLine: ref.range?.endLine ?? null,
          }),
  });
}

/**
 * Decode the anchored `dome.claims.claim` fact into the claim header. The
 * fact object carries key/value/asOf; the anchor-matching sourceRef carries
 * the line. Null when the anchor names no claim fact (the anchor may be a
 * task `^t…` id or a hand-authored anchor — facts/commits still render).
 */
function decodeClaim(
  records: ReadonlyArray<FactRecord>,
  anchor: string,
): ExplainClaim | null {
  for (const record of records) {
    if (record.effect.predicate !== CLAIM_PREDICATE) continue;
    const ref = record.effect.sourceRefs.find((r) => r.stableId === anchor);
    if (ref === undefined) continue;
    const decoded = parseClaimFact(record.effect);
    if (decoded === null) continue;
    return Object.freeze({
      key: decoded.key,
      value: decoded.value,
      asOf: decoded.asOf,
      anchor,
      line: ref.range?.startLine ?? null,
    });
  }
  return null;
}

/**
 * Join the distinct runIds (first-seen order) against the run ledger. A
 * pruned run keeps its row with `inLedger: false` and the processorId the
 * fact recorded — aged-out evidence stays visible, not silently dropped.
 */
function joinRuns(
  runtime: VaultRuntime,
  records: ReadonlyArray<FactRecord>,
): ReadonlyArray<ExplainRun> {
  const seen = new Map<string, string>();
  for (const record of records) {
    if (!seen.has(record.runId)) seen.set(record.runId, record.processorId);
  }
  const runs: ExplainRun[] = [];
  for (const [runId, factProcessorId] of seen) {
    const row = getRun(runtime.ledgerDb, runId as RunId);
    runs.push(
      row === null
        ? Object.freeze({
            runId,
            processorId: factProcessorId,
            startedAt: null,
            status: null,
            costUsd: null,
            inLedger: false,
          })
        : Object.freeze({
            runId,
            processorId: row.processorId,
            startedAt: row.startedAt,
            status: row.status,
            costUsd: row.costUsd,
            inLedger: true,
          }),
    );
  }
  return Object.freeze(runs);
}
