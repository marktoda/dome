// dome.health.trust-review — the pure core (separated from the processor
// wiring, the report-card-render pattern). The trust ladder: the gardener
// proposes changes to its OWN autonomy through the existing proposal review
// loop — a promotion is a comment-preserving `.dome/config.yaml` diff enqueued
// as an ordinary propose-mode PatchEffect the owner reviews with `dome apply`.
// No new engine primitive; no self-granted capability, ever.
//
// Everything here is pure string/data work — no clock, no IO, no Effects.
// The processor (`trust-review.ts`) owns the reads and the emission.
//
// Normative: [[wiki/specs/proposals]] §"Trust ladder".

import type {
  OperationalProposalRow,
  OperationalRunRow,
} from "../../../../src/core/processor";
import { canonicalVaultPath } from "../../../../src/core/vault-path";
import {
  parseCapabilityPolicy,
  type CapabilityPolicy,
} from "../../../../src/engine/core/capability-policy";
import { pathCapabilityMatches } from "../../../../src/engine/core/path-capabilities";
import {
  FIRST_PARTY_EXTENSION_DEFAULTS,
  type FirstPartyExtensionDefault,
} from "../../../../src/first-party-defaults";

import { isMap, parseDocument, type Document, type YAMLMap } from "yaml";

// ----- Identity + thresholds --------------------------------------------------

export const TRUST_REVIEW_PROCESSOR_ID = "dome.health.trust-review";
export const CONFIG_PATH = ".dome/config.yaml";

/** Trailing window (days) for decided-proposal stats + rejection cool-down. */
export const TRUST_WINDOW_DAYS = 28;
/** Trailing window (days) for the dormancy check (cost with no output). */
export const DORMANT_WINDOW_DAYS = 21;
/** Minimum decided proposals in the window before promotion is considered. */
export const PROMOTE_MIN_DECIDED = 8;
/** Minimum applied/decided ratio before promotion is considered. */
export const PROMOTE_MIN_ACCEPT_RATE = 0.75;

// ----- Input shapes -----------------------------------------------------------

/** One proposal-producing processor's evidence within the trailing window. */
export type TrustProposalStats = {
  readonly processorId: string;
  readonly extensionId: string;
  /** Proposals DECIDED (applied or rejected) in the window, by `decidedAt`. */
  readonly decided: number;
  /** Of `decided`, how many were applied. */
  readonly applied: number;
  /** Union of paths this processor's windowed proposals touch (sorted). */
  readonly proposedPaths: ReadonlyArray<string>;
  /**
   * Whether the vault GRANT already auto-applies the proposed paths.
   * `"unknown"` when the config was unreadable — never promoted (the ladder
   * refuses to reason about a grant surface it cannot see).
   */
  readonly autonomy: "auto" | "propose" | "unknown";
  /** An open trust-review promotion proposal already targets this processor. */
  readonly pendingPromotion: boolean;
  /** Most recent REJECTED promotion's `decidedAt`, or null if none ever. */
  readonly promotionRejectedAt: string | null;
};

/** One processor's run-ledger evidence over the trailing dormancy window. */
export type TrustRunStats = {
  readonly processorId: string;
  readonly costUsd: number;
  /** Succeeded runs that emitted ≥1 effect (the report card's definition). */
  readonly productive: number;
};

export type TrustReviewInput = {
  readonly nowIso: string;
  readonly proposalStats: ReadonlyArray<TrustProposalStats>;
  readonly runStats: ReadonlyArray<TrustRunStats>;
};

export type TrustDecision =
  | {
      readonly kind: "promote";
      readonly processorId: string;
      readonly extensionId: string;
      readonly autoPaths: ReadonlyArray<string>;
      readonly evidence: string;
    }
  | {
      readonly kind: "flag-dormant";
      readonly processorId: string;
      readonly evidence: string;
    };

// ----- decideTrustReview ------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The trust ladder's decision rules, pure over pre-aggregated evidence.
 *
 * Promote (per processor) when ALL hold:
 *   - the effective grant is propose-only for the proposed paths,
 *   - ≥ PROMOTE_MIN_DECIDED proposals decided in the trailing 28 days,
 *   - accept rate (applied/decided) ≥ PROMOTE_MIN_ACCEPT_RATE,
 *   - no promotion proposal for it is still pending review,
 *   - no promotion proposal for it was rejected within the last 28 days
 *     (derived from the rejected row's decidedAt — no new state),
 *   - the proposed paths do NOT include `.dome/config.yaml` (a processor
 *     proposing config edits must never be auto-granted them — that would be
 *     an unreviewed privilege escalation), and it is not trust-review itself.
 *
 * Flag dormant (per processor) when model cost > $0 accrued over the trailing
 * 21 days with ZERO productive effects (a deterministic zero-cost idler is the
 * report card's "possibly idle" concern, not the trust ladder's).
 *
 * Deterministic: decisions sort promote-first, then by processorId.
 */
export function decideTrustReview(
  input: TrustReviewInput,
): ReadonlyArray<TrustDecision> {
  const rejectionCutoffIso = new Date(
    Date.parse(input.nowIso) - TRUST_WINDOW_DAYS * DAY_MS,
  ).toISOString();

  const promotions: TrustDecision[] = [...input.proposalStats]
    .filter(
      (s) =>
        s.processorId !== TRUST_REVIEW_PROCESSOR_ID &&
        s.autonomy === "propose" &&
        s.decided >= PROMOTE_MIN_DECIDED &&
        s.applied / s.decided >= PROMOTE_MIN_ACCEPT_RATE &&
        !s.pendingPromotion &&
        (s.promotionRejectedAt === null ||
          s.promotionRejectedAt < rejectionCutoffIso) &&
        s.proposedPaths.length > 0 &&
        !s.proposedPaths.includes(CONFIG_PATH),
    )
    .sort((a, b) => compare(a.processorId, b.processorId))
    .map((s) =>
      Object.freeze({
        kind: "promote" as const,
        processorId: s.processorId,
        extensionId: s.extensionId,
        autoPaths: s.proposedPaths,
        evidence: promotionReason(s.processorId, s.applied, s.decided),
      }),
    );

  const dormant: TrustDecision[] = [...input.runStats]
    .filter((s) => s.costUsd > 0 && s.productive === 0)
    .sort((a, b) => compare(a.processorId, b.processorId))
    .map((s) =>
      Object.freeze({
        kind: "flag-dormant" as const,
        processorId: s.processorId,
        evidence:
          `${s.processorId} spent $${s.costUsd.toFixed(2)} over the last ` +
          `${DORMANT_WINDOW_DAYS} days with zero productive effects`,
      }),
    );

  return Object.freeze([...promotions, ...dormant]);
}

// ----- Promotion-proposal identity (reason-string, no new state) ---------------

/**
 * The promotion proposal's `reason` — structured so suppression can re-derive
 * the target from durable proposal rows alone (`parsePromotionTarget`).
 * Example: `trust-review: promote dome.agent.consolidate to auto-apply —
 * 19/20 proposals applied over 28d`.
 */
export function promotionReason(
  processorId: string,
  applied: number,
  decided: number,
): string {
  return (
    `trust-review: promote ${processorId} to auto-apply — ` +
    `${applied}/${decided} proposals applied over ${TRUST_WINDOW_DAYS}d`
  );
}

const PROMOTION_REASON_RE = /^trust-review: promote (\S+) to auto-apply/;

/** The target processorId of a trust-review promotion row, or null. */
export function parsePromotionTarget(reason: string): string | null {
  const match = PROMOTION_REASON_RE.exec(reason);
  return match?.[1] ?? null;
}

// ----- Proposal-row aggregation -----------------------------------------------

export type ProposalActivity = {
  readonly processorId: string;
  readonly extensionId: string;
  readonly decided: number;
  readonly applied: number;
  /** Union of paths across the processor's windowed proposals, sorted. */
  readonly proposedPaths: ReadonlyArray<string>;
};

/**
 * Fold proposal rows into per-processor decided/applied counts within
 * `[windowStartIso, now]` — decided rows bucket by `decidedAt`, path
 * membership by any activity (created OR decided) in the window. Trust-review's
 * own rows (the promotion proposals) are excluded — they are the ladder's
 * bookkeeping, not producer evidence. Sorted by processorId ascending.
 */
export function aggregateProposalActivity(
  rows: ReadonlyArray<OperationalProposalRow>,
  windowStartIso: string,
): ReadonlyArray<ProposalActivity> {
  const byId = new Map<
    string,
    { extensionId: string; decided: number; applied: number; paths: Set<string> }
  >();
  for (const row of rows) {
    if (row.processorId === TRUST_REVIEW_PROCESSOR_ID) continue;
    const decidedInWindow =
      row.status !== "pending" &&
      row.decidedAt !== null &&
      row.decidedAt >= windowStartIso;
    const createdInWindow = row.createdAt >= windowStartIso;
    if (!decidedInWindow && !createdInWindow) continue;
    const stat = byId.get(row.processorId) ?? {
      extensionId: row.extensionId,
      decided: 0,
      applied: 0,
      paths: new Set<string>(),
    };
    if (decidedInWindow) {
      stat.decided += 1;
      if (row.status === "applied") stat.applied += 1;
    }
    for (const path of row.paths) stat.paths.add(path);
    byId.set(row.processorId, stat);
  }
  return Object.freeze(
    [...byId.entries()]
      .map(([processorId, s]) =>
        Object.freeze({
          processorId,
          extensionId: s.extensionId,
          decided: s.decided,
          applied: s.applied,
          proposedPaths: Object.freeze([...s.paths].sort(compare)),
        }),
      )
      .sort((a, b) => compare(a.processorId, b.processorId)),
  );
}

/**
 * Promotion-suppression state for one target processor, derived from
 * trust-review's OWN durable proposal rows (reason-string identity — no new
 * state): whether a promotion is still pending, and the most recent
 * rejection's decidedAt.
 */
export function promotionSuppression(
  rows: ReadonlyArray<OperationalProposalRow>,
  targetProcessorId: string,
): { readonly pending: boolean; readonly rejectedAt: string | null } {
  let pending = false;
  let rejectedAt: string | null = null;
  for (const row of rows) {
    if (row.processorId !== TRUST_REVIEW_PROCESSOR_ID) continue;
    if (parsePromotionTarget(row.reason) !== targetProcessorId) continue;
    if (row.status === "pending") pending = true;
    if (
      row.status === "rejected" &&
      row.decidedAt !== null &&
      (rejectedAt === null || row.decidedAt > rejectedAt)
    ) {
      rejectedAt = row.decidedAt;
    }
  }
  return Object.freeze({ pending, rejectedAt });
}

// ----- Autonomy (granted-side) resolution ---------------------------------------

/**
 * Whether the vault GRANT already auto-applies every one of `paths` for
 * `(extensionId, processorId)` — resolved through `parseCapabilityPolicy`
 * (the engine's own preset/precedence semantics) + `pathCapabilityMatches`
 * (the broker's own glob matcher), never a parallel impl.
 *
 * Granted-side only: manifests are SDK assets, not vault content, so the
 * processor cannot see declarations; a grant-side `patch.auto` covering the
 * paths already makes a promotion pointless, which is all the ladder needs.
 */
export function grantedAutonomy(opts: {
  readonly policy: CapabilityPolicy | null;
  readonly extensionId: string;
  readonly processorId: string;
  readonly paths: ReadonlyArray<string>;
}): "auto" | "propose" | "unknown" {
  if (opts.policy === null || opts.paths.length === 0) return "unknown";
  const granted = opts.policy.grantsForProcessor(
    opts.extensionId,
    opts.processorId,
  );
  for (const raw of opts.paths) {
    const path = canonicalVaultPath(raw);
    if (path === null) return "unknown";
    if (!pathCapabilityMatches("patch.auto", path, granted)) return "propose";
  }
  return "auto";
}

/** Parse a config body into a policy, or null on any parse failure. */
export function policyFromConfigBody(body: string): CapabilityPolicy | null {
  const parsed = parseCapabilityPolicy(body);
  return parsed.ok ? parsed.value : null;
}

// ----- The comment-preserving promotion edit ------------------------------------

const FIRST_PARTY_DEFAULTS_BY_ID: ReadonlyMap<string, FirstPartyExtensionDefault> =
  new Map(FIRST_PARTY_EXTENSION_DEFAULTS.map((entry) => [entry.id, entry]));

export type PromotionEditResult =
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly error: string };

/**
 * Produce the promoted `.dome/config.yaml` body: a comment-preserving yaml
 * Document edit (the `dome init` ensure-path precedent) that sets
 * `extensions.<extensionId>.processors.<processorId>.grant` to the
 * processor's CURRENT effective grant record plus `patch.auto` over
 * `autoPaths` — a per-processor grant REPLACES the bundle grant
 * (capability-policy precedence), so the other grants are carried over, never
 * stripped.
 *
 * Preset interaction: an extension with no explicit grant/grants/processors
 * block rides `grants: standard`; adding a processors block would opt the
 * WHOLE extension out of the preset, so in that case the shipped first-party
 * defaults (bundle grant + per-processor replacement grants) are first
 * materialized as explicit blocks. Untouched nodes keep their comments.
 *
 * Validity is structurally self-checked: the edited body must round-trip
 * through `parseCapabilityPolicy` AND the promoted processor's resolved grant
 * must now `patch.auto`-match every autoPath — an invalid edit returns an
 * error instead of ever becoming a proposal.
 */
export function promoteProcessorGrantInConfig(opts: {
  readonly configBody: string;
  readonly extensionId: string;
  readonly processorId: string;
  readonly autoPaths: ReadonlyArray<string>;
}): PromotionEditResult {
  if (opts.autoPaths.length === 0) {
    return { ok: false, error: "no paths to promote" };
  }
  const doc = parseDocument(opts.configBody);
  if (!isMap(doc.contents)) {
    return { ok: false, error: `${CONFIG_PATH} must be a YAML mapping` };
  }
  const root = doc.contents;
  const extensions = mapAt(root, "extensions");
  if (extensions === null) {
    return { ok: false, error: `${CONFIG_PATH} has no extensions mapping` };
  }
  const extension = mapAt(extensions, opts.extensionId);
  if (extension === null) {
    return {
      ok: false,
      error: `extensions.${opts.extensionId} is not configured`,
    };
  }

  // Materialize the `grants: standard` preset for THIS extension before
  // adding an explicit processors block (which opts the extension out of the
  // preset entirely — capability-policy precedence).
  const hasExplicitBlock =
    extension.has("grant") ||
    extension.has("grants") ||
    extension.has("processors");
  if (!hasExplicitBlock) {
    // `get(key, true)` returns the scalar VALUE (not the wrapping node).
    if (root.get("grants", true)?.toJSON() !== "standard") {
      return {
        ok: false,
        error:
          `extensions.${opts.extensionId} has no grant block and no ` +
          "grants: standard preset — nothing to promote from",
      };
    }
    const preset = FIRST_PARTY_DEFAULTS_BY_ID.get(opts.extensionId);
    if (preset === undefined) {
      return {
        ok: false,
        error: `extensions.${opts.extensionId} has no shipped preset defaults`,
      };
    }
    extension.set(doc.createNode("grant"), doc.createNode(preset.grant));
    if (preset.processors !== undefined) {
      const processorsNode: Record<string, unknown> = {};
      for (const [pid, grant] of Object.entries(preset.processors)) {
        processorsNode[pid] = { grant };
      }
      extension.set(
        doc.createNode("processors"),
        doc.createNode(processorsNode),
      );
    }
  }

  // The processor's CURRENT effective grant record (raw config shape), same
  // precedence as capability-policy: per-processor replacement block first,
  // else the extension block.
  const currentGrant = currentGrantRecord(extension, opts.processorId);
  if (currentGrant === null) {
    return {
      ok: false,
      error:
        `no grant record found for ${opts.processorId} under ` +
        `extensions.${opts.extensionId}`,
    };
  }

  const mergedAuto = mergePaths(currentGrant["patch.auto"], opts.autoPaths);
  const newGrant: Record<string, unknown> = {
    ...currentGrant,
    "patch.auto": mergedAuto,
  };
  const processors = ensureMapAt(doc, extension, "processors");
  processors.set(
    doc.createNode(opts.processorId),
    doc.createNode({ grant: newGrant }),
  );

  const content = doc.toString({ lineWidth: 0, flowCollectionPadding: false });

  // Structural self-check: never emit a config the engine would refuse or
  // that fails to actually promote.
  const parsed = parseCapabilityPolicy(content);
  if (!parsed.ok) {
    return { ok: false, error: `promoted config failed to parse: ${parsed.error}` };
  }
  const promoted = grantedAutonomy({
    policy: parsed.value,
    extensionId: opts.extensionId,
    processorId: opts.processorId,
    paths: opts.autoPaths,
  });
  if (promoted !== "auto") {
    return {
      ok: false,
      error: `promoted config does not grant patch.auto (${promoted})`,
    };
  }
  return { ok: true, content };
}

// ----- yaml Document helpers (local mirrors of init.ts's private helpers) ------

function mapAt(map: YAMLMap, key: string): YAMLMap | null {
  const value = map.get(key);
  return isMap(value) ? value : null;
}

function ensureMapAt(doc: Document, map: YAMLMap, key: string): YAMLMap {
  const existing = map.get(key);
  if (isMap(existing)) return existing;
  const created = doc.createNode({});
  map.set(doc.createNode(key), created);
  return created;
}

/**
 * The raw grant record effective for `processorId` inside an extension node
 * that already carries explicit blocks: `processors.<id>.grant`/`grants`
 * first (replacement semantics), else the extension `grant`/`grants` block.
 */
function currentGrantRecord(
  extension: YAMLMap,
  processorId: string,
): Record<string, unknown> | null {
  const processors = mapAt(extension, "processors");
  if (processors !== null) {
    const processor = mapAt(processors, processorId);
    if (processor !== null) {
      const record = grantRecordOf(processor);
      if (record !== null) return record;
    }
  }
  return grantRecordOf(extension);
}

function grantRecordOf(node: YAMLMap): Record<string, unknown> | null {
  const grant = mapAt(node, "grant") ?? mapAt(node, "grants");
  if (grant === null) return null;
  const json: unknown = grant.toJSON();
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    return null;
  }
  return json as Record<string, unknown>;
}

/** Merge `additions` into an existing patch.auto value (string | string[]). */
function mergePaths(
  existing: unknown,
  additions: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const out: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && value.length > 0 && !out.includes(value)) {
      out.push(value);
    }
  };
  if (typeof existing === "string") push(existing);
  if (Array.isArray(existing)) for (const value of existing) push(value);
  for (const value of additions) push(value);
  return out;
}

// ----- Run-row aggregation (dormancy) -------------------------------------------

/**
 * Fold run rows into per-processor cost + productive counts for the dormancy
 * check. Productive = `succeeded` with ≥1 emitted effect (the report card's
 * definition). Sorted by processorId ascending.
 */
export function aggregateRunActivity(
  rows: ReadonlyArray<OperationalRunRow>,
): ReadonlyArray<TrustRunStats> {
  const byId = new Map<string, { costUsd: number; productive: number }>();
  for (const row of rows) {
    const stat = byId.get(row.processorId) ?? { costUsd: 0, productive: 0 };
    stat.costUsd += row.costUsd ?? 0;
    if (row.status === "succeeded" && row.effectCount > 0) stat.productive += 1;
    byId.set(row.processorId, stat);
  }
  return Object.freeze(
    [...byId.entries()]
      .map(([processorId, s]) => Object.freeze({ processorId, ...s }))
      .sort((a, b) => compare(a.processorId, b.processorId)),
  );
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
