// `dome answer` — end-to-end tests (split from tests/cli/commands.test.ts; shared setup lives in ./fixture.ts).

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { runAnswer } from "../../../src/cli/commands/answer";

import {
  questionEffect,
} from "../../../src/core/effect";
import { commitOid, sourceRef } from "../../../src/core/source-ref";
import { openProjectionDb } from "../../../src/projections/db";
import {
  applyQuestionAnswer,
  insertQuestion,
  queryQuestionRecords,
} from "../../../src/projections/questions";

import {
  captured,
  fixtures,
  installConsoleCapture,
  installFixtureCleanup,
  makeFixture,
  record,
} from "./fixture";

installConsoleCapture();
installFixtureCleanup();

// ----- runAnswer ------------------------------------------------------------

describe("runAnswer", () => {
  test("records an answer by question row id", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    const projection = await openProjectionDb({
      path: join(f.vaultPath, ".dome", "state", "projection.db"),
      extensionSet: [],
      processorVersions: [],
      capabilityPolicyHash: "test-policy",
    });
    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    const adopted = commitOid(f.headSha);
    const effect = questionEffect({
      question: "Are these duplicates?",
      sourceRefs: [sourceRef({ commit: adopted, path: "wiki/new.md" })],
      idempotencyKey: "cli-question-1",
      options: ["merge", "keep"],
    });
    insertQuestion(projection.value.db, {
      effect,
      processorId: "test.cli",
      runId: "run-test-fixture",
      adoptedCommit: adopted,
    });
    const id = queryQuestionRecords(projection.value.db)[0]?.id;
    projection.value.db.close();
    expect(id).toBeGreaterThan(0);
    if (id === undefined) return;

    captured.out = [];
    const code = await runAnswer({
      id,
      value: "keep",
      vault: f.vaultPath,
      json: true,
    });
    expect(code).toBe(0);
    const json = record(JSON.parse(captured.out.join("\n")));
    const question = record(json.question);
    expect(question.answered_by).toBe("owner");

    const after = await openProjectionDb({
      path: join(f.vaultPath, ".dome", "state", "projection.db"),
      extensionSet: [],
      processorVersions: [],
      capabilityPolicyHash: "test-policy",
    });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    try {
      const record = queryQuestionRecords(after.value.db)[0];
      expect(record?.answer).toBe("keep");
      expect(record?.answeredAt).not.toBeNull();
    } finally {
      after.value.db.close();
    }
  });

  test("JSON envelope carries answered_by for an auto-answered question", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    const projection = await openProjectionDb({
      path: join(f.vaultPath, ".dome", "state", "projection.db"),
      extensionSet: [],
      processorVersions: [],
      capabilityPolicyHash: "test-policy",
    });
    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    const adopted = commitOid(f.headSha);
    const effect = questionEffect({
      question: "Auto-resolvable?",
      sourceRefs: [sourceRef({ commit: adopted, path: "wiki/new.md" })],
      idempotencyKey: "cli-question-auto",
      options: ["yes", "no"],
    });
    insertQuestion(projection.value.db, {
      effect,
      processorId: "test.cli",
      runId: "run-test-fixture",
      adoptedCommit: adopted,
    });
    const id = queryQuestionRecords(projection.value.db)[0]?.id;
    // Record the answer directly the way the auto-resolution engine does,
    // bypassing the durable-answers write (not the surface under test here).
    applyQuestionAnswer(projection.value.db, {
      idempotencyKey: effect.idempotencyKey,
      answer: "yes",
      answeredAt: new Date(0).toISOString(),
      answeredBy: "auto",
    });
    projection.value.db.close();
    expect(id).toBeGreaterThan(0);
    if (id === undefined) return;

    captured.out = [];
    const code = await runAnswer({ id, vault: f.vaultPath, json: true });
    expect(code).toBe(0);
    const json = record(JSON.parse(captured.out.join("\n")));
    expect(json.answered_by).toBe("auto");
  });

  test("rejects invalid options without answering", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    const projection = await openProjectionDb({
      path: join(f.vaultPath, ".dome", "state", "projection.db"),
      extensionSet: [],
      processorVersions: [],
      capabilityPolicyHash: "test-policy",
    });
    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    const adopted = commitOid(f.headSha);
    insertQuestion(projection.value.db, {
      effect: questionEffect({
        question: "Pick one",
        sourceRefs: [sourceRef({ commit: adopted, path: "wiki/new.md" })],
        idempotencyKey: "cli-question-2",
        options: ["yes", "no"],
      }),
      processorId: "test.cli",
      runId: "run-test-fixture",
      adoptedCommit: adopted,
    });
    const id = queryQuestionRecords(projection.value.db)[0]?.id;
    projection.value.db.close();
    expect(id).toBeGreaterThan(0);
    if (id === undefined) return;

    const code = await runAnswer({
      id,
      value: "maybe",
      vault: f.vaultPath,
    });
    expect(code).toBe(64);

    const after = await openProjectionDb({
      path: join(f.vaultPath, ".dome", "state", "projection.db"),
      extensionSet: [],
      processorVersions: [],
      capabilityPolicyHash: "test-policy",
    });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    try {
      const record = queryQuestionRecords(after.value.db)[0];
      expect(record?.answer).toBeNull();
      expect(record?.answeredAt).toBeNull();
    } finally {
      after.value.db.close();
    }
  });

  test("answered question GET display names the answering actor", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    const projection = await openProjectionDb({
      path: join(f.vaultPath, ".dome", "state", "projection.db"),
      extensionSet: [],
      processorVersions: [],
      capabilityPolicyHash: "test-policy",
    });
    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    const adopted = commitOid(f.headSha);
    insertQuestion(projection.value.db, {
      effect: questionEffect({
        question: "Track this follow-up?",
        sourceRefs: [sourceRef({ commit: adopted, path: "wiki/new.md" })],
        idempotencyKey: "cli-question-already-answered",
        options: ["track", "ignore"],
      }),
      processorId: "test.cli",
      runId: "run-test-fixture",
      adoptedCommit: adopted,
    });
    const id = queryQuestionRecords(projection.value.db)[0]?.id;
    projection.value.db.close();
    expect(id).toBeGreaterThan(0);
    if (id === undefined) return;

    const answerCode = await runAnswer({
      id,
      value: "track",
      vault: f.vaultPath,
    });
    expect(answerCode).toBe(0);

    captured.out = [];
    const displayCode = await runAnswer({
      id,
      vault: f.vaultPath,
    });
    expect(displayCode).toBe(0);
    const output = captured.out.join("\n");
    expect(output).toContain("answered by owner");
  });

  test("already-answered resolve outcome names the answering actor", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    const projection = await openProjectionDb({
      path: join(f.vaultPath, ".dome", "state", "projection.db"),
      extensionSet: [],
      processorVersions: [],
      capabilityPolicyHash: "test-policy",
    });
    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    const adopted = commitOid(f.headSha);
    insertQuestion(projection.value.db, {
      effect: questionEffect({
        question: "Track this follow-up?",
        sourceRefs: [sourceRef({ commit: adopted, path: "wiki/new.md" })],
        idempotencyKey: "cli-question-already-answered-outcome",
        options: ["track", "ignore"],
      }),
      processorId: "test.cli",
      runId: "run-test-fixture",
      adoptedCommit: adopted,
    });
    const id = queryQuestionRecords(projection.value.db)[0]?.id;
    projection.value.db.close();
    expect(id).toBeGreaterThan(0);
    if (id === undefined) return;

    const answerCode = await runAnswer({
      id,
      value: "track",
      vault: f.vaultPath,
    });
    expect(answerCode).toBe(0);

    captured.out = [];
    const alreadyAnsweredCode = await runAnswer({
      id,
      value: "ignore",
      vault: f.vaultPath,
    });
    expect(alreadyAnsweredCode).toBe(0);
    const output = captured.out.join("\n");
    expect(output).toContain("answered by owner");
  });
});

