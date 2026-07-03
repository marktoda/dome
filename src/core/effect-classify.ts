// src/core/effect-classify.ts
//
// The canonical Effect classifier. Effect-kind semantics live here once, behind
// a small interface, instead of being re-derived by hand at each call site.
//
// `EFFECT_KIND_FACTS` is the single source of truth: one row per Effect kind.
// Because it is `satisfies Record<Effect["kind"], …>`, adding a new kind to the
// Effect union fails to compile until its row is added here — so "does this new
// effect feed projections?" becomes a build-time decision, not a silent
// omission in some downstream `||` chain.

import type { Effect } from "./effect";

type EffectKind = Effect["kind"];

interface EffectKindFacts {
  /**
   * True when the effect is replayed into a projection sink during projection
   * rebuild (facts, search documents, diagnostics, questions). Must stay in
   * step with the projection-sink cases of the engine's effect router.
   */
  readonly feedsProjection: boolean;
}

const EFFECT_KIND_FACTS = {
  patch: { feedsProjection: false },
  diagnostic: { feedsProjection: true },
  fact: { feedsProjection: true },
  "search-document": { feedsProjection: true },
  question: { feedsProjection: true },
  external: { feedsProjection: false },
  "outbox-recovery": { feedsProjection: false },
  "quarantine-recovery": { feedsProjection: false },
  "run-recovery": { feedsProjection: false },
  view: { feedsProjection: false },
} satisfies Record<EffectKind, EffectKindFacts>;

/**
 * Extract the effects of a single kind from a heterogeneous list, narrowing the
 * element type so kind-specific fields are reachable without a hand-written
 * type guard.
 */
export function effectsOfKind<K extends EffectKind>(
  effects: readonly Effect[],
  kind: K,
): Extract<Effect, { kind: K }>[] {
  return effects.filter(
    (effect): effect is Extract<Effect, { kind: K }> => effect.kind === kind,
  );
}

/**
 * True when the effect is replayed into a projection sink during projection
 * rebuild. Replaces ad-hoc `kind === "diagnostic" || kind === "fact" || …`
 * membership checks.
 */
export function isProjectionEffect(effect: Effect): boolean {
  return EFFECT_KIND_FACTS[effect.kind].feedsProjection;
}
