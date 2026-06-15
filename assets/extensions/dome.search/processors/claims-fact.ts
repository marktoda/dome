// Shared decoder for dome.claims.claim facts in dome.search view processors.
//
// dome.claims.index stores each claim's object as the canonical JSON string
// `{key, value, asOf?}` (see assets/extensions/dome.claims/processors/
// claim-index.ts). This module is the one place that decodes that blob, so
// the label, ordering, overview, and ranking paths all agree on the shape.

import type { FactEffect } from "../../../../src/core/effect";

export const CLAIM_PREDICATE = "dome.claims.claim";

export type ClaimFact = {
  readonly key: string;
  readonly value: string;
  readonly asOf: string | null;
};

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
  return Object.freeze({
    key: record.key,
    value: record.value,
    asOf: typeof record.asOf === "string" ? record.asOf : null,
  });
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
