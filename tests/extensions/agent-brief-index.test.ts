// dome.agent.brief-index — adoption extractor that reads the dome.agent.brief:today
// block from an adopted daily note and emits a dome.agent.brief fact.
// CB-T6: brief-index extractor → dome.agent.brief fact.

import { describe, expect, test } from "bun:test";

import briefIndex from "../../assets/extensions/dome.agent/processors/brief-index";
import type { Effect, FactEffect } from "../../src/core/effect";
import { treeOid, type Snapshot } from "../../src/core/processor";
import { makeManualProposal } from "../../src/core/proposal";
import { commitOid } from "../../src/core/source-ref";
import { makeProcessorContext } from "../../src/processors/context";

const HEAD_COMMIT = commitOid("abcdef1234567890abcdef1234567890abcdef12");

const TODAY_BLOCK_START = "<!-- dome.agent.brief:today:start -->";
const TODAY_BLOCK_END = "<!-- dome.agent.brief:today:end -->";

function run(opts: {
  readonly files: Readonly<Record<string, string>>;
}): Promise<ReadonlyArray<Effect>> {
  const files = opts.files;
  const snapshot: Snapshot = Object.freeze({
    commit: HEAD_COMMIT,
    tree: treeOid("1111111111111111111111111111111111111111"),
    readFile: async (path: string) => files[path] ?? null,
    listMarkdownFiles: async () => Object.freeze(Object.keys(files)),
    getFileInfo: async () => null,
  });
  const ctx = makeProcessorContext({
    snapshot,
    changedPaths: Object.freeze(Object.keys(files)),
    proposal: makeManualProposal({
      base: HEAD_COMMIT,
      head: HEAD_COMMIT,
      branch: "main",
    }),
    runId: "run-brief-index-test",
    signal: new AbortController().signal,
    input: { kind: "adoption", matchedTriggers: [] },
  });
  return briefIndex.run(ctx as never);
}

function dailyWithTodayBlock(body: string): string {
  return [
    "# Daily 2026-06-14",
    "",
    "## Today",
    "",
    TODAY_BLOCK_START,
    body,
    TODAY_BLOCK_END,
    "",
  ].join("\n");
}

const DAILY_PATH = "wiki/dailies/2026-06-14.md";
const WIKILINK_BODY =
  "Today is about [[wiki/x|the X thing]] and [[wiki/projects/y]].";
const EXPECTED_VALUE = "Today is about the X thing and y.";

describe("dome.agent.brief-index", () => {
  test("emits one dome.agent.brief fact with stripped wikilinks when block is present", async () => {
    const effects = await run({
      files: {
        [DAILY_PATH]: dailyWithTodayBlock(WIKILINK_BODY),
      },
    });
    const facts = effects.filter((e): e is FactEffect => e.kind === "fact");
    expect(facts).toHaveLength(1);
    const fact = facts[0];
    expect(fact?.predicate).toBe("dome.agent.brief");
    expect(fact?.object).toEqual({ kind: "string", value: EXPECTED_VALUE });
    expect(fact?.subject.kind).toBe("page");
    expect(fact?.subject.kind === "page" && String(fact.subject.path)).toBe(
      DAILY_PATH,
    );
    expect(fact?.assertion).toBe("extracted");
    expect(fact?.sourceRefs).toHaveLength(1);
    expect(String(fact?.sourceRefs[0]?.path)).toBe(DAILY_PATH);
  });

  test("emits nothing when the today block is absent", async () => {
    const effects = await run({
      files: {
        [DAILY_PATH]: "# Daily 2026-06-14\n\nNo brief block here.\n",
      },
    });
    const facts = effects.filter((e): e is FactEffect => e.kind === "fact");
    expect(facts).toHaveLength(0);
  });

  test("processes multiple files, emitting one fact per file that has the block", async () => {
    const OTHER_PATH = "wiki/dailies/2026-06-13.md";
    const effects = await run({
      files: {
        [DAILY_PATH]: dailyWithTodayBlock("Summary for today."),
        [OTHER_PATH]: "# Daily 2026-06-13\n\nNo block.\n",
      },
    });
    const facts = effects.filter((e): e is FactEffect => e.kind === "fact");
    expect(facts).toHaveLength(1);
    expect(facts[0]?.subject.kind).toBe("page");
    expect(
      facts[0]?.subject.kind === "page" && String(facts[0].subject.path),
    ).toBe(DAILY_PATH);
  });

  test("collapses extra whitespace in the body value", async () => {
    const effects = await run({
      files: {
        [DAILY_PATH]: dailyWithTodayBlock("  Lots   of   spaces  "),
      },
    });
    const facts = effects.filter((e): e is FactEffect => e.kind === "fact");
    expect(facts).toHaveLength(1);
    expect(facts[0]?.object).toEqual({
      kind: "string",
      value: "Lots of spaces",
    });
  });

  test("handles [[path]] → last path segment without alias", async () => {
    const effects = await run({
      files: {
        [DAILY_PATH]: dailyWithTodayBlock("See [[wiki/concepts/deep-dive]]."),
      },
    });
    const facts = effects.filter((e): e is FactEffect => e.kind === "fact");
    expect(facts[0]?.object).toEqual({
      kind: "string",
      value: "See deep-dive.",
    });
  });

  test("handles [[path|alias]] → alias", async () => {
    const effects = await run({
      files: {
        [DAILY_PATH]: dailyWithTodayBlock("Focus on [[wiki/x|the key project]]."),
      },
    });
    const facts = effects.filter((e): e is FactEffect => e.kind === "fact");
    expect(facts[0]?.object).toEqual({
      kind: "string",
      value: "Focus on the key project.",
    });
  });
});
