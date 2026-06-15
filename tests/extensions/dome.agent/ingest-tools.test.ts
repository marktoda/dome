import { describe, expect, test } from "bun:test";
import {
  appendCapturedTaskLines,
  CAPTURED_APPEND_MAX_LINES,
  CAPTURED_LINE_MAX_CHARS,
} from "../../../assets/extensions/dome.daily/processors/captured-block";
import { dailyPath, dailyPathSettings, localDateParts } from "../../../assets/extensions/dome.daily/processors/daily-paths";
import { renderDailySkeleton } from "../../../assets/extensions/dome.daily/processors/daily-scaffold";
import { CAPTURED_END, CAPTURED_START } from "../../../assets/extensions/dome.daily/processors/daily-types";
import { makeIngestTools } from "../../../assets/extensions/dome.agent/lib/ingest-tools";
import type { AgentRunState } from "../../../assets/extensions/dome.agent/lib/agent-loop";
import { archivedCapturePath } from "../../../assets/extensions/dome.agent/lib/vault-tools";

function freshState(): AgentRunState {
  return { edits: new Map(), questions: [] };
}

const reader = (files: Record<string, string>) => ({
  readFile: async (p: string) => files[p] ?? null,
  listMarkdownFiles: async () => Object.keys(files),
});

function tool(
  tools: ReturnType<typeof makeIngestTools>,
  name: string,
): {
  execute: (input: unknown, state: AgentRunState) => Promise<string>;
} {
  const found = tools.find((t) => t.schema.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found;
}

describe("ingest tools", () => {
  test("writePage accumulates a write edit", async () => {
    const tools = makeIngestTools({ reader: reader({}) });
    const t = tools.find((x) => x.schema.name === "writePage")!;
    const state = freshState();
    await t.execute({ path: "wiki/sources/a.md", content: "hi" }, state);
    expect(state.edits.get("wiki/sources/a.md")).toEqual({
      kind: "write", path: "wiki/sources/a.md", content: "hi",
    });
  });

  test("appendToPage appends to current snapshot content", async () => {
    const tools = makeIngestTools({
      reader: reader({ "wiki/concepts/a.md": "line1" }),
    });
    const t = tools.find((x) => x.schema.name === "appendToPage")!;
    const state = freshState();
    await t.execute({ path: "wiki/concepts/a.md", content: "line2" }, state);
    const edit = state.edits.get("wiki/concepts/a.md");
    expect(edit?.kind === "write" && edit.content).toBe("line1\nline2");
  });

  test("archiveSource deletes the raw path and writes a processed copy", async () => {
    const tools = makeIngestTools({ reader: reader({ "inbox/raw/x.md": "body" }) });
    const t = tools.find((x) => x.schema.name === "archiveSource")!;
    const state = freshState();
    await t.execute({ rawPath: "inbox/raw/x.md" }, state);
    expect(state.edits.get("inbox/raw/x.md")).toEqual({
      kind: "delete", path: "inbox/raw/x.md",
    });
    const processed = state.edits.get("inbox/processed/x.md");
    expect(processed?.kind).toBe("write");
  });

  test("listPages and searchVault overlay pages written earlier in the same run", async () => {
    const tools = makeIngestTools({ reader: reader({ "wiki/existing.md": "old" }) });
    const state = freshState();
    // an earlier source wrote a new page into the shared accumulator
    state.edits.set("wiki/new.md", {
      kind: "write",
      path: "wiki/new.md",
      content: "fresh notes about pandas",
    });
    const list = await tools.find((x) => x.schema.name === "listPages")!.execute({}, state);
    expect(list).toContain("wiki/new.md");
    const search = await tools
      .find((x) => x.schema.name === "searchVault")!
      .execute({ query: "pandas" }, state);
    expect(search).toContain("wiki/new.md");
  });

  test("readPage truncates a very large page to bound context", async () => {
    const huge = "y".repeat(50_000);
    const tools = makeIngestTools({ reader: reader({ "wiki/big.md": huge }) });
    const t = tools.find((x) => x.schema.name === "readPage")!;
    const out = await t.execute({ path: "wiki/big.md" }, freshState());
    expect(out.length).toBeLessThan(huge.length);
    expect(out).toContain("[truncated");
  });

  test("askOwner records a question", async () => {
    const tools = makeIngestTools({ reader: reader({}) });
    const t = tools.find((x) => x.schema.name === "askOwner")!;
    const state = freshState();
    await t.execute({ question: "is X true?" }, state);
    expect(state.questions[0]?.question).toBe("is X true?");
  });
});

describe("ingest signals-page append-only guard", () => {
  const EXISTING = [
    "- 2026-06-01 + filing:: notes go under notes/",
    "- 2026-06-02 - filing:: rejected by owner",
  ].join("\n");

  test("appendToPage accepts a well-formed signal line", async () => {
    const tools = makeIngestTools({
      reader: reader({ "preferences/signals.md": EXISTING }),
    });
    const t = tools.find((x) => x.schema.name === "appendToPage")!;
    const state = freshState();
    const out = await t.execute(
      {
        path: "preferences/signals.md",
        content: "- 2026-06-09 + naming:: kebab-case slugs",
      },
      state,
    );
    expect(out).toBe("appended to preferences/signals.md");
    const edit = state.edits.get("preferences/signals.md");
    expect(edit?.kind === "write" && edit.content).toBe(
      `${EXISTING}\n- 2026-06-09 + naming:: kebab-case slugs`,
    );
  });

  test("writePage rejects a rewrite that drops the owner tombstone", async () => {
    const tools = makeIngestTools({
      reader: reader({ "preferences/signals.md": EXISTING }),
    });
    const t = tools.find((x) => x.schema.name === "writePage")!;
    const state = freshState();
    const out = await t.execute(
      {
        path: "preferences/signals.md",
        content: "- 2026-06-01 + filing:: notes go under notes/",
      },
      state,
    );
    expect(out).toContain("append-only");
    expect(state.edits.has("preferences/signals.md")).toBe(false);
  });

  test("appendToPage rejects malformed signal lines and prose", async () => {
    const tools = makeIngestTools({
      reader: reader({ "preferences/signals.md": EXISTING }),
    });
    const t = tools.find((x) => x.schema.name === "appendToPage")!;
    const state = freshState();
    const out = await t.execute(
      { path: "preferences/signals.md", content: "the owner prefers tidy notes" },
      state,
    );
    expect(out).toContain("append-only");
    expect(state.edits.has("preferences/signals.md")).toBe(false);
  });

  test("writePage creating the page accepts only signal lines", async () => {
    const tools = makeIngestTools({ reader: reader({}) });
    const t = tools.find((x) => x.schema.name === "writePage")!;
    const state = freshState();
    const ok = await t.execute(
      {
        path: "preferences/signals.md",
        content: "- 2026-06-09 + filing:: notes go under notes/\n",
      },
      state,
    );
    expect(ok).toBe("wrote preferences/signals.md");
    const bad = await t.execute(
      { path: "preferences/signals.md", content: "# Preference signals\nprose" },
      state,
    );
    expect(bad).toContain("append-only");
  });

  test("the guard composes with in-run appends (overlay-aware)", async () => {
    const tools = makeIngestTools({
      reader: reader({ "preferences/signals.md": EXISTING }),
    });
    const t = tools.find((x) => x.schema.name === "appendToPage")!;
    const state = freshState();
    await t.execute(
      { path: "preferences/signals.md", content: "- 2026-06-09 + a:: one" },
      state,
    );
    const out = await t.execute(
      { path: "preferences/signals.md", content: "- 2026-06-09 + b:: two" },
      state,
    );
    expect(out).toBe("appended to preferences/signals.md");
    const edit = state.edits.get("preferences/signals.md");
    expect(edit?.kind === "write" && edit.content).toBe(
      `${EXISTING}\n- 2026-06-09 + a:: one\n- 2026-06-09 + b:: two`,
    );
  });
});

describe("ingest captured-tasks daily seam", () => {
  // The captured-tasks routing the processor derives from one clock read
  // (see ingest.ts). Spec: wiki/specs/daily-surface §"The ingest tool seam".
  const TODAY = { yyyy: "2026", mm: "06", dd: "05" } as const;
  const SETTINGS = dailyPathSettings(undefined);
  const TODAY_PATH = dailyPath(TODAY, SETTINGS);
  const YESTERDAY_PATH = dailyPath(
    { yyyy: "2026", mm: "06", dd: "04" },
    SETTINGS,
  );
  const capturedTasks = { path: TODAY_PATH, today: TODAY, settings: SETTINGS };
  const SKELETON = renderDailySkeleton({
    today: TODAY,
    yesterday: { yyyy: "2026", mm: "06", dd: "04" },
  });

  function capturedTools(files: Record<string, string>) {
    return makeIngestTools({ reader: reader(files), capturedTasks });
  }

  test("a valid task append lands inside the dome.daily:captured block", async () => {
    const tools = capturedTools({ [TODAY_PATH]: SKELETON });
    const state = freshState();
    const out = await tool(tools, "appendToPage").execute(
      { path: TODAY_PATH, content: "- [ ] #task call the landlord" },
      state,
    );
    expect(out).toContain("## Captured today");
    const edit = state.edits.get(TODAY_PATH);
    expect(edit?.kind).toBe("write");
    const content = edit?.kind === "write" ? edit.content : "";
    const start = content.indexOf(CAPTURED_START);
    const end = content.indexOf(CAPTURED_END);
    const task = content.indexOf("- [ ] #task call the landlord");
    expect(task).toBeGreaterThan(start);
    expect(task).toBeLessThan(end);
  });

  test("a non-task append to today's daily is rejected with guidance", async () => {
    const tools = capturedTools({ [TODAY_PATH]: SKELETON });
    const state = freshState();
    const out = await tool(tools, "appendToPage").execute(
      { path: TODAY_PATH, content: "# Captured today\nsome prose notes" },
      state,
    );
    expect(out).toStartWith("error:");
    expect(out).toContain("Captured today");
    expect(state.edits.size).toBe(0);
  });

  test("a copy-shaped or marker-bearing line is rejected", async () => {
    const tools = capturedTools({ [TODAY_PATH]: SKELETON });
    const state = freshState();
    const copy = await tool(tools, "appendToPage").execute(
      {
        path: TODAY_PATH,
        content: "- [ ] #task chase it (from [[wiki/projects/x]])",
      },
      state,
    );
    expect(copy).toStartWith("error:");
    const smuggle = await tool(tools, "appendToPage").execute(
      {
        path: TODAY_PATH,
        content: "- [ ] #task x <!-- dome.daily:captured:end -->",
      },
      state,
    );
    expect(smuggle).toStartWith("error:");
    expect(state.edits.size).toBe(0);
  });

  test("an over-cap line is rejected with the char-cap error; an at-cap line lands", async () => {
    const prefix = "- [ ] #task ";
    const atCap = prefix + "x".repeat(CAPTURED_LINE_MAX_CHARS - prefix.length);
    const tools = capturedTools({ [TODAY_PATH]: SKELETON });
    const state = freshState();
    const rejected = await tool(tools, "appendToPage").execute(
      { path: TODAY_PATH, content: `${atCap}x` },
      state,
    );
    expect(rejected).toStartWith("error:");
    expect(rejected).toContain(`${CAPTURED_LINE_MAX_CHARS} chars`);
    expect(state.edits.size).toBe(0);
    const accepted = await tool(tools, "appendToPage").execute(
      { path: TODAY_PATH, content: atCap },
      state,
    );
    expect(accepted).not.toStartWith("error:");
    expect(state.edits.size).toBe(1);
  });

  test("an over-cap append is rejected with the line-count error; an at-cap append lands", async () => {
    const lines = (n: number) =>
      Array.from({ length: n }, (_, i) => `- [ ] #task item ${i}`);
    const tools = capturedTools({ [TODAY_PATH]: SKELETON });
    const state = freshState();
    const rejected = await tool(tools, "appendToPage").execute(
      {
        path: TODAY_PATH,
        content: lines(CAPTURED_APPEND_MAX_LINES + 1).join("\n"),
      },
      state,
    );
    expect(rejected).toStartWith("error:");
    expect(rejected).toContain(`${CAPTURED_APPEND_MAX_LINES} task lines`);
    expect(state.edits.size).toBe(0);
    const accepted = await tool(tools, "appendToPage").execute(
      {
        path: TODAY_PATH,
        content: lines(CAPTURED_APPEND_MAX_LINES).join("\n"),
      },
      state,
    );
    expect(accepted).not.toStartWith("error:");
    expect(state.edits.size).toBe(1);
  });

  test("a line smuggling U+2028/U+2029 is rejected (phantom heading anchor)", async () => {
    const tools = capturedTools({ [TODAY_PATH]: SKELETON });
    const state = freshState();
    const out = await tool(tools, "appendToPage").execute(
      { path: TODAY_PATH, content: "- [ ] #task sneak\u2028## Done\u2028x" },
      state,
    );
    expect(out).toStartWith("error:");
    expect(state.edits.size).toBe(0);
  });

  test("an append when today's daily is absent creates the full shared skeleton", async () => {
    const tools = capturedTools({ [YESTERDAY_PATH]: "# yesterday\n" });
    const state = freshState();
    const out = await tool(tools, "appendToPage").execute(
      { path: TODAY_PATH, content: "- [ ] #task call the landlord" },
      state,
    );
    expect(out).toContain("appended 1 task line");
    const edit = state.edits.get(TODAY_PATH);
    const content = edit?.kind === "write" ? edit.content : "";
    // The full skeleton (one skeleton shape — create-daily/brief later
    // no-op), yesterday link included, task inside the block.
    expect(content).toContain("## Start Here");
    expect(content).toContain("## Story of the Day");
    expect(content).toContain('prev: "[[wiki/dailies/2026-06-04]]"');
    expect(content.indexOf("- [ ] #task call the landlord")).toBeGreaterThan(
      content.indexOf(CAPTURED_START),
    );
    expect(content.indexOf("- [ ] #task call the landlord")).toBeLessThan(
      content.indexOf(CAPTURED_END),
    );
  });

  test("appends to other paths fall through to the plain append tool", async () => {
    const tools = capturedTools({
      "wiki/entities/ada.md": "# Ada\n\n## Open threads\n",
    });
    const state = freshState();
    const out = await tool(tools, "appendToPage").execute(
      {
        path: "wiki/entities/ada.md",
        content: "- [ ] #task follow up with Ada",
      },
      state,
    );
    expect(out).toBe("appended to wiki/entities/ada.md");
  });

  test("writePage admits only an in-block task-line append of today's daily", async () => {
    const tools = capturedTools({ [TODAY_PATH]: SKELETON });
    const state = freshState();
    const valid = appendCapturedTaskLines({
      content: SKELETON,
      lines: ["- [ ] #task call the landlord"],
    });
    const ok = await tool(tools, "writePage").execute(
      { path: TODAY_PATH, content: valid },
      state,
    );
    expect(ok).toBe(`wrote ${TODAY_PATH}`);
    const rewrite = await tool(tools, "writePage").execute(
      { path: TODAY_PATH, content: "# rewritten daily\n" },
      state,
    );
    expect(rewrite).toStartWith("error:");
    expect(rewrite).toContain("appendToPage");
  });

  test("writePage rejects an outside-block edit even with the block intact", async () => {
    const tools = capturedTools({ [TODAY_PATH]: SKELETON });
    const state = freshState();
    const out = await tool(tools, "writePage").execute(
      { path: TODAY_PATH, content: `${SKELETON}\nstray prose at the end\n` },
      state,
    );
    expect(out).toStartWith("error:");
    expect(state.edits.size).toBe(0);
  });

  test("writePage byte-identical rewrite of today's daily is a harmless no-op", async () => {
    const tools = capturedTools({ [TODAY_PATH]: SKELETON });
    const state = freshState();
    const out = await tool(tools, "writePage").execute(
      { path: TODAY_PATH, content: SKELETON },
      state,
    );
    expect(out).toBe(`wrote ${TODAY_PATH}`);
  });

  test("the seam composes with in-run appends (overlay-aware)", async () => {
    const tools = capturedTools({ [TODAY_PATH]: SKELETON });
    const state = freshState();
    await tool(tools, "appendToPage").execute(
      { path: TODAY_PATH, content: "- [ ] #task first" },
      state,
    );
    await tool(tools, "appendToPage").execute(
      { path: TODAY_PATH, content: "- [ ] #task second" },
      state,
    );
    const edit = state.edits.get(TODAY_PATH);
    const content = edit?.kind === "write" ? edit.content : "";
    const first = content.indexOf("- [ ] #task first");
    const second = content.indexOf("- [ ] #task second");
    expect(first).toBeGreaterThan(content.indexOf(CAPTURED_START));
    expect(second).toBeGreaterThan(first);
    expect(second).toBeLessThan(content.indexOf(CAPTURED_END));
  });

  test("without capturedTasks routing the plain append tool is used (legacy shape)", async () => {
    const tools = makeIngestTools({ reader: reader({}) });
    const state = freshState();
    const out = await tool(tools, "appendToPage").execute(
      { path: TODAY_PATH, content: "anything goes" },
      state,
    );
    expect(out).toBe(`appended to ${TODAY_PATH}`);
  });
});

describe("archivedCapturePath", () => {
  test("rewrites inbox/raw to inbox/processed, preserving the basename", () => {
    expect(archivedCapturePath("inbox/raw/2026-06-14-jane.md")).toBe(
      "inbox/processed/2026-06-14-jane.md",
    );
  });

  test("returns null for paths outside inbox/raw", () => {
    expect(archivedCapturePath("wiki/concepts/a.md")).toBeNull();
    expect(archivedCapturePath("inbox/processed/x.md")).toBeNull();
  });
});

describe("captured seam origin marker", () => {
  const settings = dailyPathSettings(undefined);
  const today = localDateParts(new Date("2026-06-14T15:00:00.000Z"));
  const dailyP = dailyPath(today, settings);

  test("stamps the origin marker onto each spliced task line", async () => {
    const tools = makeIngestTools({
      reader: reader({}),
      capturedTasks: {
        path: dailyP,
        today,
        settings,
        origin: "inbox/processed/2026-06-14-jane.md",
      },
    });
    const t = tool(tools, "appendToPage");
    const state = freshState();
    await t.execute(
      { path: dailyP, content: "- [ ] #task reply to Jane" },
      state,
    );
    const edit = state.edits.get(dailyP);
    expect(edit?.kind === "write" && edit.content).toContain(
      "- [ ] #task reply to Jane ([↗](inbox/processed/2026-06-14-jane.md))",
    );
  });

  test("no marker when origin is null", async () => {
    const tools = makeIngestTools({
      reader: reader({}),
      capturedTasks: { path: dailyP, today, settings, origin: null },
    });
    const t = tool(tools, "appendToPage");
    const state = freshState();
    await t.execute({ path: dailyP, content: "- [ ] #task plain" }, state);
    const edit = state.edits.get(dailyP);
    expect(edit?.kind === "write" && edit.content).toContain("- [ ] #task plain");
    expect(edit?.kind === "write" && edit.content).not.toContain("↗");
  });

  test("no marker when origin is absent (undefined)", async () => {
    const tools = makeIngestTools({
      reader: reader({}),
      capturedTasks: { path: dailyP, today, settings }, // origin omitted
    });
    const t = tool(tools, "appendToPage");
    const state = freshState();
    await t.execute({ path: dailyP, content: "- [ ] #task plain" }, state);
    const edit = state.edits.get(dailyP);
    expect(edit?.kind === "write" && edit.content).toContain("- [ ] #task plain");
    expect(edit?.kind === "write" && edit.content).not.toContain("↗");
  });
});
