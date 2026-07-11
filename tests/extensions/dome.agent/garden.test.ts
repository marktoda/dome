import { describe, expect, test } from "bun:test";
import garden, {
  GARDEN_REASON_PREFIX,
  settledGardenOpportunityIds,
} from "../../../assets/extensions/dome.agent/processors/garden";
import { commitOid } from "../../../src/core/source-ref";
import { treeOid, type ProcessorContext } from "../../../src/core/processor";
import { compileGardeningPlan } from "../../../assets/extensions/dome.agent/lib/gardening";

const LONELY = "---\ndescription: Lonely\nstatus: active\n---\n# Lonely\n";

function context(opts: {
  readonly files: Readonly<Record<string, string>>;
  readonly step?: (input: unknown) => Promise<unknown>;
  readonly proposals?: ReadonlyArray<{ processorId: string; reason: string }>;
}): ProcessorContext {
  const paths = Object.keys(opts.files);
  return {
    snapshot: {
      commit: commitOid("a".repeat(40)),
      tree: treeOid("b".repeat(40)),
      readFile: async (path) => opts.files[path] ?? null,
      listMarkdownFiles: async () => paths,
      getFileInfo: async () => ({
        lastChangedCommit: commitOid("c".repeat(40)),
        lastChangedAt: "2026-01-01T00:00:00.000Z",
        lastHumanChangedAt: "2026-01-01T00:00:00.000Z",
      }),
    },
    changedPaths: [],
    proposal: null,
    runId: "garden-run",
    input: {},
    now: () => new Date("2026-07-09T06:00:00.000Z"),
    signal: new AbortController().signal,
    capabilities: {} as never,
    extensionConfig: {},
    ...(opts.step
      ? { modelInvoke: { step: opts.step as never } as never }
      : {}),
    operational: {
      outbox: () => [],
      quarantines: () => [],
      orphanRuns: () => [],
      runs: () => [],
      questions: () => [],
      proposals: () => (opts.proposals ?? []).map((proposal, index) => ({
        ...proposal,
        id: index + 1,
        extensionId: "dome.agent",
        paths: [],
        createdAt: "2026-07-09T00:00:00.000Z",
        status: "rejected" as const,
        decidedAt: "2026-07-09T01:00:00.000Z",
      })),
    },
    sourceRef: ((path: string) => ({ commit: commitOid("a".repeat(40)), path })) as never,
  };
}

describe("dome.agent.garden", () => {
  test("staged semantic edits emit propose mode, never auto", async () => {
    let calls = 0;
    const effects = await garden.run(context({
      files: {
        "core.md": "# Core\n",
        "wiki/entities/lonely.md": "---\ndescription: Lonely\nstatus: active\n---\n# Lonely\n",
      },
      step: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            toolCalls: [{
              id: "1",
              name: "writePage",
              input: {
                path: "wiki/entities/lonely.md",
                content: "---\ndescription: Lonely\nstatus: active\n---\n# Lonely\n\nSee [[wiki/concepts/home]].\n",
              },
            }],
            text: null,
          };
        }
        return { toolCalls: [], text: "Connected the orphan to its conceptual home." };
      },
    }));
    const patch = effects.find((effect) => effect.kind === "patch");
    expect(patch?.kind === "patch" ? patch.mode : null).toBe("propose");
    expect(patch?.kind === "patch" ? patch.reason : "").toContain(GARDEN_REASON_PREFIX);
  });

  test("no model provider is a clean no-op", async () => {
    const effects = await garden.run(context({
      files: {
        "wiki/entities/lonely.md": "---\ndescription: Lonely\nstatus: active\n---\n",
      },
    }));
    expect(effects).toEqual([]);
  });

  test("an empty plan never calls the model", async () => {
    let calls = 0;
    const effects = await garden.run(context({
      files: {},
      step: async () => {
        calls += 1;
        return { toolCalls: [], text: "unexpected" };
      },
    }));
    expect(effects).toEqual([]);
    expect(calls).toBe(0);
  });

  test("a model failure discards every staged edit atomically", async () => {
    let calls = 0;
    const effects = await garden.run(context({
      files: { "wiki/entities/lonely.md": LONELY },
      step: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            toolCalls: [{
              id: "1",
              name: "writePage",
              input: {
                path: "wiki/entities/lonely.md",
                content: `${LONELY}\n[[wiki/concepts/home]]\n`,
              },
            }],
            text: null,
          };
        }
        throw new Error("provider failed");
      },
    }));
    expect(effects.some((effect) => effect.kind === "patch")).toBe(false);
    expect(effects).toContainEqual(expect.objectContaining({
      kind: "diagnostic",
      code: "dome.agent.garden-failed",
    }));
  });

  test("the changed-file cap discards an over-broad proposal", async () => {
    let calls = 0;
    const effects = await garden.run(context({
      files: { "wiki/entities/lonely.md": LONELY },
      step: async () => {
        calls += 1;
        if (calls > 1) return { toolCalls: [], text: "done" };
        return {
          toolCalls: Array.from({ length: 31 }, (_, index) => ({
            id: String(index),
            name: "writePage",
            input: {
              path: `wiki/entities/generated-${index}.md`,
              content: `---\ndescription: Generated ${index}\n---\n`,
            },
          })),
          text: null,
        };
      },
    }));
    expect(effects.some((effect) => effect.kind === "patch")).toBe(false);
    expect(effects).toContainEqual(expect.objectContaining({
      kind: "diagnostic",
      code: "dome.agent.garden-overreach",
    }));
  });

  test("a durable proposal decision suppresses the exact evidence before model invocation", async () => {
    const selected = compileGardeningPlan({
      documents: [{
        path: "wiki/entities/lonely.md",
        content: LONELY,
      }],
      today: "2026-07-09",
      limit: 1,
    }).opportunities[0]!;
    let calls = 0;
    const effects = await garden.run(context({
      files: { "wiki/entities/lonely.md": LONELY },
      proposals: [{
        processorId: "dome.agent.garden",
        reason: `${GARDEN_REASON_PREFIX}${selected.id}: owner rejected`,
      }],
      step: async () => {
        calls += 1;
        return { toolCalls: [], text: "unexpected" };
      },
    }));
    expect(effects).toEqual([]);
    expect(calls).toBe(0);
  });

  test("proposal reasons recover settled opportunity ids", () => {
    const ids = settledGardenOpportunityIds([
      { processorId: "dome.agent.garden", reason: `${GARDEN_REASON_PREFIX}orphan-page:123456abcdef: linked it` },
      { processorId: "other", reason: `${GARDEN_REASON_PREFIX}stale-claims:aaaaaaaaaaaa` },
    ]);
    expect([...ids]).toEqual(["orphan-page:123456abcdef"]);
  });
});
