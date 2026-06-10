// Tests for sweep-tools (per-item tool set) and sweep-charter.
// Pattern mirrors grant-aware-tools.test.ts.

import { describe, expect, test } from "bun:test";

import type { AgentRunState } from "../../../assets/extensions/dome.agent/lib/agent-loop";
import {
  makeSweepTools,
  SWEEP_WRITABLE_PATHS,
} from "../../../assets/extensions/dome.agent/lib/sweep-tools";
import { sweepCharter } from "../../../assets/extensions/dome.agent/lib/sweep-charter";

function freshState(): AgentRunState {
  return { edits: new Map(), questions: [] };
}

const reader = (files: Record<string, string>) => ({
  readFile: async (p: string) => files[p] ?? null,
  listMarkdownFiles: async () => Object.keys(files),
});

function tool(
  tools: ReadonlyArray<{ schema: { name: string } }>,
  name: string,
) {
  const found = tools.find((t) => t.schema.name === name);
  if (found === undefined) throw new Error(`no tool named ${name}`);
  return found as {
    schema: { name: string };
    execute: (input: unknown, state: AgentRunState) => Promise<string>;
  };
}

const DEST = "wiki/entities/alice-henshaw.md";
const MATERIAL = "wiki/dailies/2026-06-09.md";

function makeTools(onQuestion = (_q: { summary: string; proposedSection: string }) => {}) {
  return makeSweepTools({
    reader: reader({ [DEST]: "# Alice Henshaw\n", [MATERIAL]: "body" }),
    destination: DEST,
    onQuestion,
  });
}

// ---------------------------------------------------------------------------
// editDestination
// ---------------------------------------------------------------------------

describe("editDestination", () => {
  test("rejects a non-destination path without recording an edit", async () => {
    const tools = makeTools();
    const state = freshState();
    const out = await tool(tools, "editDestination").execute(
      { path: "core.md", content: "pwned" },
      state,
    );
    expect(out).toStartWith("error:");
    expect(out).toContain("core.md");
    expect(state.edits.size).toBe(0);
  });

  test("rejects another wiki entity (not the destination)", async () => {
    const tools = makeTools();
    const state = freshState();
    const out = await tool(tools, "editDestination").execute(
      { path: "wiki/entities/other.md", content: "x" },
      state,
    );
    expect(out).toStartWith("error:");
    expect(state.edits.size).toBe(0);
  });

  test("accepts the destination and records the edit", async () => {
    const tools = makeTools();
    const state = freshState();
    const content = "# Alice Henshaw\n\n## 2026-06-09 — met today\n";
    const out = await tool(tools, "editDestination").execute(
      { path: DEST, content },
      state,
    );
    expect(out).toContain(DEST);
    expect(state.edits.get(DEST)?.kind).toBe("write");
    expect((state.edits.get(DEST) as { content: string }).content).toBe(content);
  });

  test("second edit to destination overwrites the first", async () => {
    const tools = makeTools();
    const state = freshState();
    await tool(tools, "editDestination").execute({ path: DEST, content: "v1" }, state);
    await tool(tools, "editDestination").execute({ path: DEST, content: "v2" }, state);
    expect((state.edits.get(DEST) as { content: string }).content).toBe("v2");
  });
});

// ---------------------------------------------------------------------------
// recordUncertainIntegration
// ---------------------------------------------------------------------------

describe("recordUncertainIntegration", () => {
  test("invokes the onQuestion callback with both fields", async () => {
    let captured: { summary: string; proposedSection: string } | null = null;
    const tools = makeSweepTools({
      reader: reader({}),
      destination: DEST,
      onQuestion: (q) => { captured = q; },
    });
    const state = freshState();
    const out = await tool(tools, "recordUncertainIntegration").execute(
      { summary: "uncertain identity", proposedSection: "## 2026-06-09 — maybe" },
      state,
    );
    expect(captured).not.toBeNull();
    expect(captured!.summary).toBe("uncertain identity");
    expect(captured!.proposedSection).toBe("## 2026-06-09 — maybe");
    expect(out).toContain("recorded");
    expect(out).toContain("owner");
  });

  test("records NO edit to state", async () => {
    const tools = makeSweepTools({
      reader: reader({}),
      destination: DEST,
      onQuestion: () => {},
    });
    const state = freshState();
    await tool(tools, "recordUncertainIntegration").execute(
      { summary: "x", proposedSection: "y" },
      state,
    );
    expect(state.edits.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Read tools are present
// ---------------------------------------------------------------------------

describe("read tools are present", () => {
  test("tool names include readPage, listPages, searchVault", () => {
    const tools = makeTools();
    const names = tools.map((t) => t.schema.name);
    expect(names).toContain("readPage");
    expect(names).toContain("listPages");
    expect(names).toContain("searchVault");
  });

  test("exactly five tools are returned (readPage, listPages, searchVault, editDestination, recordUncertainIntegration)", () => {
    const tools = makeTools();
    // 3 read + editDestination + recordUncertainIntegration = 5
    expect(tools.length).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// SWEEP_WRITABLE_PATHS constant
// ---------------------------------------------------------------------------

describe("SWEEP_WRITABLE_PATHS", () => {
  test("contains the manifest-mirror paths", () => {
    expect(SWEEP_WRITABLE_PATHS).toContain("wiki/entities/**/*.md");
    expect(SWEEP_WRITABLE_PATHS).toContain("wiki/concepts/**/*.md");
    expect(SWEEP_WRITABLE_PATHS).toContain("sweep-ledger.md");
  });

  test("is frozen", () => {
    expect(Object.isFrozen(SWEEP_WRITABLE_PATHS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sweepCharter load-bearing strings
// ---------------------------------------------------------------------------

describe("sweepCharter", () => {
  const charter = sweepCharter({
    destination: "wiki/entities/alice-henshaw.md",
    material: "wiki/dailies/2026-06-09.md",
  });

  test("embeds destination and material paths", () => {
    expect(charter).toContain("wiki/entities/alice-henshaw.md");
    expect(charter).toContain("wiki/dailies/2026-06-09.md");
  });

  test("contains the sources: provenance requirement", () => {
    expect(charter).toContain("sources:");
  });

  test("contains injection-hardening / QUOTED DATA framing", () => {
    // Must contain the phrase used in brief-charter's untrusted-input framing.
    expect(charter.toUpperCase()).toContain("QUOTED DATA");
  });

  test("contains the anchor-preservation rule (never change the ^c anchor)", () => {
    expect(charter).toContain("never change the");
    expect(charter).toContain("^c");
  });

  test("contains the dated narrative section format", () => {
    expect(charter).toContain("YYYY-MM-DD");
  });

  test("contains the settlement finality rule", () => {
    expect(charter).toContain("recordUncertainIntegration");
  });
});
