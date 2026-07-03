import { describe, expect, test } from "bun:test";
import { makeConsolidatorTools } from "../../../assets/extensions/dome.agent/lib/consolidate-tools";
import { agentIntegrityEffects } from "../../../assets/extensions/dome.agent/lib/agent-run-effects";
import type { AgentRunState } from "../../../assets/extensions/dome.agent/lib/agent-loop";
import { commitOid, sourceRef } from "../../../src/core/source-ref";

const reader = (files: Record<string, string> = {}) => ({
  readFile: async (p: string) => files[p] ?? null,
  listMarkdownFiles: async () => Object.keys(files),
});

function freshState(): AgentRunState {
  return { edits: new Map(), questions: [], integrityFlags: [] };
}

describe("makeConsolidatorTools", () => {
  test("provides the consolidator tool set incl. deletePage + flagIntegrity, excl. inbox tools", async () => {
    const names = makeConsolidatorTools({
      reader: reader(),
      ledgerPath: "meta/consolidation-ledger.md",
    })
      .map((t) => t.schema.name)
      .sort();
    expect(names).toEqual([
      "askOwner",
      "deletePage",
      "flagIntegrity",
      "listPages",
      "readPage",
      "searchVault",
      "writePage",
    ]);
  });
});

describe("consolidate flagIntegrity tool → DiagnosticEffect", () => {
  const tools = () =>
    makeConsolidatorTools({
      reader: reader(),
      ledgerPath: "meta/consolidation-ledger.md",
    });

  test("a flagged finding maps to a warning DiagnosticEffect with the kind-namespaced code", async () => {
    const flag = tools().find((t) => t.schema.name === "flagIntegrity")!;
    const state = freshState();
    const out = await flag.execute(
      {
        path: "wiki/entities/danny.md",
        kind: "historical-as-ongoing",
        claim: "Danny is currently leading the migration",
        severity: "warning",
        fix: "Reframe as completed; the migration shipped last quarter.",
      },
      state,
    );
    expect(out).toContain("wiki/entities/danny.md");
    expect(state.integrityFlags).toHaveLength(1);

    // The real tool → effect path: map the accumulated flag through the
    // shared epilogue helper the consolidate processor uses.
    const effects = agentIntegrityEffects(state, (path, stableId) =>
      sourceRef({ commit: commitOid("a".repeat(40)), path, stableId }),
    );
    expect(effects).toHaveLength(1);
    const d = effects[0]!;
    if (d.kind !== "diagnostic") throw new Error("expected a diagnostic");
    expect(d.code).toBe("dome.agent.integrity.historical-as-ongoing");
    expect(d.severity).toBe("warning");
    expect(d.message).toContain("wiki/entities/danny.md");
    expect(d.message).toContain("shipped last quarter"); // folded fix
    // No fact, no patch: integrity findings are transient diagnostics only.
    expect(effects.some((e) => e.kind === "fact")).toBe(false);
    expect(effects.some((e) => e.kind === "patch")).toBe(false);
    // Per-finding stableId so two findings on one page both survive dedup.
    expect(d.sourceRefs[0]?.stableId).toContain("historical-as-ongoing:");
  });

  test("an info-severity finding maps to an info diagnostic", async () => {
    const flag = tools().find((t) => t.schema.name === "flagIntegrity")!;
    const state = freshState();
    await flag.execute(
      {
        path: "wiki/concepts/x.md",
        kind: "self-corroborating",
        claim: "A claim supported only by this vault",
        severity: "info",
        fix: "Cite an external source.",
      },
      state,
    );
    const effects = agentIntegrityEffects(state, (path, stableId) =>
      sourceRef({ commit: commitOid("a".repeat(40)), path, stableId }),
    );
    const d = effects[0]!;
    if (d.kind !== "diagnostic") throw new Error("expected a diagnostic");
    expect(d.code).toBe("dome.agent.integrity.self-corroborating");
    expect(d.severity).toBe("info");
  });
});

describe("consolidate signals-page append-only guard", () => {
  const EXISTING = [
    "- 2026-06-01 + filing:: notes go under notes/",
    "- 2026-06-02 - filing:: rejected by owner",
  ].join("\n");

  function tools(files: Record<string, string> = {}) {
    return makeConsolidatorTools({
      reader: reader(files),
      ledgerPath: "meta/consolidation-ledger.md",
    });
  }

  test("deletePage refuses to delete the signals page (owner tombstones)", async () => {
    const t = tools({ "preferences/signals.md": EXISTING }).find(
      (x) => x.schema.name === "deletePage",
    )!;
    const state = freshState();
    const out = await t.execute({ path: "preferences/signals.md" }, state);
    expect(out).toContain("append-only");
    expect(out).toContain("cannot be deleted");
    expect(state.edits.has("preferences/signals.md")).toBe(false);
  });

  test("writePage rejects a rewrite of the signals page", async () => {
    const t = tools({ "preferences/signals.md": EXISTING }).find(
      (x) => x.schema.name === "writePage",
    )!;
    const state = freshState();
    const out = await t.execute(
      { path: "preferences/signals.md", content: "consolidated away" },
      state,
    );
    expect(out).toContain("append-only");
    expect(state.edits.has("preferences/signals.md")).toBe(false);
  });

  test("writePage accepts an append of well-formed signal lines", async () => {
    const t = tools({ "preferences/signals.md": EXISTING }).find(
      (x) => x.schema.name === "writePage",
    )!;
    const state = freshState();
    const out = await t.execute(
      {
        path: "preferences/signals.md",
        content: `${EXISTING}\n- 2026-06-09 + naming:: kebab-case slugs\n`,
      },
      state,
    );
    expect(out).toBe("wrote preferences/signals.md");
    expect(state.edits.get("preferences/signals.md")?.kind).toBe("write");
  });

  test("other pages stay deletable and rewritable", async () => {
    const set = tools({ "wiki/dup.md": "duplicate" });
    const del = set.find((x) => x.schema.name === "deletePage")!;
    const state = freshState();
    expect(await del.execute({ path: "wiki/dup.md" }, state)).toBe(
      "deleted wiki/dup.md",
    );
  });
});
