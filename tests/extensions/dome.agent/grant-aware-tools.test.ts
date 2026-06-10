// Grant-aware write tools: the agent's write-capable tools reject paths
// outside the bundle's manifest patch.auto grant AT TOOL TIME, so the model
// gets immediate, correctable feedback instead of a post-hoc broker
// downgrade of the whole batched PatchEffect (capability-downgrade-surprise).
//
// The writable-glob constants are bundle-local mirrors of manifest.yaml;
// the "constants mirror the manifest" suite pins them against drift.

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import type { AgentRunState } from "../../../assets/extensions/dome.agent/lib/agent-loop";
import {
  INGEST_WRITABLE_PATHS,
  makeIngestTools,
} from "../../../assets/extensions/dome.agent/lib/ingest-tools";
import {
  CONSOLIDATE_WRITABLE_PATHS,
  makeConsolidatorTools,
} from "../../../assets/extensions/dome.agent/lib/consolidate-tools";
import {
  BRIEF_WRITABLE_PATHS,
  makeBriefTools,
} from "../../../assets/extensions/dome.agent/lib/brief-tools";
import { SWEEP_WRITABLE_PATHS } from "../../../assets/extensions/dome.agent/lib/sweep-tools";

function freshState(): AgentRunState {
  return { edits: new Map(), questions: [] };
}

const reader = (files: Record<string, string>) => ({
  readFile: async (p: string) => files[p] ?? null,
  listMarkdownFiles: async () => Object.keys(files),
});

function tool(tools: ReadonlyArray<{ schema: { name: string } }>, name: string) {
  const found = tools.find((t) => t.schema.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found as {
    schema: { name: string };
    execute: (input: unknown, state: AgentRunState) => Promise<string>;
  };
}

describe("ingest tools enforce the patch.auto grant at tool time", () => {
  test("writePage rejects an out-of-grant path without recording an edit", async () => {
    const tools = makeIngestTools({ reader: reader({}) });
    const state = freshState();
    const out = await tool(tools, "writePage").execute(
      { path: ".dome/config.yaml", content: "x" },
      state,
    );
    expect(out).toStartWith("error:");
    expect(out).toContain(".dome/config.yaml");
    expect(state.edits.size).toBe(0);
  });

  test("writePage still accepts an in-grant path", async () => {
    const tools = makeIngestTools({ reader: reader({}) });
    const state = freshState();
    const out = await tool(tools, "writePage").execute(
      { path: "wiki/concepts/a.md", content: "x" },
      state,
    );
    expect(out).toBe("wrote wiki/concepts/a.md");
    expect(state.edits.get("wiki/concepts/a.md")?.kind).toBe("write");
  });

  test("appendToPage rejects an out-of-grant path", async () => {
    const tools = makeIngestTools({ reader: reader({}) });
    const state = freshState();
    const out = await tool(tools, "appendToPage").execute(
      { path: "sources/calendar/2026-06-09.md", content: "x" },
      state,
    );
    expect(out).toStartWith("error:");
    expect(state.edits.size).toBe(0);
  });

  test("archiveSource rejects a path outside inbox/raw/", async () => {
    const tools = makeIngestTools({ reader: reader({ "wiki/a.md": "body" }) });
    const state = freshState();
    const out = await tool(tools, "archiveSource").execute(
      { rawPath: "wiki/a.md" },
      state,
    );
    expect(out).toStartWith("error:");
    expect(state.edits.size).toBe(0);
  });
});

describe("consolidator tools enforce the patch.auto grant at tool time", () => {
  test("writePage rejects notes/ (outside the consolidate grant)", async () => {
    const tools = makeConsolidatorTools({
      reader: reader({}),
      ledgerPath: "consolidation-ledger.md",
    });
    const state = freshState();
    const out = await tool(tools, "writePage").execute(
      { path: "notes/2026-06-09.md", content: "x" },
      state,
    );
    expect(out).toStartWith("error:");
    expect(state.edits.size).toBe(0);
  });

  test("deletePage rejects an out-of-grant path", async () => {
    const tools = makeConsolidatorTools({
      reader: reader({}),
      ledgerPath: "consolidation-ledger.md",
    });
    const state = freshState();
    const out = await tool(tools, "deletePage").execute(
      { path: "inbox/raw/x.md" },
      state,
    );
    expect(out).toStartWith("error:");
    expect(state.edits.size).toBe(0);
  });

  test("a custom ledger path is writable when threaded into the factory", async () => {
    const tools = makeConsolidatorTools({
      reader: reader({}),
      ledgerPath: "meta/ledger.md",
    });
    const state = freshState();
    const out = await tool(tools, "writePage").execute(
      { path: "meta/ledger.md", content: "ran tonight" },
      state,
    );
    expect(out).toBe("wrote meta/ledger.md");
  });
});

describe("brief tools enforce the patch.auto grant at tool time", () => {
  test("writePage rejects a wiki concept page (brief writes only the daily note)", async () => {
    const tools = makeBriefTools({ reader: reader({}) });
    const state = freshState();
    const out = await tool(tools, "writePage").execute(
      { path: "wiki/concepts/a.md", content: "x" },
      state,
    );
    expect(out).toStartWith("error:");
    expect(state.edits.size).toBe(0);
  });

  test("writePage accepts the daily note paths", async () => {
    const tools = makeBriefTools({ reader: reader({}) });
    const state = freshState();
    await tool(tools, "writePage").execute(
      { path: "wiki/dailies/2026-06-09.md", content: "x" },
      state,
    );
    await tool(tools, "writePage").execute(
      { path: "notes/2026-06-09.md", content: "x" },
      state,
    );
    expect(state.edits.size).toBe(2);
  });
});

describe("writable-glob constants mirror manifest.yaml patch.auto grants", () => {
  async function manifestPatchAutoPaths(processorId: string): Promise<ReadonlyArray<string>> {
    const raw = await readFile(
      join(
        import.meta.dir,
        "../../../assets/extensions/dome.agent/manifest.yaml",
      ),
      "utf8",
    );
    const manifest = parseYaml(raw) as {
      processors: ReadonlyArray<{
        id: string;
        capabilities: ReadonlyArray<{ kind: string; paths?: ReadonlyArray<string> }>;
      }>;
    };
    const processor = manifest.processors.find((p) => p.id === processorId);
    if (processor === undefined) throw new Error(`no processor ${processorId}`);
    const cap = processor.capabilities.find((c) => c.kind === "patch.auto");
    if (cap?.paths === undefined) throw new Error(`no patch.auto on ${processorId}`);
    return cap.paths;
  }

  test("ingest", async () => {
    expect([...INGEST_WRITABLE_PATHS].sort()).toEqual(
      [...(await manifestPatchAutoPaths("dome.agent.ingest"))].sort(),
    );
  });

  test("consolidate", async () => {
    expect([...CONSOLIDATE_WRITABLE_PATHS].sort()).toEqual(
      [...(await manifestPatchAutoPaths("dome.agent.consolidate"))].sort(),
    );
  });

  test("brief", async () => {
    expect([...BRIEF_WRITABLE_PATHS].sort()).toEqual(
      [...(await manifestPatchAutoPaths("dome.agent.brief"))].sort(),
    );
  });

  test("sweep", async () => {
    expect([...SWEEP_WRITABLE_PATHS].sort()).toEqual(
      [...(await manifestPatchAutoPaths("dome.agent.sweep"))].sort(),
    );
  });
});
