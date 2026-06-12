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

  // log.md is frozen and index.md is generated from description: frontmatter
  // (read grant only — the core-memory.ts grant shape). The broker verdict is
  // per-PatchEffect (all-or-nothing), so a stray write must die at the tool,
  // not poison the whole batched patch.
  test("writePage rejects log.md and index.md without recording an edit", async () => {
    const tools = makeIngestTools({ reader: reader({}) });
    const state = freshState();
    for (const path of ["log.md", "index.md"]) {
      const out = await tool(tools, "writePage").execute(
        { path, content: "x" },
        state,
      );
      expect(out).toStartWith("error:");
      expect(out).toContain(path);
    }
    expect(state.edits.size).toBe(0);
  });

  test("appendToPage rejects log.md and index.md without recording an edit", async () => {
    const tools = makeIngestTools({
      reader: reader({ "log.md": "history", "index.md": "catalog" }),
    });
    const state = freshState();
    for (const path of ["log.md", "index.md"]) {
      const out = await tool(tools, "appendToPage").execute(
        { path, content: "x" },
        state,
      );
      expect(out).toStartWith("error:");
      expect(out).toContain(path);
    }
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

  // Same tool-time fence as ingest: index.md/log.md are read-only for the
  // consolidator (the index regenerates itself; log.md is frozen history),
  // and the all-or-nothing PatchEffect verdict means the denial must land
  // at the tool, where the model can self-correct.
  test("writePage rejects log.md and index.md without recording an edit", async () => {
    const tools = makeConsolidatorTools({
      reader: reader({}),
      ledgerPath: "consolidation-ledger.md",
    });
    const state = freshState();
    for (const path of ["log.md", "index.md"]) {
      const out = await tool(tools, "writePage").execute(
        { path, content: "x" },
        state,
      );
      expect(out).toStartWith("error:");
      expect(out).toContain(path);
    }
    expect(state.edits.size).toBe(0);
  });

  test("deletePage rejects log.md and index.md without recording an edit", async () => {
    const tools = makeConsolidatorTools({
      reader: reader({ "log.md": "history", "index.md": "catalog" }),
      ledgerPath: "consolidation-ledger.md",
    });
    const state = freshState();
    for (const path of ["log.md", "index.md"]) {
      const out = await tool(tools, "deletePage").execute({ path }, state);
      expect(out).toStartWith("error:");
      expect(out).toContain(path);
    }
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

  // Mirrors the ingest/consolidate signals guard: a malformed signals write
  // must die AT THE TOOL (self-correctable mid-loop), not rely on the brief
  // processor's post-run splice guard silently dropping it.
  describe("signals-page append-only guard", () => {
    const EXISTING = [
      "- 2026-06-01 + filing:: notes go under notes/",
      "- 2026-06-02 - filing:: rejected by owner",
    ].join("\n");

    test("writePage rejects a rewrite that drops the owner tombstone", async () => {
      const tools = makeBriefTools({
        reader: reader({ "preferences/signals.md": EXISTING }),
      });
      const state = freshState();
      const out = await tool(tools, "writePage").execute(
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
      const tools = makeBriefTools({
        reader: reader({ "preferences/signals.md": EXISTING }),
      });
      const state = freshState();
      const out = await tool(tools, "appendToPage").execute(
        { path: "preferences/signals.md", content: "the owner prefers tidy notes" },
        state,
      );
      expect(out).toContain("append-only");
      expect(state.edits.has("preferences/signals.md")).toBe(false);
    });

    test("appendToPage accepts a well-formed signal line", async () => {
      const tools = makeBriefTools({
        reader: reader({ "preferences/signals.md": EXISTING }),
      });
      const state = freshState();
      const out = await tool(tools, "appendToPage").execute(
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
