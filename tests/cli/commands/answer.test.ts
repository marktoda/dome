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
  insertQuestion,
  queryQuestionRecords,
} from "../../../src/projections/questions";

import {
  fixtures,
  installConsoleCapture,
  installFixtureCleanup,
  makeFixture,
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

    const code = await runAnswer({
      id,
      value: "keep",
      vault: f.vaultPath,
      json: true,
    });
    expect(code).toBe(0);

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
});

