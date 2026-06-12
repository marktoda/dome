// dome.agent.active-projects — the second gated core.md writer (v1 chunk 3b
// Task 4; two-gated-writers contract in docs/wiki/specs/preferences.md).
// Deterministic garden processor: derives per-page open-loop tallies from the
// dailies (dome.daily's source-backed open-loop machinery) and splices the
// rendered list into core.md's `dome.agent:active-projects` block. Owner
// prose and the promoted-preferences block must stay byte-untouched.

import { describe, expect, test } from "bun:test";

import activeProjects from "../../../assets/extensions/dome.agent/processors/active-projects";
import {
  ACTIVE_PROJECTS_EMPTY_STATE,
  ACTIVE_PROJECTS_END,
  ACTIVE_PROJECTS_START,
} from "../../../assets/extensions/dome.agent/lib/active-projects";
import {
  PROMOTED_PREFERENCES_END,
  PROMOTED_PREFERENCES_START,
} from "../../../assets/extensions/dome.agent/lib/preferences-shared";
import type {
  DiagnosticEffect,
  Effect,
  PatchEffect,
} from "../../../src/core/effect";
import { treeOid, type Snapshot } from "../../../src/core/processor";
import { makeManualProposal } from "../../../src/core/proposal";
import { commitOid } from "../../../src/core/source-ref";
import { makeProcessorContext } from "../../../src/processors/context";

const HEAD_COMMIT = commitOid("6666666666666666666666666666666666666666");

const OPEN_LOOPS_START = "<!-- dome.daily:open-loops:start -->";
const OPEN_LOOPS_END = "<!-- dome.daily:open-loops:end -->";

function run(opts: {
  readonly files: Readonly<Record<string, string>>;
}): Promise<ReadonlyArray<Effect>> {
  const files = opts.files;
  const snapshot: Snapshot = Object.freeze({
    commit: HEAD_COMMIT,
    tree: treeOid("7777777777777777777777777777777777777777"),
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
    runId: "run-active-projects-test",
    signal: new AbortController().signal,
    input: { kind: "garden", matchedTriggers: [] },
  });
  return activeProjects.run(ctx as never);
}

function daily(lines: ReadonlyArray<string>): string {
  return [
    "# Daily",
    "",
    "## Open Loops",
    "",
    OPEN_LOOPS_START,
    "### Source-backed Open Loops",
    ...lines,
    OPEN_LOOPS_END,
    "",
  ].join("\n");
}

const CORE_WITH_BOTH_BLOCKS = [
  "# Core memory",
  "",
  "## Who I am",
  "",
  "Owner prose that must never move.",
  "",
  "## Active projects",
  "",
  "## Standing preferences",
  "",
  PROMOTED_PREFERENCES_START,
  "- filing:: meeting notes go under notes/ (confidence 0.44)",
  PROMOTED_PREFERENCES_END,
  "",
  "Trailing owner prose.",
  "",
].join("\n");

const TWO_DAILIES = Object.freeze({
  "wiki/dailies/2026-06-09.md": daily([
    "- [ ] ship the API draft (from [[wiki/entities/acme]])",
    "- [ ] book the offsite venue (from [[wiki/dailies/2026-06-08]])",
  ]),
  "wiki/dailies/2026-06-10.md": daily([
    "- [ ] ship the API draft (from [[wiki/entities/acme]])",
    "- [ ] tighten pricing tiers (from [[wiki/entities/acme]])",
    "- [ ] review pricing research (from [[wiki/concepts/pricing]])",
  ]),
});

const EXPECTED_BLOCK = [
  ACTIVE_PROJECTS_START,
  "- [[wiki/entities/acme]] — 2 open loops, last touched 2026-06-10",
  "- [[wiki/concepts/pricing]] — 1 open loop, last touched 2026-06-10",
  ACTIVE_PROJECTS_END,
].join("\n");

const EXPECTED_CORE = CORE_WITH_BOTH_BLOCKS.replace(
  "## Active projects",
  `## Active projects\n\n${EXPECTED_BLOCK}`,
);

describe("dome.agent.active-projects", () => {
  test("splices the block under ## Active projects; prose + promoted block byte-untouched", async () => {
    const effects = await run({
      files: { ...TWO_DAILIES, "core.md": CORE_WITH_BOTH_BLOCKS },
    });
    const patches = effects.filter(
      (e): e is PatchEffect => e.kind === "patch",
    );
    expect(patches).toHaveLength(1);
    const patch = patches[0];
    expect(patch?.mode).toBe("auto");
    expect(patch?.reason).toBe(
      "dome.agent: refresh active-projects block (2 projects)",
    );
    expect(patch?.changes).toHaveLength(1);
    const change = patch?.changes[0];
    expect(change?.kind).toBe("write");
    if (change?.kind !== "write") return;
    expect(String(change.path)).toBe("core.md");
    // Byte-exact: the only difference is the new block under the heading —
    // owner prose and the promoted-preferences block are untouched.
    expect(change.content).toBe(EXPECTED_CORE);
  });

  test("dailies are excluded as project pages and loops dedupe across dailies", async () => {
    const effects = await run({
      files: { ...TWO_DAILIES, "core.md": CORE_WITH_BOTH_BLOCKS },
    });
    const patch = effects.find((e): e is PatchEffect => e.kind === "patch");
    const change = patch?.changes[0];
    if (change?.kind !== "write") throw new Error("expected write change");
    // The daily-sourced loop never becomes a project; the duplicated acme
    // loop counts once (2 distinct loops, not 3 occurrences).
    expect(change.content).not.toContain("wiki/dailies/2026-06-08");
    expect(change.content).toContain("— 2 open loops");
  });

  test("a loop settled in any daily stops counting", async () => {
    const effects = await run({
      files: {
        "wiki/dailies/2026-06-09.md": daily([
          "- [ ] ship the API draft (from [[wiki/entities/acme]])",
          "- [ ] tighten pricing tiers (from [[wiki/entities/acme]])",
        ]),
        "wiki/dailies/2026-06-10.md": daily([
          "- [x] ship the API draft (from [[wiki/entities/acme]])",
        ]),
        "core.md": CORE_WITH_BOTH_BLOCKS,
      },
    });
    const patch = effects.find((e): e is PatchEffect => e.kind === "patch");
    const change = patch?.changes[0];
    if (change?.kind !== "write") throw new Error("expected write change");
    expect(change.content).toContain(
      "- [[wiki/entities/acme]] — 1 open loop, last touched 2026-06-09",
    );
  });

  test("no candidates → the block carries the empty-state line", async () => {
    const effects = await run({
      files: { "core.md": CORE_WITH_BOTH_BLOCKS },
    });
    const patch = effects.find((e): e is PatchEffect => e.kind === "patch");
    expect(patch?.reason).toBe(
      "dome.agent: refresh active-projects block (0 projects)",
    );
    const change = patch?.changes[0];
    if (change?.kind !== "write") throw new Error("expected write change");
    expect(change.content).toContain(
      [
        ACTIVE_PROJECTS_START,
        ACTIVE_PROJECTS_EMPTY_STATE,
        ACTIVE_PROJECTS_END,
      ].join("\n"),
    );
  });

  test("idempotent: a core.md already carrying the current block yields zero effects", async () => {
    const effects = await run({
      files: { ...TWO_DAILIES, "core.md": EXPECTED_CORE },
    });
    expect(effects).toEqual([]);
  });

  test("marker anomalies → info diagnostic, no patch", async () => {
    const damaged = [
      CORE_WITH_BOTH_BLOCKS,
      ACTIVE_PROJECTS_START,
      "- [[wiki/entities/stale]] — 1 open loop, last touched 2026-01-01",
      // No end marker: a half-open block a human left behind.
    ].join("\n");
    const effects = await run({
      files: { ...TWO_DAILIES, "core.md": damaged },
    });
    expect(effects.filter((e) => e.kind === "patch")).toEqual([]);
    const diagnostics = effects.filter(
      (e): e is DiagnosticEffect => e.kind === "diagnostic",
    );
    expect(diagnostics.length).toBeGreaterThanOrEqual(1);
    expect(diagnostics[0]).toEqual(
      expect.objectContaining({
        severity: "info",
        code: "dome.agent.generated-block-anomaly",
      }),
    );
  });

  test("absent core.md → zero effects (the page is owner-scaffolded, never recreated)", async () => {
    expect(await run({ files: { ...TWO_DAILIES } })).toEqual([]);
  });

  test("missing ## Active projects heading → block appended at the end", async () => {
    const headingless = "# Core memory\n\nJust prose.\n";
    const effects = await run({
      files: { ...TWO_DAILIES, "core.md": headingless },
    });
    const patch = effects.find((e): e is PatchEffect => e.kind === "patch");
    const change = patch?.changes[0];
    if (change?.kind !== "write") throw new Error("expected write change");
    expect(change.content).toBe(
      `# Core memory\n\nJust prose.\n\n${EXPECTED_BLOCK}\n`,
    );
  });

  test("caps at five projects", async () => {
    const lines = Array.from(
      { length: 7 },
      (_, i) => `- [ ] loop ${i} (from [[wiki/entities/p${i}]])`,
    );
    const effects = await run({
      files: {
        "wiki/dailies/2026-06-10.md": daily(lines),
        "core.md": CORE_WITH_BOTH_BLOCKS,
      },
    });
    const patch = effects.find((e): e is PatchEffect => e.kind === "patch");
    expect(patch?.reason).toBe(
      "dome.agent: refresh active-projects block (5 projects)",
    );
    const change = patch?.changes[0];
    if (change?.kind !== "write") throw new Error("expected write change");
    const blockLines = change.content
      .split("\n")
      .filter((line) => line.startsWith("- [[wiki/entities/p"));
    expect(blockLines).toHaveLength(5);
  });
});
