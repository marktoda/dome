// dome.agent.preference-signals — deterministic preference counter facts
// (memory-quality M5, docs/wiki/specs/preferences.md).
//
// Parses the append-only preferences/signals.md page plus core.md's promoted
// block and emits one `dome.preference.topic` fact per topic: same-sign and
// opposite counts in the 30-day window, first/last signal dates, the current
// state (rejected / promoted / rebutted / candidate / building), the
// candidate rule, and the Wilson × freshness confidence.
//
// Rebuild-eligible by construction (`isRebuildEligibleGardenProcessor`):
// garden phase, `execution.class: deterministic`, signal triggers, and only
// read + graph.write capabilities. The derivation uses no clock — the
// reference "today" is the newest signal date in the file — and no model, so
// `dome rebuild` reproduces every fact from adopted markdown
// (PROJECTIONS_ARE_REBUILDABLE).
//
// Malformed `- ` lines degrade to ONE info diagnostic naming the line
// numbers — never a crash (the consolidator's config-fallback temperament).

import {
  diagnosticEffect,
  factEffect,
  type Effect,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";

import { coreMemoryPath } from "../lib/core-memory";
import {
  collectPreferenceTopics,
  PREFERENCE_SIGNALS_PATH,
  PREFERENCE_TOPIC_PREDICATE,
  preferenceTopicFactValue,
} from "../lib/preferences-shared";

// Defense-in-depth (mirrors dome.daily.attention-discount): the broker
// enforces the declared `dome.preference.*` namespace; a drifted predicate
// fails loudly at the source instead of being silently rejected.
const REQUIRED_NAMESPACE_PREFIX = "dome.preference.";

const preferenceSignals = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    if (!PREFERENCE_TOPIC_PREDICATE.startsWith(REQUIRED_NAMESPACE_PREFIX)) {
      throw new Error(
        `dome.agent.preference-signals: predicate '${PREFERENCE_TOPIC_PREDICATE}' does not start with the declared namespace prefix '${REQUIRED_NAMESPACE_PREFIX}'`,
      );
    }

    const signalsContent = await ctx.snapshot.readFile(
      PREFERENCE_SIGNALS_PATH,
    );
    // The promoted block lives in the same page the agents inject — the
    // config-resolved core path (a malformed value falls back to core.md;
    // the agent processors own the config-invalid diagnostic).
    const coreContent = await ctx.snapshot.readFile(
      coreMemoryPath(ctx.extensionConfig).path,
    );
    const collection = collectPreferenceTopics({ signalsContent, coreContent });

    const effects: Effect[] = [];
    if (collection.problems.length > 0) {
      effects.push(
        diagnosticEffect({
          severity: "info",
          code: "dome.agent.preference-signals.malformed-lines",
          message:
            `${PREFERENCE_SIGNALS_PATH} has ${collection.problems.length} malformed signal line${collection.problems.length === 1 ? "" : "s"} ` +
            `(line${collection.problems.length === 1 ? "" : "s"} ${collection.problems.map((p) => p.line).join(", ")}); ` +
            "expected `- YYYY-MM-DD [+|-] <topic-slug>:: <rule> [(source: [[...]])]`.",
          sourceRefs: [
            ctx.sourceRef(PREFERENCE_SIGNALS_PATH, {
              startLine: collection.problems[0]?.line ?? 1,
              endLine: collection.problems.at(-1)?.line ?? 1,
            }),
          ],
        }),
      );
    }

    for (const topic of collection.topics) {
      effects.push(
        factEffect({
          subject: { kind: "page", path: PREFERENCE_SIGNALS_PATH },
          predicate: PREFERENCE_TOPIC_PREDICATE,
          object: { kind: "string", value: preferenceTopicFactValue(topic) },
          assertion: "extracted",
          sourceRefs: [
            ctx.sourceRef(PREFERENCE_SIGNALS_PATH, {
              startLine: topic.lastSignalLine.line,
              endLine: topic.lastSignalLine.line,
            }),
          ],
        }),
      );
    }
    return Object.freeze(effects);
  },
});

export default preferenceSignals;
