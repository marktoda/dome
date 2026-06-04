// dome.warden.daily-briefing — unit tests with an INJECTED FAKE MODEL.
//
// The daily-briefing warden is a garden-phase, CRON-triggered llm processor.
// Unlike the integrity warden (questions-only), it is GENERATIVE: it composes a
// morning hand-off briefing from the vault's current state (recent changes,
// open integrity questions, owner-needed items, attention diagnostics) and
// writes it to a dated GENERATED page via a single `patch.auto` write. It is
// cron-triggered (NOT document.changed) so its own write never re-fires it.
//
// We inject a fake `ModelInvokeFn` and a canned `ProjectionQueryView` via
// `makeProcessorContext({ modelInvoke, projection, now })` so the tests are
// deterministic and never call a real model. Mirrors the seams used by
// `warden-integrity.test.ts`.

import { describe, expect, test } from "bun:test";

import dailyBriefing from "../../assets/extensions/dome.warden/processors/daily-briefing";
import type { Effect, PatchEffect, QuestionEffect } from "../../src/core/effect";
import { makeManualProposal } from "../../src/core/proposal";
import { commitOid } from "../../src/core/source-ref";
import {
  treeOid,
  type ModelInvokeFn,
  type ModelInvokeStructuredInput,
  type ProjectionQueryView,
  type ProjectionQuestion,
  type Snapshot,
} from "../../src/core/processor";
import { makeProcessorContext } from "../../src/processors/context";

const HEAD_COMMIT = commitOid("2222222222222222222222222222222222222222");
const NOW = new Date("2026-06-03T07:00:00.000Z");

describe("dome.warden.daily-briefing", () => {
  test("with a model + open questions → one patch.auto write to the dated generated briefing page", async () => {
    const effects = await runBriefing({
      questions: [
        fakeQuestion({
          id: 1,
          idempotencyKey: "dome.warden.integrity:wiki/entities/danny.md:abc:historical-as-ongoing",
          processorId: "dome.warden.integrity",
          question: "Integrity flag in wiki/entities/danny.md: ...",
          automationPolicy: "owner-needed",
        }),
        fakeQuestion({
          id: 2,
          idempotencyKey: "dome.warden.integrity:wiki/concepts/migration.md:def:contradiction",
          processorId: "dome.warden.integrity",
          question: "Integrity flag in wiki/concepts/migration.md: ...",
          automationPolicy: "agent-safe",
        }),
      ],
    });

    const patches = effects.filter(isPatch);
    expect(patches.length).toBe(1);
    const patch = patches[0];
    if (patch === undefined) throw new Error("expected a patch");

    // Generative warden writes a surface — never questions / facts.
    expect(effects.some((e) => e.kind === "question")).toBe(false);
    expect(effects.some((e) => e.kind === "fact")).toBe(false);

    // patch.auto over a generated, derived surface (like intake synthesis).
    expect(patch.mode).toBe("auto");
    expect(patch.changes.length).toBe(1);
    const change = patch.changes[0];
    if (change === undefined || change.kind !== "write") {
      throw new Error("expected a write change");
    }
    expect(change.path as string).toBe("wiki/generated/briefing/2026-06-03.md");
    expect(change.content).toContain("MORNING-BRIEFING-BODY");
    expect(patch.sourceRefs.length).toBeGreaterThan(0);
  });

  test("ctx.modelInvoke unavailable → no-op (no throw)", async () => {
    const ctx = makeProcessorContext({
      snapshot: fakeSnapshot(),
      changedPaths: [],
      proposal: makeManualProposal({
        base: HEAD_COMMIT,
        head: HEAD_COMMIT,
        branch: "main",
      }),
      runId: "run-briefing-nomodel",
      signal: new AbortController().signal,
      now: NOW,
      input: scheduleInput(),
      projection: fakeProjection([]),
    });
    expect(await dailyBriefing.run(ctx)).toEqual([]);
  });

  test("write path is the dated generated page from ctx.now()", async () => {
    const other = new Date("2026-12-25T07:00:00.000Z");
    const effects = await runBriefing({ questions: [], now: other });
    const patch = effects.filter(isPatch)[0];
    if (patch === undefined) throw new Error("expected a patch");
    const change = patch.changes[0];
    if (change === undefined || change.kind !== "write") {
      throw new Error("expected a write change");
    }
    expect(change.path as string).toBe("wiki/generated/briefing/2026-12-25.md");
  });

  test("no projection surface → still composes a briefing (defensive gather)", async () => {
    const ctx = makeProcessorContext({
      snapshot: fakeSnapshot(),
      changedPaths: [],
      proposal: makeManualProposal({
        base: HEAD_COMMIT,
        head: HEAD_COMMIT,
        branch: "main",
      }),
      runId: "run-briefing-noprojection",
      signal: new AbortController().signal,
      now: NOW,
      input: scheduleInput(),
      modelInvoke: fakeModelInvoke(),
      // projection intentionally omitted
    });
    const effects = await dailyBriefing.run(ctx);
    const patch = effects.filter(isPatch)[0];
    if (patch === undefined) throw new Error("expected a patch");
    const change = patch.changes[0];
    if (change === undefined || change.kind !== "write") {
      throw new Error("expected a write change");
    }
    expect(change.path as string).toBe("wiki/generated/briefing/2026-06-03.md");
  });
});

async function runBriefing(opts: {
  readonly questions: ReadonlyArray<ProjectionQuestion>;
  readonly now?: Date;
}): Promise<ReadonlyArray<Effect>> {
  const ctx = makeProcessorContext({
    snapshot: fakeSnapshot(),
    changedPaths: [],
    proposal: makeManualProposal({
      base: HEAD_COMMIT,
      head: HEAD_COMMIT,
      branch: "main",
    }),
    runId: "run-briefing",
    signal: new AbortController().signal,
    now: opts.now ?? NOW,
    input: scheduleInput(),
    modelInvoke: fakeModelInvoke(),
    projection: fakeProjection(opts.questions),
  });
  return dailyBriefing.run(ctx);
}

function scheduleInput(): unknown {
  return {
    kind: "schedule",
    cron: "0 7 * * *",
    firedAt: NOW.toISOString(),
  };
}

function fakeSnapshot(): Snapshot {
  return Object.freeze({
    commit: HEAD_COMMIT,
    tree: treeOid("3333333333333333333333333333333333333333"),
    readFile: async () => null,
    listMarkdownFiles: async () => Object.freeze([]),
    getFileInfo: async () => null,
  });
}

// A canned ModelInvokeFn: `.structured` routes a fixed briefing body through
// the caller's own parse fn (matches the real model boundary, which validates
// the parsed value).
function fakeModelInvoke(): ModelInvokeFn {
  const fn = async (): Promise<string> => "MORNING-BRIEFING-BODY";
  const structured = async <T,>(
    input: ModelInvokeStructuredInput<T>,
  ): Promise<T> =>
    input.parse({
      summary: "MORNING-BRIEFING-BODY",
      sections: [
        { heading: "Needs human judgment", items: ["Resolve Danny flag"] },
      ],
    });
  return Object.assign(fn, { structured }) as ModelInvokeFn;
}

function fakeProjection(
  questions: ReadonlyArray<ProjectionQuestion>,
): ProjectionQueryView {
  return Object.freeze({
    facts: () => Object.freeze([]),
    diagnostics: () => Object.freeze([]),
    questions: (filter?: { readonly resolved?: boolean }) =>
      filter?.resolved === true ? Object.freeze([]) : questions,
    searchDocuments: () => Object.freeze([]),
    documentsByPath: () => Object.freeze([]),
  });
}

function fakeQuestion(opts: {
  readonly id: number;
  readonly idempotencyKey: string;
  readonly processorId: string;
  readonly question: string;
  readonly automationPolicy: "agent-safe" | "model-safe" | "owner-needed";
}): ProjectionQuestion {
  const base: QuestionEffect = {
    kind: "question",
    question: opts.question,
    idempotencyKey: opts.idempotencyKey,
    sourceRefs: [],
    metadata: { automationPolicy: opts.automationPolicy },
  };
  return Object.freeze({
    ...base,
    id: opts.id,
    processorId: opts.processorId,
    adoptedCommit: HEAD_COMMIT,
    askedAt: "2026-06-02T12:00:00.000Z",
    answeredAt: null,
    answer: null,
  }) as ProjectionQuestion;
}

function isPatch(effect: Effect): effect is PatchEffect {
  return effect.kind === "patch";
}
