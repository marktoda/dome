// test.garden-patch-emitter.emit-on-seed — harness fixture-bundle processor.
//
// Garden-phase processor that emits a PatchEffect when `wiki/seed.md` is
// created. The emitted patch creates a NEW file `wiki/garden-emitted.md`;
// the engine routes this through the sub-Proposal spawn path
// (Phase 4a' in [[cohesive/brainstorms/2026-05-27-v1-engine-completion]]),
// constructs a `source: { kind: "garden", ... }` Proposal, and recursively
// adopts it.
//
// This bundle is **test-only** — it lives under
// `tests/harness/fixtures/bundles/` so it doesn't pollute the SDK's
// shipped bundle set (`assets/extensions/`). Scenarios that need to
// exercise the garden cascade install it via the harness's
// `{ id, root }` BundleSpec.
//
// Why this bundle exists: no shipped first-party bundle emits a
// garden-phase PatchEffect today (`dome.markdown` is adoption-only;
// `dome.lint` is view-only). Without this fixture, the cascade path
// added in Phase 4a' is not exercised by any scenario. The fixture lets
// the harness drive end-to-end assertions on:
//
//   - The Dome-Base / Dome-Source-Head trailers on engine commits
//     created inside the sub-Proposal's adoption (verifying the Phase
//     4a' follow-up sink-frame fix).
//   - The adopted_commit column on projection rows emitted during the
//     sub-Proposal's adoption + garden phases (same fix).
//   - The cascade-cap diagnostic when an emit-on-seed-style processor
//     recursively triggers itself.
//
// This file is loaded by the harness's symlink-based install path, so
// relative imports resolve against the SDK's real `src/` tree. The
// nesting depth (6 levels) is greater than shipped bundles (4 levels)
// because fixtures live deeper.

import {
  patchEffect,
  type Effect,
  type FileChangeInput,
} from "../../../../../../src/core/effect";
import {
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "../../../../../../src/core/processor";

// ----- Constants ------------------------------------------------------------

const SEED_PATH = "wiki/seed.md";
const EMITTED_PATH = "wiki/garden-emitted.md";
// The emitted body is intentionally structured to trigger two shipped
// adoption-phase processors when the sub-Proposal adopts:
//   - dome.markdown.normalize-frontmatter — frontmatter keys are
//     deliberately unsorted (`zeta` before `alpha`); the processor
//     emits a patch.auto reordering them. This patch goes through
//     compiler-host.ts's `realApplyPatch` sink, exercising the
//     sub-Proposal frame the Phase 4a' follow-up fixed (bug 1: the
//     resulting engine commit's `Dome-Base` / `Dome-Source-Head`
//     trailers must be scoped to the sub-Proposal, not the parent).
//   - dome.markdown.validate-wikilinks — the body references
//     `[[unresolvable-target]]`, an unresolved wikilink. The processor
//     emits a DiagnosticEffect. The diagnostic row's `adopted_commit`
//     column must be tagged with the sub-Proposal's head (bug 2: the
//     sinks captured the parent's drift.head before the follow-up).
const EMITTED_BODY =
  "---\n" +
  "zeta: last\n" +
  "alpha: first\n" +
  "---\n" +
  "\n" +
  "# Garden-emitted\n" +
  "\n" +
  "References [[unresolvable-target]].\n";

// Per Phase 12a, PatchEffect carries whole-content `FileChange` entries
// (write/delete with vault-relative path + content), not a unified-diff
// string. The engine's applier overlays each change onto the candidate
// tree without parsing diff text. See [[wiki/specs/effects]] §"PatchEffect"
// §"Why whole-content instead of a unified diff?" for the rationale.
const CREATE_CHANGE: FileChangeInput = {
  kind: "write",
  path: EMITTED_PATH,
  content: EMITTED_BODY,
};

// ----- Processor ------------------------------------------------------------

const processor: Processor = defineProcessor({
  id: "test.garden-patch-emitter.emit-on-seed",
  version: "0.1.0",
  phase: "garden",
  triggers: [
    { kind: "signal", name: "file.created", pathPattern: SEED_PATH },
  ],
  capabilities: [
    { kind: "read", paths: ["wiki/**"] },
    { kind: "patch.auto", paths: ["wiki/**"] },
  ],
  run: async (
    _ctx: ProcessorContext<unknown>,
  ): Promise<ReadonlyArray<Effect>> => {
    return [
      patchEffect({
        mode: "auto",
        changes: [CREATE_CHANGE],
        reason: `test fixture: create ${EMITTED_PATH} on seed`,
        sourceRefs: [],
      }),
    ];
  },
});

export default processor;
