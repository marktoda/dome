// dome.warden.daily-briefing — a generative morning hand-off warden.
//
// A warden is a processor, not a new primitive. The integrity warden is
// QUESTIONS-ONLY; this one is GENERATIVE: it composes a concise morning
// briefing summarizing the vault's current state for a foreground agent —
// what looks stale/contradictory (open integrity questions), what needs human
// judgment (owner-needed questions), and what the attention diagnostics flag —
// then writes it to a dated GENERATED page.
//
// Two design rules this processor obeys, both hard-won:
//
//   1. CRON TRIGGER ONLY. The processor WRITES a markdown file; a
//      `document.changed` trigger would re-fire on its own output and cascade.
//      A `schedule` trigger does not re-fire on the resulting sub-proposal's
//      document change, so the garden cascade converges. See the manifest.
//
//   2. NO-OP WITHOUT A MODEL. `if (ctx.modelInvoke === undefined) return [];` —
//      never throw. A throw would turn a model-less bundle into a perpetual
//      stream of failed scheduled runs (the lesson from the integrity warden).
//
// The output lives under `wiki/generated/briefing/<YYYY-MM-DD>.md`. Like the
// intake synthesis pages, a generated/derived surface is `patch.auto`-safe
// (it is not knowledge — it is a recomputable view of knowledge). The date is
// taken from `ctx.now()`, so re-running on the same day overwrites the same
// dated file; because cron does not re-fire on the resulting doc change, this
// is idempotent enough and never cascades.

import { z } from "zod";

import {
  patchEffect,
  type Effect,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
  type ProjectionQuestion,
  type ProjectionQueryView,
} from "../../../../src/core/processor";
import type { SourceRef } from "../../../../src/core/source-ref";

const MODEL_SCHEMA = "dome.warden.daily-briefing/v1";

const BRIEFING_DIR = "wiki/generated/briefing";

type GatheredInputs = {
  readonly ownerNeeded: ReadonlyArray<QuestionSummary>;
  readonly integrityFlags: ReadonlyArray<QuestionSummary>;
  readonly attention: ReadonlyArray<DiagnosticSummary>;
};

type QuestionSummary = {
  readonly question: string;
  readonly processorId: string;
  readonly automationPolicy?: string;
};

type DiagnosticSummary = {
  readonly message: string;
  readonly severity: string;
};

type Briefing = {
  readonly summary: string;
  readonly sections: ReadonlyArray<{
    readonly heading: string;
    readonly items: ReadonlyArray<string>;
  }>;
};

const NonEmptyTrimmedString = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value.length > 0, "expected non-empty string");

const BriefingSchema = z
  .object({
    summary: NonEmptyTrimmedString,
    sections: z.array(
      z
        .object({
          heading: NonEmptyTrimmedString,
          items: z.array(NonEmptyTrimmedString),
        })
        .strict(),
    ),
  })
  .strict();

const dailyBriefing = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    // No model configured → nothing to compose. The warden is cron-triggered,
    // so throwing here would turn a missing provider into a perpetual stream
    // of failed scheduled runs; a clean no-op is the correct degraded mode.
    if (ctx.modelInvoke === undefined) return [];

    const gathered = gatherInputs(ctx.projection);
    // `model.invoke` granted but no provider configured → `modelInvoke` is
    // defined yet throws on call (see model-invoke.ts). Degrade to a no-op
    // rather than a failed scheduled run.
    let briefing: Briefing;
    try {
      briefing = await ctx.modelInvoke.structured({
        schemaName: MODEL_SCHEMA,
        prompt: promptForBriefing(gathered),
        parse: parseBriefing,
      });
    } catch {
      return [];
    }

    const date = isoDate(ctx.now());
    const outputPath = `${BRIEFING_DIR}/${date}.md`;

    return [
      patchEffect({
        mode: "auto",
        changes: [
          {
            kind: "write",
            path: outputPath,
            content: renderBriefingPage({ date, briefing }),
          },
        ],
        reason: `dome.warden: morning briefing ${outputPath}`,
        // The briefing page lives under wiki/, which is read-granted, so a
        // sourceRef on it is within the effective read grant.
        sourceRefs: briefingSourceRefs(ctx, outputPath),
      }),
    ];
  },
});

export default dailyBriefing;

// Gather inputs deterministically and DEFENSIVELY: `ctx.projection` is absent
// on garden runs that did not receive a projection view, so every read is
// guarded. open questions split into owner-needed (human judgment) and the
// integrity-warden findings (stale/contradictory); attention diagnostics carry
// the rest.
function gatherInputs(
  projection: ProjectionQueryView | undefined,
): GatheredInputs {
  if (projection === undefined) {
    return Object.freeze({
      ownerNeeded: Object.freeze([]),
      integrityFlags: Object.freeze([]),
      attention: Object.freeze([]),
    });
  }

  const open = safeQuestions(projection);
  const ownerNeeded: QuestionSummary[] = [];
  const integrityFlags: QuestionSummary[] = [];
  for (const q of open) {
    const summary: QuestionSummary = {
      question: q.question,
      processorId: q.processorId,
      ...(q.metadata?.automationPolicy !== undefined
        ? { automationPolicy: q.metadata.automationPolicy }
        : {}),
    };
    if (q.metadata?.automationPolicy === "owner-needed") {
      ownerNeeded.push(summary);
    }
    if (q.processorId === "dome.warden.integrity") {
      integrityFlags.push(summary);
    }
  }

  const attention: DiagnosticSummary[] = safeDiagnostics(projection).map(
    (d) => ({ message: d.message, severity: d.severity }),
  );

  return Object.freeze({
    ownerNeeded: Object.freeze(ownerNeeded),
    integrityFlags: Object.freeze(integrityFlags),
    attention: Object.freeze(attention),
  });
}

function safeQuestions(
  projection: ProjectionQueryView,
): ReadonlyArray<ProjectionQuestion> {
  try {
    return projection.questions({ resolved: false });
  } catch {
    return [];
  }
}

function safeDiagnostics(
  projection: ProjectionQueryView,
): ReadonlyArray<DiagnosticSummary> {
  try {
    return projection
      .diagnostics()
      .map((d) => ({ message: d.message, severity: d.severity }));
  } catch {
    return [];
  }
}

function briefingSourceRefs(
  ctx: ProcessorContext,
  outputPath: string,
): ReadonlyArray<SourceRef> {
  // The briefing is derived from transient projection rows (questions /
  // diagnostics), not from a single readable markdown blob, so we anchor the
  // evidence to the generated page itself — which is within the read grant.
  return Object.freeze([ctx.sourceRef(outputPath)]);
}

function isoDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function promptForBriefing(gathered: GatheredInputs): string {
  return [
    "You are a morning hand-off warden for a Dome vault. Compose a concise",
    "briefing for a foreground agent starting its day, summarizing the vault's",
    "current state. Return STRICT JSON only:",
    '{ "summary": string, "sections": [{ "heading": string, "items": string[] }] }.',
    "summary: a one-paragraph orientation.",
    "sections: group the inputs below into useful headings such as",
    "  'Needs human judgment' (owner-needed open questions),",
    "  'Stale or contradictory' (integrity-warden flags), and",
    "  'Needs attention' (diagnostics). Omit empty sections.",
    "Use only the inputs provided; do not invent vault state.",
    "",
    "Owner-needed open questions:",
    ...renderList(gathered.ownerNeeded.map((q) => q.question)),
    "",
    "Integrity-warden flags:",
    ...renderList(gathered.integrityFlags.map((q) => q.question)),
    "",
    "Attention diagnostics:",
    ...renderList(
      gathered.attention.map((d) => `[${d.severity}] ${d.message}`),
    ),
  ].join("\n");
}

function renderList(items: ReadonlyArray<string>): ReadonlyArray<string> {
  if (items.length === 0) return ["  (none)"];
  return items.map((item) => `  - ${item}`);
}

function parseBriefing(value: unknown): Briefing {
  const parsed = BriefingSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(parsed.error.message);
  }
  return Object.freeze({
    summary: parsed.data.summary,
    sections: Object.freeze(
      parsed.data.sections.map((s) =>
        Object.freeze({
          heading: s.heading,
          items: Object.freeze([...s.items]),
        }),
      ),
    ),
  });
}

function renderBriefingPage(input: {
  readonly date: string;
  readonly briefing: Briefing;
}): string {
  const { briefing } = input;
  const lines: string[] = [
    "---",
    "type: briefing",
    `date: ${input.date}`,
    "processor: dome.warden.daily-briefing",
    "---",
    "",
    `# Morning briefing — ${input.date}`,
    "",
    briefing.summary,
    "",
  ];
  for (const section of briefing.sections) {
    if (section.items.length === 0) continue;
    lines.push(
      `## ${section.heading}`,
      "",
      ...section.items.map((item) => `- ${item}`),
      "",
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
