// extensions/id-helpers: tiny pure helpers for working with bundle / processor ids.
//
// Lives here (under `src/extensions/`) rather than under `src/core/` or
// per-call-site because:
//   - The convention these helpers encode (processor ids are dotted names
//     whose first two segments name the bundle) is an *extension-substrate*
//     concept, not a core-engine one. Co-locating with `loader.ts` +
//     `manifest-schema.ts` keeps the bundle-id discipline in one place.
//   - Multiple call sites (`src/engine/compiler-host.ts`'s `realApplyPatch`
//     closure, `src/engine/garden.ts`'s spawn loop) need the same derivation;
//     before this helper existed they each carried a copy, and a convention
//     change (e.g., 3-segment bundle ids) would require updating both. This
//     module is the single source of truth.
//
// House-style notes:
//   - Pure value module: zero state, zero I/O, zero side effects.
//   - Functions accept a string id and return a derived value; no validation
//     beyond what's needed for the derivation to make sense.

/**
 * Derive the originating bundle id from a fully-qualified processor id.
 *
 * Convention (per [[wiki/specs/processors]] §"Registration"): processor ids
 * are dotted names whose first two segments name the bundle. For example:
 *
 *   - `dome.markdown.validate-wikilinks` → bundle `dome.markdown`
 *   - `dome.intake.extract-capture`      → bundle `dome.intake`
 *   - `community.heavy-linter.scan`      → bundle `community.heavy-linter`
 *
 * For less-canonical ids (single segment, or fewer than two segments
 * total), return the input unchanged. Callers that care about the
 * distinction can check `processorId === deriveExtensionId(processorId)`
 * but most just want the prefix.
 *
 * Used by the engine when stamping the `Dome-Extension` trailer on
 * engine-produced commits (per [[wiki/invariants/ENGINE_COMMITS_CARRY_DOME_TRAILERS]])
 * and by the garden orchestrator when constructing the run-context for
 * sub-Proposal patches.
 */
export function deriveExtensionId(processorId: string): string {
  const segments = processorId.split(".");
  if (segments.length === 0) return processorId;
  if (segments.length === 1) return processorId;
  return `${segments[0]}.${segments[1]}`;
}
