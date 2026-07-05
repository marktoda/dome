// dome.claims.index — project claim lines into facts.
//
// Adoption-phase, deterministic, rebuildable: one `dome.claims.claim` fact
// per claim line, object = canonical JSON {key, value, asOf?}, sourceRef
// carrying the line range and (when stamped) the ^c-anchor as stableId.
// The fact value never includes the anchor — the anchor is identity, and it
// already rides the sourceRef; duplicating it into the value would make the
// first post-stamp adoption a spurious value change.
//
// Same-page key-collision diagnostic (folded in from the retired
// `dome.warden.integrity` deterministic pre-filter, which was dead code —
// it read `ctx.projection?.facts` in garden phase, always undefined). Here it
// is free: the index already parses every claim line, so a normalized key
// asserted with two or more DISTINCT values on ONE page is a mechanical
// contradiction surfaced as a `warning` DiagnosticEffect — no projection read,
// no model. Self-clears via `resolveStaleDiagnostics` when the page is
// reconciled to a single value.

import {
  diagnosticEffect,
  factEffect,
  type Effect,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";

import { claimsFromMarkdown, normalizeClaimKey } from "./claims-shared";
import { CLAIM_PREDICATE, claimFactValue } from "./claim-fact";

const KEY_COLLISION_CODE = "dome.claims.key-collision";

const claimIndex = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const effects: Effect[] = [];
    for (const path of ctx.changedPaths.filter((p) => p.endsWith(".md"))) {
      const content = await ctx.snapshot.readFile(path);
      if (content === null) continue;
      // Per-page collision tracking: normalized key → the first value seen and
      // its line; a later DISTINCT value under the same key is a collision.
      const firstByKey = new Map<string, { value: string; line: number }>();
      const flagged = new Set<string>();
      for (const claim of claimsFromMarkdown(content)) {
        const range = { startLine: claim.line, endLine: claim.line };
        const ref =
          claim.anchor !== null
            ? ctx.sourceRef(path, range, claim.anchor)
            : ctx.sourceRef(path, range);
        effects.push(
          factEffect({
            subject: { kind: "page", path },
            predicate: CLAIM_PREDICATE,
            object: { kind: "string", value: claimFactValue(claim) },
            assertion: "extracted",
            sourceRefs: [ref],
          }),
        );

        const keyNorm = normalizeClaimKey(claim.key);
        const prior = firstByKey.get(keyNorm);
        if (prior === undefined) {
          firstByKey.set(keyNorm, { value: claim.value, line: claim.line });
        } else if (prior.value !== claim.value && !flagged.has(keyNorm)) {
          flagged.add(keyNorm);
          effects.push(
            diagnosticEffect({
              severity: "warning",
              code: KEY_COLLISION_CODE,
              message:
                `Claim collision in ${path}: the key "${claim.key}" is asserted ` +
                `with conflicting values on the same page ` +
                `("${prior.value}" vs "${claim.value}"). Reconcile to a single ` +
                `current value (supersede or remove the stale assertion).`,
              // Per-key stableId so two colliding keys on one page get distinct
              // subject hashes and both survive the projection's INSERT OR
              // IGNORE dedup; anchored at the conflicting line.
              sourceRefs: [
                ctx.sourceRef(
                  path,
                  { startLine: claim.line, endLine: claim.line },
                  `key-collision:${keyNorm}`,
                ),
              ],
            }),
          );
        }
      }
    }
    return Object.freeze(effects);
  },
});

export default claimIndex;
