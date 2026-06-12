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

import matter from "gray-matter";
import { z } from "zod";

import {
  diagnosticEffect,
  questionEffect,
  type Effect,
  type QuestionAutomationPolicy,
  type QuestionRisk,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";
import { shortHash } from "../../../../src/core/short-hash";

const MODEL_SCHEMA = "dome.warden.integrity/v1";

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
    for (const path of wikiPaths) {
      const content = await ctx.snapshot.readFile(path);
      if (content === null) continue;

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

      const contentHash = shortHash(content, 12);
      const policy: QuestionAutomationPolicy = isPeopleContent(path, content)
        ? "owner-needed"
        : "agent-safe";

      for (const finding of result.findings) {
        // Only surface findings that warrant an editorial decision. Low-risk
        // inference is pervasive in a synthesized vault; emitting a question
        // for each one out-produces triage and trains the owner to ignore the
        // warden. Drop low-risk; keep medium/high. (Tunable: the threshold
        // could move to vault config later.)
        if (finding.severity === "low") continue;
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
              ...(policy === "owner-needed"
                ? {
                    ownerNeededReason:
                      "Page is people/management content; resolution may carry interpersonal nuance.",
                  }
                : {}),
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
