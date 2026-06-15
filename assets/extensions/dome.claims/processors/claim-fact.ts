// dome.claims — the single canonical claim-fact contract.
//
// This module owns the `dome.claims.claim` fact shape end to end: the predicate
// constant, the ENCODE side (`claimFactValue`, used by dome.claims.index when it
// projects claim lines into facts), the DECODE side (`parseClaimFact`, used by
// every consumer that reads those facts back — dome.search's label/ordering/
// overview/ranking paths and dome.claims.stale-claims), and the human label
// (`claimLabel`). It lives in dome.claims because dome.claims owns the fact
// shape; co-locating the inverse pair `claimFactValue` / `parseClaimFact` here
// means encode and decode cannot drift out of sync.
//
// The indexer stores each claim's verbatim value WITH its inline
// `*(as of YYYY-MM-DD)*` marker, alongside the structured `asOf` date.
// `parseClaimFact` strips that marker so `value`/`asOf` are presented as clean,
// separate fields — otherwise `claimLabel` would append `(as of …)` to a value
// that already carries the date, doubling it. The strip regex mirrors the
// indexer's AS_OF_RE in ./claims-shared.

import type { FactEffect } from "../../../../src/core/effect";

import type { ClaimLine } from "./claims-shared";

export const CLAIM_PREDICATE = "dome.claims.claim";

/**
 * The inline `*(as of YYYY-MM-DD)*` claim-value marker, for GLOBAL stripping.
 * Single source for both the decode-side clean (`parseClaimFact` here) and the
 * render-side clean (`dome.claims.render-facts`), so the two can't drift. The
 * date pattern mirrors the indexer's `AS_OF_RE` in ./claims-shared.
 */
export const AS_OF_MARKER_RE = /\s*\*\(as of \d{4}-\d{2}-\d{2}\)\*/g;

export type ClaimFact = {
  readonly key: string;
  readonly value: string;
  readonly asOf: string | null;
};

/** Canonical JSON encoding of a claim for the fact object literal. */
export function claimFactValue(claim: ClaimLine): string {
  return JSON.stringify({
    key: claim.key,
    value: claim.value,
    ...(claim.asOf !== null ? { asOf: claim.asOf } : {}),
  });
}

/** Decode a `dome.claims.claim` fact, or null if it is not one / is malformed. */
export function parseClaimFact(fact: FactEffect): ClaimFact | null {
  if (fact.predicate !== CLAIM_PREDICATE || fact.object.kind !== "string") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fact.object.value);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.key !== "string" || typeof record.value !== "string") {
    return null;
  }
  const asOf = typeof record.asOf === "string" ? record.asOf : null;
  // Strip the inline `*(as of YYYY-MM-DD)*` marker(s) so `value` is clean
  // alongside the structured `asOf` (see header). The leading `\s*` absorbs the
  // separating space; the `\s{2,}` collapse + trim tidy any residual run.
  const value = record.value
    .replace(AS_OF_MARKER_RE, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return Object.freeze({ key: record.key, value, asOf });
}

/** Human-legible one-line label: `Key: value (as of YYYY-MM-DD)`. */
export function claimLabel(claim: ClaimFact): string {
  return claim.asOf !== null
    ? `${claim.key}: ${claim.value} (as of ${claim.asOf})`
    : `${claim.key}: ${claim.value}`;
}

/** True when the fact is a decodable claim fact. */
export function isClaimFact(fact: FactEffect): boolean {
  return parseClaimFact(fact) !== null;
}
