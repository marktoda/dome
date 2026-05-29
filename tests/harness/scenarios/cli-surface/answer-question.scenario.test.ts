// scenarios/cli-surface/answer-question.scenario.test.ts
//
// `dome answer` is the public recovery channel for durable QuestionEffect
// rows. This scenario keeps it end-to-end: a real shipped processor asks a
// question, `inspect` exposes the stable row id, the CLI records the answer,
// and an answer-triggered garden processor emits a follow-up PatchEffect.

import { expect } from "bun:test";
import { join } from "node:path";

import { scenario } from "../../index";

const ANSWER_HANDLER_BUNDLE_ROOT = join(
  __dirname,
  "..",
  "..",
  "fixtures",
  "bundles",
  "test.answer-handler",
);

scenario(
  {
    name: "cli-surface: dome answer records an answer and runs answer handlers",
    tags: [
      { kind: "group", group: "cli-surface" },
      { kind: "effect", effect: "question" },
      { kind: "effect", effect: "patch" },
      { kind: "phase", phase: "adoption" },
      { kind: "phase", phase: "garden" },
      { kind: "capability", capability: "question.ask" },
      { kind: "capability", capability: "patch.auto" },
      { kind: "capability", capability: "read" },
      { kind: "trigger", trigger: "signal" },
      { kind: "trigger", trigger: "answer" },
    ],
    harness: {
      bundles: [
        "dome.markdown",
        { id: "test.answer-handler", root: ANSWER_HANDLER_BUNDLE_ROOT },
      ],
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    const duplicateBody =
      "# Support rota\n\n" +
      "The support rota assigns incident triage ownership for weekday coverage.\n";

    await h.userCommit({
      files: {
        "wiki/support-rota.md": `---\ntype: note\n---\n${duplicateBody}`,
        "wiki/support-rota-copy.md": `---\ntype: note\n---\n${duplicateBody}`,
      },
      message: "add duplicate support rota pages",
    });

    const sync = await h.tick();
    expect(sync.adopted).toBe(true);

    const inspect = await h.runCli(["inspect", "questions", "--json"]);
    expect(inspect.exitCode).toBe(0);
    const rows = JSON.parse(inspect.stdout) as ReadonlyArray<{
      readonly id: number;
      readonly status: string;
      readonly options: ReadonlyArray<string> | string;
    }>;
    expect(rows.length).toBe(1);
    const questionId = rows[0]?.id;
    expect(questionId).toBeGreaterThan(0);
    if (questionId === undefined) return;
    expect(rows[0]?.status).toBe("open");

    const answer = await h.runCli([
      "answer",
      String(questionId),
      "keep separate",
      "--json",
    ]);
    expect(answer.exitCode).toBe(0);
    expect(answer.stderr).toBe("");
    const answered = JSON.parse(answer.stdout) as {
      readonly status: string;
      readonly question: {
        readonly id: number;
        readonly status: string;
        readonly answer: string;
        readonly answered_at: string | null;
      };
      readonly handlers: {
        readonly status: string;
        readonly runs: ReadonlyArray<{ readonly processor_id: string }>;
        readonly sub_proposals: number;
      };
    };
    expect(answered.status).toBe("answered");
    expect(answered.question.id).toBe(questionId);
    expect(answered.question.status).toBe("answered");
    expect(answered.question.answer).toBe("keep separate");
    expect(answered.question.answered_at).not.toBeNull();
    expect(answered.handlers.status).toBe("handled");
    expect(answered.handlers.runs.map((run) => run.processor_id)).toEqual([
      "test.answer-handler.record-duplicate-answer",
    ]);
    expect(answered.handlers.sub_proposals).toBe(1);
    const ledgerRow = h.ledger.raw
      .query<{ trigger_kind: string }, []>(
        "SELECT trigger_kind FROM runs WHERE processor_id = 'test.answer-handler.record-duplicate-answer'",
      )
      .get();
    expect(ledgerRow?.trigger_kind).toBe("answer");

    const adopted = await h.refs.adopted();
    expect(adopted).not.toBeNull();
    if (adopted === null) return;
    await h.expectFile("wiki/answer-handled.md", { atCommit: adopted })
      .toContain(`Question ${questionId}: keep separate`);

    const after = await h.runCli(["inspect", "questions", "--json"]);
    const afterRows = JSON.parse(after.stdout) as ReadonlyArray<{
      readonly id: number;
      readonly status: string;
      readonly answer: string;
    }>;
    expect(afterRows[0]?.id).toBe(questionId);
    expect(afterRows[0]?.status).toBe("answered");
    expect(afterRows[0]?.answer).toBe("keep separate");
  },
);
