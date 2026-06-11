// dome.markdown.page-status — deterministic adoption-phase status-fact
// emitter for the supersession convention (memory-quality M2).
//
// Reads each changed managed wiki page's frontmatter and emits:
//   - `dome.page.status`        — the `status:` value, when present;
//   - `dome.page.superseded_by` — the forward wikilink target (recorded
//     as written, [[..]] stripped), when present;
//   - `dome.page.description`   — the trimmed `description:` value, when
//     non-empty (the substrate the generated index projection reads).
//
// Per [[wiki/specs/page-schema]] §"Supersession (ADR pattern)", these facts
// are the deterministic substrate the dome.search composite ranker keys on
// for the superseded downrank. Rebuildable by construction: derived from
// adopted markdown only — same content → same facts (no clock, no LLM,
// no network), per [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]].
//
// Home bundle: dome.markdown, not dome.graph — dome.markdown owns
// frontmatter semantics (page-schema.md: "Validation lives in one
// processor"), and the predicate namespace is `dome.page.*` (page
// lifecycle, not graph structure), declared via this processor's own
// `graph.write` capability. The namespace check below is defense-in-depth,
// mirroring dome.graph.links: the broker enforces predicate-prefix matching
// per [[wiki/specs/capabilities]] §"graph.write", and a drifted PREDICATE
// fails loudly at the source instead of being silently rejected.
//
// Per [[wiki/matrices/processor-phase-x-trigger]], adoption-phase
// processors may subscribe to `signal` triggers; we subscribe to
// `document.changed`, `file.created`, and `file.deleted`. Deleted paths
// emit no facts; the projection sink clears this processor's page facts
// for every inspected changed path before inserting the run's new facts.
//
// This file lives under `assets/` which is excluded from the root
// `tsconfig.json`. Imports use relative paths into `src/`, resolved at
// runtime by Bun's dynamic-import loader.

import {
  factEffect,
  type Effect,
  type FactEffect,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";
import { frontmatterLintModeForPath } from "./path-policy";
import { readPageStatus } from "./supersession-shared";

const STATUS_PREDICATE = "dome.page.status";
const SUPERSEDED_BY_PREDICATE = "dome.page.superseded_by";
const DESCRIPTION_PREDICATE = "dome.page.description";

// Defense-in-depth: the namespace prefix the runtime check verifies. If a
// future refactor moves a predicate outside the declared `dome.page.*`
// namespace, the check at the start of `run` fails the processor's contract
// loudly rather than relying on the broker to reject the writes.
const REQUIRED_NAMESPACE_PREFIX = "dome.page.";

const pageStatus = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    for (const predicate of [
      STATUS_PREDICATE,
      SUPERSEDED_BY_PREDICATE,
      DESCRIPTION_PREDICATE,
    ]) {
      if (!predicate.startsWith(REQUIRED_NAMESPACE_PREFIX)) {
        throw new Error(
          `dome.markdown.page-status: predicate '${predicate}' does not start with the declared namespace prefix '${REQUIRED_NAMESPACE_PREFIX}'`,
        );
      }
    }

    const facts: FactEffect[] = [];

    // Status facts are a managed-wiki-page concern; user-owned/ephemeral
    // roots keep their frontmatter unindexed (same scope as the
    // frontmatter "required" lint mode).
    const changedManaged = ctx.changedPaths.filter(
      (path) => frontmatterLintModeForPath(path) === "required",
    );

    for (const path of changedManaged) {
      const content = await ctx.snapshot.readFile(path);
      // `null` means the path was deleted in this candidate; the engine's
      // fact-resolution hook clears old page facts for inspected paths.
      if (content === null) continue;

      const info = readPageStatus(content);
      if (info.status !== null) {
        facts.push(
          factEffect({
            subject: { kind: "page", path },
            predicate: STATUS_PREDICATE,
            object: { kind: "string", value: info.status },
            assertion: "extracted",
            sourceRefs: [
              ctx.sourceRef(path, {
                startLine: info.statusLine,
                endLine: info.statusLine,
              }),
            ],
          }),
        );
      }
      if (info.supersededBy !== null) {
        facts.push(
          factEffect({
            subject: { kind: "page", path },
            predicate: SUPERSEDED_BY_PREDICATE,
            object: { kind: "string", value: info.supersededBy },
            assertion: "extracted",
            sourceRefs: [
              ctx.sourceRef(path, {
                startLine: info.supersededByLine,
                endLine: info.supersededByLine,
              }),
            ],
          }),
        );
      }
      if (info.description !== null) {
        facts.push(
          factEffect({
            subject: { kind: "page", path },
            predicate: DESCRIPTION_PREDICATE,
            object: { kind: "string", value: info.description },
            assertion: "extracted",
            sourceRefs: [
              ctx.sourceRef(path, {
                startLine: info.descriptionLine,
                endLine: info.descriptionLine,
              }),
            ],
          }),
        );
      }
    }

    return facts;
  },
});

export default pageStatus;
