// `dome resolve` — end-to-end tests (split from tests/cli/commands.test.ts; shared setup lives in ./fixture.ts).

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { runResolve } from "../../../src/cli/commands/resolve";

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

// ----- runResolve ------------------------------------------------------------

describe("runResolve", () => {
  test("records an answer through the user-facing decision verb", async () => {
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
        idempotencyKey: "cli-resolve-1",
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

    expect(
      await runResolve({
        id,
        value: "track",
        vault: f.vaultPath,
        json: true,
      }),
    ).toBe(0);

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
      expect(record?.answer).toBe("track");
    } finally {
      after.value.db.close();
    }
  });
});

