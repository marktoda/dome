// Proposal: the only thing that mutates trusted state. Every write — human,
// agent, garden processor, scheduled job — becomes a Proposal that the engine
// routes through the adoption loop. The Proposal abstraction is the seam that
// makes local-eventual and hosted-protected mode the same loop with different
// cursors.
//
// See docs/wiki/specs/proposals.md for the normative contract (the Proposal
// type, source variants, construction paths, submission API, lifecycle, and
// the structural fences it underwrites — PROPOSALS_ARE_THE_ONLY_WRITE_PATH
// and ENGINE_IS_THE_ONLY_APPLIER).
//
// Pure types + Zod schemas + per-source helpers + id generator; no fs/git/sqlite, node:crypto only for randomBytes in makeProposalId.
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
  type UnifiedDiff,
} from "./effect";

// ----- ProposalSource -------------------------------------------------------

/**
 * The discriminated origin of a Proposal. The engine uses `kind` as input to
 * capability enforcement — the broker may grant different effect powers to
 * `client` vs `garden` vs `manual` Proposals per the vault's policy.
 *
 *   - `client`  — mobile, desktop, voice, native shell.
 *   - `agent`   — claude-code, cursor, future agent harnesses.
 *   - `garden`  — a garden-phase processor emitted a PatchEffect.
 *   - `manual`  — user pushed a branch directly.
 *   - `import`  — bulk import / migration tool.
 */
export type ClientSource = { readonly kind: "client"; readonly clientId: string };
export type AgentSource = { readonly kind: "agent"; readonly harness: string; readonly sessionId?: string };
export type GardenSource = { readonly kind: "garden"; readonly processorId: string; readonly runId: string };
export type ManualSource = { readonly kind: "manual"; readonly branch: string };
export type ImportSource = { readonly kind: "import"; readonly importerId: string };

export type ProposalSource =
  | ClientSource
  | AgentSource
  | GardenSource
  | ManualSource
  | ImportSource;

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
 * The return shape of `submitProposal`. `adopted` is `true` only when the
 * adopted ref advanced; on `blocked`/`failed`, `adoptedRef` holds the
 * previous (unchanged) adopted commit. `closureCommitOid` is `null` when
 * the loop reached a fixed point without engine writes (no closure commit
 * was created). `diagnostics` carries the surfaced findings (always
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

// ----- SubmitInput ----------------------------------------------------------

/**
 * The input shape for `submitProposal`. Every field is optional: `head`
 * defaults to current HEAD; `source` defaults to the inferred kind per
 * proposals.md §"Local-eventual mode"; `patch`, when supplied, drives
 * construction of the Proposal from a patch rather than from HEAD;
 * `metadata` is forwarded onto the Proposal.
 */
export type SubmitInput = {
  readonly head?: CommitOid;
  readonly patch?: UnifiedDiff;
  readonly source?: ProposalSource;
  readonly metadata?: ProposalMetadata;
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
      kind: z.literal("client"),
      clientId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("agent"),
      harness: z.string().min(1),
      sessionId: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("garden"),
      processorId: z.string().min(1),
      runId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("manual"),
      branch: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("import"),
      importerId: z.string().min(1),
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

export const SubmitInputSchema = z
  .object({
    head: z.string().min(1).optional(),
    patch: z.string().optional(),
    source: ProposalSourceSchema.optional(),
    metadata: ProposalMetadataSchema.optional(),
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
 */
export function makeProposalId(): string {
  const ts = Date.now();
  const rand = randomBytes(3).toString("hex");
  return `prop_${ts}_${rand}`;
}

// ----- Constructor helpers --------------------------------------------------
// One per source kind: takes the source-discriminated input shape, builds
// the `source` discriminator inline, and delegates to `buildProposal` for
// the shared shell work. Following the source-ref.ts and effect.ts pattern —
// no validation here; the type system enforces the shape at the call site,
// and Zod is for untrusted boundaries.
//
// Optional `metadata` is only assigned when defined, so the returned
// object is `exactOptionalPropertyTypes`-clean (no `metadata: undefined`
// keys).
//
// Object.freeze chosen over `as const` so misbehaving processors fail loudly
// at runtime rather than silently corrupting facts.

function buildProposal(
  input: {
    readonly id: string;
    readonly base: CommitOid;
    readonly head: CommitOid;
    readonly metadata?: ProposalMetadata;
  },
  source: ProposalSource,
): Proposal {
  const built: { -readonly [K in keyof Proposal]: Proposal[K] } = {
    id: input.id,
    base: input.base,
    head: input.head,
    source: Object.freeze(source),
  };
  if (input.metadata !== undefined) built.metadata = input.metadata;
  return Object.freeze(built);
}

export function clientProposal(input: {
  readonly id: string;
  readonly base: CommitOid;
  readonly head: CommitOid;
  readonly clientId: string;
  readonly metadata?: ProposalMetadata;
}): Proposal {
  return buildProposal(input, { kind: "client", clientId: input.clientId });
}

export function agentProposal(input: {
  readonly id: string;
  readonly base: CommitOid;
  readonly head: CommitOid;
  readonly harness: string;
  readonly sessionId?: string;
  readonly metadata?: ProposalMetadata;
}): Proposal {
  const source: AgentSource =
    input.sessionId !== undefined
      ? { kind: "agent", harness: input.harness, sessionId: input.sessionId }
      : { kind: "agent", harness: input.harness };
  return buildProposal(input, source);
}

export function gardenProposal(input: {
  readonly id: string;
  readonly base: CommitOid;
  readonly head: CommitOid;
  readonly processorId: string;
  readonly runId: string;
  readonly metadata?: ProposalMetadata;
}): Proposal {
  return buildProposal(input, {
    kind: "garden",
    processorId: input.processorId,
    runId: input.runId,
  });
}

export function manualProposal(input: {
  readonly id: string;
  readonly base: CommitOid;
  readonly head: CommitOid;
  readonly branch: string;
  readonly metadata?: ProposalMetadata;
}): Proposal {
  return buildProposal(input, { kind: "manual", branch: input.branch });
}

export function importProposal(input: {
  readonly id: string;
  readonly base: CommitOid;
  readonly head: CommitOid;
  readonly importerId: string;
  readonly metadata?: ProposalMetadata;
}): Proposal {
  return buildProposal(input, { kind: "import", importerId: input.importerId });
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
