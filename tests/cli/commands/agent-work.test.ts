import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getAdoptedRef, getCurrentBranch } from "../../../src/adopted-ref";
import { runAgentWork } from "../../../src/cli/commands/agent-work";
import { runInit } from "../../../src/cli/commands/init";
import { runSync } from "../../../src/cli/commands/sync";
import { resolveBundleRoots } from "../../../src/cli/commands/sync-shared";
import { questionEffect } from "../../../src/core/effect";
import { commitOid, sourceRef } from "../../../src/core/source-ref";
import { openVaultRuntime } from "../../../src/engine/host/vault-runtime";
import { add, commit } from "../../../src/git";
import { insertQuestion } from "../../../src/projections/questions";

const logs: string[] = [];
const errors: string[] = [];
const originalLog = console.log;
const originalError = console.error;
let vault = "";

beforeEach(async () => {
  logs.length = 0;
  errors.length = 0;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
  vault = mkdtempSync(join(tmpdir(), "dome-agent-work-cli-"));
  expect(await runInit({ path: vault })).toBe(0);
  await mkdir(join(vault, "wiki"), { recursive: true });
  await writeFile(join(vault, "wiki", "source.md"), "# Source\n\nTrack the launch.\n");
  await add(vault, "wiki/source.md");
  await commit({ path: vault, message: "seed source" });
  expect(await runSync({ vault, quiet: true })).toBe(0);
  logs.length = 0;
  errors.length = 0;
});

afterEach(async () => {
  console.log = originalLog;
  console.error = originalError;
  await rm(vault, { recursive: true, force: true });
});

describe("dome agent-work", () => {
  test("lists and completes work for a direct filesystem harness", async () => {
    const branch = await getCurrentBranch(vault);
    const adopted = await getAdoptedRef(vault, branch ?? "main");
    expect(adopted).not.toBeNull();
    if (adopted === null) return;
    const evidence = sourceRef({
      path: "wiki/source.md",
      commit: commitOid(adopted),
    });
    const runtime = await openVaultRuntime({
      vaultPath: vault,
      ...resolveBundleRoots({ vaultPath: vault }),
    });
    expect(runtime.ok).toBe(true);
    if (!runtime.ok) return;
    insertQuestion(runtime.value.projectionDb, {
      effect: questionEffect({
        question: "Track the launch?",
        options: ["track", "ignore"],
        sourceRefs: [evidence],
        idempotencyKey: "test.cli:agent-work",
        metadata: {
          resolutionMode: "dispatch",
          automationPolicy: "agent-safe",
          risk: "low",
        },
      }),
      processorId: "test.cli.agent-work",
      runId: "run-cli-agent-work",
      adoptedCommit: commitOid(adopted),
    });
    await runtime.value.close();

    expect(await runAgentWork({ vault, json: true })).toBe(0);
    const snapshot = JSON.parse(logs.at(-1) ?? "{}") as {
      items: Array<{ questionId: number; revision: string }>;
    };
    expect(snapshot.items).toHaveLength(1);
    const item = snapshot.items[0]!;

    logs.length = 0;
    expect(await runAgentWork({
      vault,
      id: item.questionId,
      answer: "track",
      revision: item.revision,
      reason: "The source contains an explicit launch commitment.",
      evidence: ["wiki/source.md"],
      json: true,
    })).toBe(0);
    const completed = JSON.parse(logs.at(-1) ?? "{}") as {
      status: string;
      question: { answered_by: string };
    };
    expect(completed.status).toBe("completed");
    expect(completed.question.answered_by).toBe("agent");
  }, 120_000);
});
