// dome.claims.stale-claims — Phase C view-phase processor: the "coherence over
// time" instrument for the claims loop.
//
// Lists every dome.claims.claim whose `*(as of)*` date is older than a
// configurable horizon. Staleness depends on the CURRENT date, so it MUST be a
// view-phase computation measured against the injected clock `ctx.now()` —
// NEVER a persisted fact. Persisting "stale" would break
// PROJECTIONS_ARE_REBUILDABLE (a rebuild at a later date would mint different
// rows from identical adopted markdown). The `asOf` date itself is durable on
// every claim fact (emitted clock-free by the adoption-phase claim indexer);
// this processor only joins it against time at command time. Same rebuild-safe
// pattern as dome.search's recency decay.
//
// Per [[wiki/specs/processors]] §"View phase": read-only. Reads claim facts via
// `ctx.projection.facts(...)` and emits a single structured ViewEffect. Mirrors
// dome.markdown/processors/orphan-pages.ts for structure and effect
// construction.
//
// This file lives under `assets/` which is excluded from the root
// `tsconfig.json`. Imports use relative paths into `src/`, resolved at runtime
// by Bun's dynamic-import loader.

import {
  viewEffect,
  type Effect,
  type FactEffect,
  type ViewEffect,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ExtensionConfig,
  type ProcessorContext,
} from "../../../../src/core/processor";

// ----- Constants ------------------------------------------------------------

const VIEW_NAME = "dome.claims.stale-claims";
const VIEW_SCHEMA = "dome.claims.stale-claims/v1";

const CLAIM_PREDICATE = "dome.claims.claim";
const DEFAULT_STALE_HORIZON_DAYS = 120;
const MS_PER_DAY = 86_400_000;

// ----- Claim decoder ---------------------------------------------------------
// NOTE: mirrors assets/extensions/dome.search/processors/claims-fact.ts
// (parseClaimFact), including the inline `*(as of YYYY-MM-DD)*` marker strip on
// `value`. The indexer stores the verbatim value WITH that marker and extracts
// `asOf` separately, so an unstripped value would carry the date twice; the
// strip keeps `value` clean alongside the structured `asOf`. Kept local so
// dome.claims doesn't take a cross-extension dependency on dome.search. The
// long-term fix is to move the canonical decoder into dome.claims (with
// dome.search importing it) — a follow-on, not now.

type ClaimFact = {
  readonly key: string;
  readonly value: string;
  readonly asOf: string | null;
};

/** Decode a `dome.claims.claim` fact, or null if it is not one / is malformed. */
function parseClaimFact(fact: FactEffect): ClaimFact | null {
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
  // alongside the structured `asOf`; mirrors claims-fact.ts.
  const value = record.value
    .replace(/\s*\*\(as of \d{4}-\d{2}-\d{2}\)\*/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return { key: record.key, value, asOf };
}

// ----- Config resolution (degrade-not-crash) ---------------------------------

function horizonFromConfig(config?: ExtensionConfig): number {
  const raw = config?.["stale_claims_horizon_days"];
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    return DEFAULT_STALE_HORIZON_DAYS;
  }
  return raw;
}

// ----- Processor -------------------------------------------------------------

type StaleClaimRow = {
  readonly path: string;
  readonly key: string;
  readonly value: string;
  readonly asOf: string;
  readonly daysStale: number;
};

const staleClaims = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const projection = ctx.projection;
    if (projection === undefined) {
      // The runtime that invokes view-phase processors MUST wire a projection
      // query view; an undefined slot here is a wiring defect. Fail loudly
      // rather than silently reporting "no claims are stale".
      throw new Error(
        "dome.claims.stale-claims: ctx.projection is undefined — the runtime must wire a ProjectionQueryView for view-phase processors",
      );
    }

    const horizonDays = horizonFromConfig(ctx.extensionConfig);
    const nowMs = ctx.now().getTime();

    const claimFacts = projection.facts({ predicate: CLAIM_PREDICATE });
    const stale: StaleClaimRow[] = [];
    const sourceRefs: ViewEffect["scope"][number][] = [];

    for (const fact of claimFacts) {
      const claim = parseClaimFact(fact);
      if (claim === null || claim.asOf === null) continue; // no date → no staleness

      const asOfMs = Date.parse(claim.asOf);
      if (Number.isNaN(asOfMs)) continue; // unparseable date → skip defensively

      // Date.parse of a bare `YYYY-MM-DD` is UTC midnight, so the staleness
      // boundary is anchored at UTC midnight; sub-day skew is immaterial at this
      // horizon (days).
      const daysStale = Math.floor((nowMs - asOfMs) / MS_PER_DAY);
      if (daysStale <= horizonDays) continue;

      // The claim's subject is the page that asserts it.
      const path = fact.subject.kind === "page" ? fact.subject.path : null;
      if (path === null) continue;

      stale.push({
        path,
        key: claim.key,
        value: claim.value,
        asOf: claim.asOf,
        daysStale,
      });
      for (const ref of fact.sourceRefs) sourceRefs.push(ref);
    }

    // Most-stale-first; ties broken by path then key for a stable order.
    stale.sort((a, b) => {
      if (b.daysStale !== a.daysStale) return b.daysStale - a.daysStale;
      if (a.path !== b.path) return a.path < b.path ? -1 : 1;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });

    const payload = {
      schema: VIEW_SCHEMA,
      asOfCommit: ctx.snapshot.commit,
      horizonDays,
      staleClaims: stale,
    };

    // Scope is built from each stale fact's own `sourceRefs` (preserving the
    // claim's line range + `^c` anchor), so the view consumer can navigate to
    // each stale claim — NOT synthesized at line 1 like orphan-pages, since here
    // we have a precise per-claim anchor to cite. When nothing is stale the
    // scope is empty:
    // ViewEffect.scope carries no min-length constraint (unlike FactEffect's
    // evidence requirement) and an empty view summarizes zero pages — there is
    // genuinely nothing to anchor to, and fabricating a vault-root SourceRef
    // would be a false citation.

    const effect: ViewEffect = viewEffect({
      name: VIEW_NAME,
      content: {
        kind: "structured",
        data: payload,
        schema: VIEW_SCHEMA,
      },
      scope: sourceRefs,
    });

    return [effect];
  },
});

export default staleClaims;
