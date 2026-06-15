// dome.warden.integrity — a knowledge-integrity warden.
//
// A warden is a processor, not a new primitive: a garden-phase `kind: llm`
// processor granted `model.invoke` + `question.ask` + `read`, and deliberately
// NOT `patch.auto` over knowledge and NOT `graph.write`. The hard rule wardens
// obey: they emit QuestionEffect only — never FactEffect, never a knowledge
// PatchEffect.
//
// Why: `src/engine/host/projection-rebuild.ts` REBUILD_SAFE_GARDEN_CAPABILITIES is
// {read, graph.write, search.write, question.ask}. A garden processor holding
// `model.invoke` is NOT re-run on rebuild, so any FactEffect it emitted would
// vanish on `dome rebuild`. The durable artifact is the human/agent
// *resolution* (answers.db, rehydrated on rebuild), not the model's inference.
// So: model judgment → transient QuestionEffect; resolution → durable via the
// answer-handler (`integrity-answer.ts`).
//
// For each changed wiki markdown page the warden asks the model to judge
// whether any claim is (a) a completed/historical event framed as ongoing,
// (b) internally / cross-page contradictory, (c) self-corroborating (its only
// support cites this vault), or (d) agent-inference dressed as sourced fact.
// Each non-trivial finding becomes a QuestionEffect whose idempotencyKey is
// keyed on the page content hash, so a flag re-raises only when the page
// content changes and settles by content-hash.
//
// Precision (the claims consumer + the gate):
//   - The warden reads `dome.claims.claim` facts via `ctx.projection` (garden
//     processors get the same scoped read-only projection view as view-phase
//     processors — see ProcessorContext.projection; e.g. dome.agent.brief
//     reads the open-question batch the same way). This gives the
//     claims.index facts their intended consumer.
//   - DETERMINISTIC PRE-FILTER: before trusting the model, the warden finds
//     claim lines that mechanically disagree — same normalized claim key,
//     different value, on the same page — and surfaces each collision as a
//     high-risk contradiction QuestionEffect directly (no model needed to
//     re-derive it from prose). Cross-page contradiction stays the model's
//     job; same-page key collision is the honest deterministic subset.
//   - CONFIDENCE FLOOR: model findings below
//     `extensions.dome.warden.config.question_confidence_floor` (conservative
//     default) do not become questions.
//   - NOISY-CLASS SUPPRESSION: the self-corroborating / inference-as-fact
//     classes fire on legitimate synthesized prose, so they are suppressed
//     unless a mechanical collision on the same page backs them.
// The warden stays questions-only / no-graph-write / rebuild-safe: it never
// emits a FactEffect — the collision pre-filter reads facts but emits only
// QuestionEffects (and the model-config DiagnosticEffects).

import matter from "gray-matter";
import { z } from "zod";

import { CLAIM_PREDICATE } from "../../dome.claims/processors/claim-fact";
import { normalizeClaimKey } from "../../dome.claims/processors/claims-shared";
import {
  diagnosticEffect,
  questionEffect,
  type Effect,
  type FactEffect,
  type QuestionAutomationPolicy,
  type QuestionRisk,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";
import { shortHash } from "../../../../src/core/short-hash";

const MODEL_SCHEMA = "dome.warden.integrity/v1";

// Conservative default: medium-confidence model judgment is not enough to
// interrupt the owner. A vault that wants the warden chattier lowers this.
const DEFAULT_CONFIDENCE_FLOOR = 0.6;

// The noisy finding classes — pervasive on synthesized prose. Suppressed
// unless a mechanical claim collision on the same page backs them.
const NOISY_FINDING_KINDS: ReadonlySet<Finding["kind"]> = new Set([
  "self-corroborating",
  "inference-as-fact",
]);

const FINDING_KINDS = [
  "historical-as-ongoing",
  "contradiction",
  "self-corroborating",
  "inference-as-fact",
] as const;

type Finding = {
  readonly kind: (typeof FINDING_KINDS)[number];
  readonly claim: string;
  readonly severity: QuestionRisk;
  readonly confidence: number;
  readonly recommendedAnswer: string;
};

const NonEmptyTrimmedString = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value.length > 0, "expected non-empty string");

const FindingSchema = z
  .object({
    kind: z.enum(FINDING_KINDS),
    claim: NonEmptyTrimmedString,
    severity: z.enum(["low", "medium", "high"]),
    confidence: z.number().min(0).max(1),
    recommendedAnswer: NonEmptyTrimmedString,
  })
  .strict();

const IntegrityResultSchema = z
  .object({
    findings: z.array(FindingSchema),
  })
  .strict();

type IntegrityResult = { readonly findings: ReadonlyArray<Finding> };

const integrity = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    // No model configured → no review. The warden triggers on every wiki page,
    // so it must degrade to a clean no-op (never a failed run) when there is no
    // usable model. Two cases: `model.invoke` ungranted → `ctx.modelInvoke` is
    // undefined; granted-but-no-provider → `ctx.modelInvoke` is defined but
    // *throws on call* (see model-invoke.ts). The early return handles the
    // first; the per-page try/catch handles the second (and any transient model
    // error) — review is best-effort and must not break the garden run.
    const modelInvoke = ctx.modelInvoke;
    if (modelInvoke === undefined) return [];

    const wikiPaths = ctx.changedPaths.filter(isWikiMarkdownPath).sort();
    const firstPath = wikiPaths[0];
    if (firstPath === undefined) return [];

    // Per-warden model routing (`extensions.dome.warden.config.model_override`):
    // the resolved model rides every structured() call via the provider-neutral
    // `model` field. Same degrade-not-crash idiom as the dome.agent config
    // reads — a malformed value falls back to the provider default with ONE
    // warning diagnostic per run, never a crashed review.
    const override = resolveModelOverride(ctx.extensionConfig);
    const floor = resolveConfidenceFloor(ctx.extensionConfig);

    // Deterministic claim-collision pre-filter, computed once from the claims
    // facts in the warden's scoped read view (garden projection access).
    const collisionsByPath = collisionKeysByPath(
      ctx.projection?.facts({ predicate: CLAIM_PREDICATE }) ?? [],
    );

    const effects: Effect[] = [];
    if (override.problem !== null) {
      effects.push(
        diagnosticEffect({
          severity: "warning",
          code: "dome.warden.model-config-invalid",
          message: override.problem,
          sourceRefs: [ctx.sourceRef(firstPath)],
        }),
      );
    }
    if (floor.problem !== null) {
      effects.push(
        diagnosticEffect({
          severity: "warning",
          code: "dome.warden.confidence-config-invalid",
          message: floor.problem,
          sourceRefs: [ctx.sourceRef(firstPath)],
        }),
      );
    }
    for (const path of wikiPaths) {
      const content = await ctx.snapshot.readFile(path);
      if (content === null) continue;

      const contentHash = shortHash(content, 12);
      const policy: QuestionAutomationPolicy = isPeopleContent(path, content)
        ? "owner-needed"
        : "agent-safe";
      const pageCollisions = collisionsByPath.get(path) ?? new Map();
      const ownerNeededMeta =
        policy === "owner-needed"
          ? {
              ownerNeededReason:
                "Page is people/management content; resolution may carry interpersonal nuance.",
            }
          : {};

      // 1) Deterministic collisions surface directly — the mechanical
      // contradiction is hard evidence, so it never depends on the model or
      // the confidence floor. idempotencyKey keys on the page content hash +
      // the normalized claim key, so it settles when the page is reconciled.
      for (const [keyNorm, collision] of pageCollisions) {
        effects.push(
          questionEffect({
            question: collisionQuestionText(path, collision),
            sourceRefs: [ctx.sourceRef(path)],
            idempotencyKey: `dome.warden.integrity:${path}:${contentHash}:claim-collision:${keyNorm}`,
            metadata: {
              risk: "high",
              confidence: 1,
              recommendedAnswer: collisionRecommendedAnswer(collision),
              automationPolicy: policy,
              ...ownerNeededMeta,
            },
          }),
        );
      }

      let result: IntegrityResult;
      try {
        result = await modelInvoke.structured({
          schemaName: MODEL_SCHEMA,
          prompt: promptForPage(path, content),
          parse: parseIntegrityResult,
          ...(override.model !== undefined ? { model: override.model } : {}),
        });
      } catch {
        // Model unavailable (no provider) or errored for this page — skip it.
        continue;
      }
      if (result.findings.length === 0) continue;

      const hasCollision = pageCollisions.size > 0;

      for (const finding of result.findings) {
        // Drop low-risk: pervasive in a synthesized vault, out-produces triage.
        if (finding.severity === "low") continue;
        // Confidence floor: below the (degrade-not-crash) config floor, the
        // model is not confident enough to interrupt the owner.
        if (finding.confidence < floor.value) continue;
        // Noisy-class suppression: self-corroboration / inference-as-fact fire
        // on legitimate prose, so they require a same-page mechanical collision
        // backing them before they earn a question.
        if (NOISY_FINDING_KINDS.has(finding.kind) && !hasCollision) continue;
        effects.push(
          questionEffect({
            question: questionTextFor(path, finding),
            sourceRefs: [ctx.sourceRef(path)],
            idempotencyKey: `dome.warden.integrity:${path}:${contentHash}:${finding.kind}`,
            metadata: {
              risk: finding.severity,
              confidence: finding.confidence,
              recommendedAnswer: finding.recommendedAnswer,
              automationPolicy: policy,
              ...ownerNeededMeta,
            },
          }),
        );
      }
    }
    return Object.freeze(effects);
  },
});

export default integrity;

type ModelOverrideResolution = {
  readonly model: string | undefined;
  readonly problem: string | null;
};

/**
 * Resolve `extensions.dome.warden.config.model_override` (a single model
 * string for the warden's structured calls). Unset → no model field (the
 * provider's default); malformed → default + a `problem` the run surfaces as
 * the `dome.warden.model-config-invalid` warning. Kept local to the bundle —
 * the dome.agent helper resolves a per-processor map, this is one string.
 */
function resolveModelOverride(
  config: Readonly<Record<string, unknown>> | undefined,
): ModelOverrideResolution {
  const raw = config?.model_override;
  if (raw === undefined) {
    return Object.freeze({ model: undefined, problem: null });
  }
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return Object.freeze({
      model: undefined,
      problem:
        "dome.warden config model_override must be a non-empty model " +
        "string; ignoring it (provider default model)",
    });
  }
  return Object.freeze({ model: raw.trim(), problem: null });
}

type ConfidenceFloorResolution = {
  readonly value: number;
  readonly problem: string | null;
};

/**
 * Resolve `extensions.dome.warden.config.question_confidence_floor` — the
 * minimum model confidence (a number in [0,1]) below which a finding does not
 * become a question. Unset → the conservative default; malformed (wrong type
 * or out of range) → default + a `problem` the run surfaces as the
 * `dome.warden.confidence-config-invalid` warning. Same degrade-not-crash
 * idiom as `model_override`.
 */
function resolveConfidenceFloor(
  config: Readonly<Record<string, unknown>> | undefined,
): ConfidenceFloorResolution {
  const raw = config?.question_confidence_floor;
  if (raw === undefined) {
    return Object.freeze({ value: DEFAULT_CONFIDENCE_FLOOR, problem: null });
  }
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 1) {
    return Object.freeze({
      value: DEFAULT_CONFIDENCE_FLOOR,
      problem:
        "dome.warden config question_confidence_floor must be a number in " +
        `[0, 1]; ignoring it (default ${DEFAULT_CONFIDENCE_FLOOR})`,
    });
  }
  return Object.freeze({ value: raw, problem: null });
}

// A same-key/different-value collision on one page: the normalized key plus the
// distinct values asserted under it (insertion order preserved for the prompt).
type Collision = {
  readonly key: string;
  readonly values: ReadonlyArray<string>;
};

const ClaimObjectSchema = z
  .object({ key: z.string(), value: z.string() })
  .passthrough();

/**
 * Deterministic same-page contradiction pre-filter. Groups `dome.claims.claim`
 * facts by (page, normalized key) and keeps only the keys whose page asserts
 * two or more DISTINCT values — a mechanical contradiction. Uses the claims
 * bundle's own `normalizeClaimKey` so grouping matches claim identity exactly.
 * Returns `Map<path, Map<normalizedKey, Collision>>`.
 */
function collisionKeysByPath(
  facts: ReadonlyArray<FactEffect>,
): ReadonlyMap<string, ReadonlyMap<string, Collision>> {
  // path → normKey → { rawKey, ordered distinct values }
  const byPath = new Map<string, Map<string, { key: string; values: string[] }>>();
  for (const fact of facts) {
    if (fact.predicate !== CLAIM_PREDICATE) continue;
    if (fact.subject.kind !== "page") continue;
    if (fact.object.kind !== "string") continue;
    const parsed = ClaimObjectSchema.safeParse(safeJson(fact.object.value));
    if (!parsed.success) continue;
    const { key, value } = parsed.data;
    const keyNorm = normalizeClaimKey(key);
    if (keyNorm.length === 0 || value.trim().length === 0) continue;
    const path = fact.subject.path;
    const pageMap = byPath.get(path) ?? new Map();
    const entry = pageMap.get(keyNorm) ?? { key, values: [] };
    if (!entry.values.includes(value)) entry.values.push(value);
    pageMap.set(keyNorm, entry);
    byPath.set(path, pageMap);
  }

  const result = new Map<string, Map<string, Collision>>();
  for (const [path, pageMap] of byPath) {
    const collisions = new Map<string, Collision>();
    for (const [keyNorm, entry] of pageMap) {
      if (entry.values.length < 2) continue;
      collisions.set(
        keyNorm,
        Object.freeze({ key: entry.key, values: Object.freeze([...entry.values]) }),
      );
    }
    if (collisions.size > 0) result.set(path, collisions);
  }
  return result;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function collisionQuestionText(path: string, collision: Collision): string {
  return (
    `Integrity flag in ${path}: a claim contradiction — the key ` +
    `"${collision.key}" is asserted with conflicting values ` +
    `${collision.values.map((v) => `"${v}"`).join(" vs ")}. ` +
    `Which value is correct, and should the others be removed or reframed?`
  );
}

function collisionRecommendedAnswer(collision: Collision): string {
  return (
    `Reconcile the "${collision.key}" claims to a single current value ` +
    `(supersede or remove the stale assertion).`
  );
}

function isWikiMarkdownPath(path: string): boolean {
  return /^wiki\/.+\.md$/i.test(path);
}

// People/management heuristic (kept deliberately simple + documented): the
// page lives under `wiki/entities/` OR its frontmatter `type:` is `entity` or
// `person`. Such content gets `owner-needed` so the owner — not an agent or
// model — resolves the flag.
function isPeopleContent(path: string, content: string): boolean {
  if (path.startsWith("wiki/entities/")) return true;
  try {
    const type = matter(content).data.type;
    return type === "entity" || type === "person";
  } catch {
    return false;
  }
}

const FINDING_LABEL: Record<Finding["kind"], string> = {
  "historical-as-ongoing":
    "a completed/historical event is framed as ongoing",
  contradiction: "an internal or cross-page contradiction",
  "self-corroborating":
    "a claim whose only support cites this vault (self-corroboration)",
  "inference-as-fact": "agent inference dressed as a sourced fact",
};

function questionTextFor(path: string, finding: Finding): string {
  return (
    `Integrity flag in ${path}: ${FINDING_LABEL[finding.kind]}. ` +
    `Claim: "${finding.claim}". ` +
    `How should this be resolved?`
  );
}

export function promptForPage(path: string, content: string): string {
  return [
    "You are a knowledge-integrity warden for a Dome vault. Judge the page",
    "below for integrity issues and return STRICT JSON only.",
    "Return an object: { findings: Finding[] } where each Finding is",
    "{ kind, claim, severity, confidence, recommendedAnswer }.",
    "kind ∈ {historical-as-ongoing, contradiction, self-corroborating, inference-as-fact}.",
    "  - historical-as-ongoing: a completed/historical event framed as ongoing.",
    "  - contradiction: a claim that contradicts itself or another page.",
    "  - self-corroborating: a claim whose only support cites this same vault.",
    "  - inference-as-fact: agent inference dressed up as a sourced fact.",
    "severity ∈ {low, medium, high}; confidence ∈ [0,1];",
    "recommendedAnswer: a concrete resolution the owner/agent could apply.",
    "Return { \"findings\": [] } when the page has no integrity issues.",
    "Flag only non-trivial issues — do not invent problems.",
    "",
    `Page path: ${path}`,
    "",
    content,
  ].join("\n");
}

function parseIntegrityResult(value: unknown): IntegrityResult {
  const parsed = IntegrityResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(parsed.error.message);
  }
  return Object.freeze({
    findings: Object.freeze(
      parsed.data.findings.map((f) =>
        Object.freeze({
          kind: f.kind,
          claim: f.claim,
          severity: f.severity,
          confidence: f.confidence,
          recommendedAnswer: f.recommendedAnswer,
        }),
      ),
    ),
  });
}
