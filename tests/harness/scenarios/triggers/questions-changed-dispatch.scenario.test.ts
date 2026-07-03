// scenarios/triggers/questions-changed-dispatch.scenario.test.ts
//
// The `questions.changed` operational channel end-to-end through the host
// (processors.md §"Triggers and signals"):
//
//   1. A garden processor asks a question → the recordQuestion sink sets the
//      host's questions-changed flag → the tick epilogue dispatches the
//      subscribed garden processor exactly once.
//   2. Recursion guard: the subscriber itself asks a question during the
//      epilogue dispatch (re-setting the flag mid-dispatch) — the tick must
//      NOT loop; still exactly one subscriber run this tick.
//   3. Carryover: the mid-dispatch re-set survives on the host-scoped flag,
//      so the immediately following quiet tick dispatches exactly once more
//      (the subscriber sees its follow-up already open and emits nothing).
//   4. Termination: a third quiet tick has a clear flag and no question
//      activity — zero further dispatches.

import { expect } from "bun:test";
import { join } from "node:path";

import { scenario } from "../../index";

const QUESTIONS_CHANGED_BUNDLE_ROOT = join(
  __dirname,
  "..",
  "..",
  "fixtures",
  "bundles",
  "test.questions-changed",
);

scenario(
  {
    name: "triggers: questions.changed dispatches once per tick; mid-dispatch changes carry to the next tick",
    tags: [
      { kind: "group", group: "triggers" },
      { kind: "trigger", trigger: "signal" },
      { kind: "effect", effect: "question" },
      { kind: "phase", phase: "garden" },
      { kind: "capability", capability: "question.ask" },
      { kind: "capability", capability: "questions.read" },
    ],
    harness: {
      bundles: [
        { id: "test.questions-changed", root: QUESTIONS_CHANGED_BUNDLE_ROOT },
      ],
    },
  },
  async (h) => {
    // Step 0: seed the adopted ref. No questions exist yet, so no dispatch.
    {
      const seed = await h.tick();
      expect(seed.adopted).toBe(true);
    }
    await h
      .expectLedger({ processorId: "test.questions-changed.subscriber" })
      .toHaveCount(0);

    // Step 1: create the file the ask processor watches. Its garden run asks
    // a question; the tick epilogue must dispatch the subscriber exactly once
    // even though the subscriber re-sets the flag by asking its own question.
    await h.userCommit({
      files: { "wiki/ask.md": "# Ask\n\nWho owns this?\n" },
      message: "trigger the ask processor",
    });
    {
      const result = await h.tick();
      expect(result.adopted).toBe(true);
    }

    await h
      .expectLedger({ processorId: "test.questions-changed.ask" })
      .toHaveExactlyOne();
    await h
      .expectLedger({ processorId: "test.questions-changed.subscriber" })
      .toHaveExactlyOne();
    await h
      .expectLedger({ processorId: "test.questions-changed.subscriber" })
      .toAllHaveStatus("succeeded");

    // Both questions are durable: the ask processor's and the subscriber's
    // own follow-up (asked during the epilogue dispatch).
    await h.expectProjection().questions().toHaveCount(2);

    // Step 2: carryover. The subscriber's mid-dispatch question re-set the
    // host-scoped flag AFTER the epilogue cleared it, so this quiet tick's
    // epilogue must dispatch exactly once more — despite the tick having no
    // question activity of its own. The subscriber now sees its follow-up
    // already open and emits nothing, so the flag stays clear.
    await h.tick();
    await h
      .expectLedger({ processorId: "test.questions-changed.subscriber" })
      .toHaveCount(2);
    await h
      .expectLedger({ processorId: "test.questions-changed.subscriber" })
      .toAllHaveStatus("succeeded");
    await h.expectProjection().questions().toHaveCount(2);

    // Step 3: termination. Flag is clear and nothing touches the question
    // store — no further dispatch.
    await h.tick();
    await h
      .expectLedger({ processorId: "test.questions-changed.subscriber" })
      .toHaveCount(2);
  },
);
