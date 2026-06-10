// Proposal: the only thing that mutates trusted state. Every write — human,
// agent, garden processor, scheduled job — becomes a Proposal that the engine
// routes through the adoption loop. The Proposal abstraction is the seam that
// makes local-eventual and hosted-protected mode the same loop with different
// cursors.
//
// **Internal type.** Per docs/v1.md §13.2, the canonical client-to-engine
// write path is git: clients commit markdown to a branch and the engine's
// watcher daemon (Phase 11b, `dome serve`) sees the new commit and constructs
// a Proposal from the working-tree drift between `refs/heads/<branch>` and
// `refs/dome/adopted/<branch>`. There is no public submit-style API; the
// Proposal type is consumed by engine-internal modules (adopt, vault-runtime,
// daemon) and is not re-exported from `src/index.ts` as a write-side entry.
//
// See docs/wiki/specs/proposals.md for the normative contract (the Proposal
// type, the two internal source variants, construction by the daemon, the
// lifecycle, and the structural fences it underwrites —
// PROPOSALS_ARE_THE_ONLY_WRITE_PATH and ENGINE_IS_THE_ONLY_APPLIER).
//
// Pure types + Zod schemas + the daemon's manual-construction helper + id
// generator; no fs/git/sqlite, node:crypto only for randomBytes in
// makeProposalId.
//
// House-style notes (matches src/core/source-ref.ts and src/core/effect.ts):
//   - `type X = { ... }` aliases (not `interface`), every field `readonly`.
//   - Optional fields use `field?: T` (not `T | undefined`) for
//     `exactOptionalPropertyTypes` cleanliness.
//   - Zod object schemas use `.strict()` (unknown keys are validation
//     errors — Proposal shapes are closed).
//   - Schemas are not annotated as `z.ZodType<T>`: zod's `.optional()`
//     emits `T | undefined`, which collides with
//     `exactOptionalPropertyTypes`. Downstream code should type from the
//     Proposal/ProposalSource/etc. types, not `z.infer<...>`.

import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { CommitOid } from "./source-ref";
import {
  DiagnosticEffectSchema,
  type DiagnosticEffect,
} from "./effect";

// ----- ProposalSource -------------------------------------------------------

/**
 * The discriminated origin of a Proposal. Both variants are internal to the
 * engine; the daemon is the only thing that constructs Proposals in v1.0.
 *
 *   - `manual`  — daemon-derived from working-tree drift between
 *                 `refs/heads/<branch>` and `refs/dome/adopted/<branch>`.
 *                 The watcher (Phase 11b) sees a new commit on the branch
 *                 and synthesizes a Proposal with this source.
 *   - `garden`  — a garden-phase processor emitted a `PatchEffect`. The
 *                 engine applies the patch to a fresh internal branch and
 *                 constructs a new Proposal with this source, then routes
 *                 it through the same adoption loop (per
 *                 [[wiki/specs/proposals]] §"Garden-emitted Proposals").
 *
 * The engine reads `source.kind` as input to capability enforcement — the
 * broker may grant different effect powers to `manual` vs `garden`
 * Proposals per the vault's policy.
 */
export type ProposalSource =
  | { readonly kind: "manual"; readonly branch: string }
  | { readonly kind: "garden"; readonly processorId: string; readonly runId: string };

// ----- ProposalMetadata -----------------------------------------------------

/**
 * Optional source-specific context attached to a Proposal. `title` is the
 * originating commit subject for single-commit Proposals; `authoredAt` is
 * the ISO-8601 of the originating event (capture time, agent turn, etc.);
 * `reason` is an optional natural-language explanation.
 */
export type ProposalMetadata = {
  readonly title?: string;
  readonly authoredAt?: string;
  readonly reason?: string;
};

// ----- Proposal -------------------------------------------------------------

/**
 * A proposed commit range `base..head` for the engine to adopt. `id` is the
 * stable identifier across loop iterations and (in hosted mode) PR
 * force-pushes; `source` discriminates the origin for capability and
 * provenance routing.
 */
export type Proposal = {
  readonly id: string;
  readonly base: CommitOid;
  readonly head: CommitOid;
  readonly source: ProposalSource;
  readonly metadata?: ProposalMetadata;
};

// ----- ProposalState --------------------------------------------------------

/**
 * Lifecycle states a Proposal transitions through. The engine emits
 * `engine.proposal.<state>` events on every transition; the run ledger
 * records the full state history with timestamps. See
 * proposals.md §"Lifecycle states".
 */
export type ProposalState =
  | "constructed"
  | "enqueued"
  | "adopting"
  | "adopted"
  | "blocked"
  | "failed";

// ----- AdoptionResult -------------------------------------------------------

/**
 * The return shape of the engine's `adopt()` call. `adopted` is `true` only
 * when the adopted ref advanced; on `blocked`/`failed`, `adoptedRef` holds
 * the previous (unchanged) adopted commit. `closureCommitOid` is `null`
 * when the loop reached a fixed point without engine writes (no closure
 * commit was created). `diagnostics` carries the surfaced findings (always
 * present on `blocked`; possibly present otherwise).
 */
export type AdoptionResult = {
  readonly proposalId: string;
  readonly adopted: boolean;
  readonly adoptedRef: CommitOid;
  readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
  readonly closureCommitOid: CommitOid | null;
  readonly iterations: number;
};

// ----- Zod schemas ----------------------------------------------------------
// Boundary validation only. `.strict()` rejects unknown keys — Proposal
// shapes are closed.
//
// Not annotated as `z.ZodType<T>` because zod's `.optional()` emits
// `key?: T | undefined`, which collides with exactOptionalPropertyTypes.

export const ProposalSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("manual"),
      branch: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("garden"),
      processorId: z.string().min(1),
      runId: z.string().min(1),
    })
    .strict(),
]);

export const ProposalMetadataSchema = z
  .object({
    title: z.string().min(1).optional(),
    authoredAt: z.string().datetime({ offset: true }).optional(),
    reason: z.string().min(1).optional(),
  })
  .strict();

export const ProposalSchema = z
  .object({
    id: z.string().min(1),
    base: z.string().min(1), // CommitOid; loose v1 check (40-char hex enforced upstream)
    head: z.string().min(1),
    source: ProposalSourceSchema,
    metadata: ProposalMetadataSchema.optional(),
  })
  .strict();

export const ProposalStateSchema = z.enum([
  "constructed",
  "enqueued",
  "adopting",
  "adopted",
  "blocked",
  "failed",
]);

export const AdoptionResultSchema = z
  .object({
    proposalId: z.string().min(1),
    adopted: z.boolean(),
    adoptedRef: z.string().min(1),
    diagnostics: z.array(DiagnosticEffectSchema),
    closureCommitOid: z.string().min(1).nullable(),
    iterations: z.number().int().nonnegative(),
  })
  .strict();

// ----- Id generator ---------------------------------------------------------

/**
 * Generate a local-eventual Proposal id of the form
 * `prop_<unix-ms>_<6-char-rand>` per proposals.md §"Local-eventual mode".
 * The random suffix is 3 bytes of `crypto.randomBytes` hex-encoded — 6
 * hex characters of entropy is sufficient for collision-resistance at a
 * single-user single-machine submission rate. Hosted mode uses the PR
 * number instead and does not call this function.
 *
 * Internal to the engine — the daemon (Phase 11b) calls this when it
 * synthesizes a Proposal from working-tree drift.
 */
export function makeProposalId(): string {
  const ts = Date.now();
  const rand = randomBytes(3).toString("hex");
  return `prop_${ts}_${rand}`;
}

// ----- makeManualProposal ---------------------------------------------------
//
// The daemon's manual-construction helper. Used by the Phase 11b watcher
// to synthesize a Proposal when it sees drift between `refs/heads/<branch>`
// and `refs/dome/adopted/<branch>`. `id` defaults to a fresh
// `makeProposalId()` call; callers (tests, the daemon) may supply an
// explicit id for stable assertions.
//
// Optional `metadata` is only assigned when defined, so the returned
// object is `exactOptionalPropertyTypes`-clean (no `metadata: undefined`
// key). `Object.freeze` chosen over `as const` so misbehaving callers fail
// loudly at runtime rather than silently corrupting facts.

/**
 * Build a `Proposal` with `source.kind: "manual"`. Internal helper — the
 * daemon (Phase 11b) calls this to wrap working-tree drift into a Proposal
 * the adoption loop can consume.
 */
export function makeManualProposal(opts: {
  readonly id?: string;
  readonly base: CommitOid;
  readonly head: CommitOid;
  readonly branch: string;
  readonly metadata?: ProposalMetadata;
}): Proposal {
  const source: ProposalSource = Object.freeze({
    kind: "manual" as const,
    branch: opts.branch,
  });
  const built: { -readonly [K in keyof Proposal]: Proposal[K] } = {
    id: opts.id ?? makeProposalId(),
    base: opts.base,
    head: opts.head,
    source,
  };
  if (opts.metadata !== undefined) built.metadata = opts.metadata;
  return Object.freeze(built);
}

// ----- makeGardenProposal ---------------------------------------------------
//
// The garden orchestrator's sub-Proposal constructor. When a garden-phase
// processor emits a PatchEffect, the orchestrator builds a Proposal with
// `source.kind: "garden"` carrying the originating processor + run id; the
// engine routes it through `adopt()` recursively (Phase 4a' — see
// [[cohesive/brainstorms/2026-05-27-v1-engine-completion]]).
//
// The `runId` here is the garden-phase processor's RunRecord id — the
// audit trail joins the parent (garden) and child (sub-Proposal) work
// through this id. The `Dome-Source` trailer on the sub-Proposal's
// closure commit (if any) will name the garden processor as the
// originator.

/**
 * Build a `Proposal` with `source.kind: "garden"`. Internal helper — the
 * garden orchestrator at `src/engine/garden/garden.ts` calls this to wrap a
 * garden-emitted PatchEffect into a sub-Proposal the adoption loop can
 * consume.
 */
export function makeGardenProposal(opts: {
  readonly id?: string;
  readonly base: CommitOid;
  readonly head: CommitOid;
  readonly processorId: string;
  readonly runId: string;
  readonly metadata?: ProposalMetadata;
}): Proposal {
  const source: ProposalSource = Object.freeze({
    kind: "garden" as const,
    processorId: opts.processorId,
    runId: opts.runId,
  });
  const built: { -readonly [K in keyof Proposal]: Proposal[K] } = {
    id: opts.id ?? makeProposalId(),
    base: opts.base,
    head: opts.head,
    source,
  };
  if (opts.metadata !== undefined) built.metadata = opts.metadata;
  return Object.freeze(built);
}

// ----- ProposalMetadata constructor helper ----------------------------------

/**
 * Build a frozen ProposalMetadata from a typed input. Mirrors the
 * `sourceRef` helper in source-ref.ts: no validation (the type system
 * already enforces the shape at the call site), and optional fields are
 * only assigned when defined so the result is
 * `exactOptionalPropertyTypes`-clean.
 */
export function proposalMetadata(input: ProposalMetadata): ProposalMetadata {
  const m: { -readonly [K in keyof ProposalMetadata]: ProposalMetadata[K] } = {};
  if (input.title !== undefined) m.title = input.title;
  if (input.authoredAt !== undefined) m.authoredAt = input.authoredAt;
  if (input.reason !== undefined) m.reason = input.reason;
  return Object.freeze(m);
}
