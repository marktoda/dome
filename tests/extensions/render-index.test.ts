// dome.markdown.render-index — garden processor tests. The index catalog is a
// RENDER of per-page `description:` frontmatter: same snapshot → same patch,
// matching snapshot → zero effects, human prose outside the generated block
// survives, stale shards are deleted.
import { describe, expect, test } from "bun:test";

import {
  renderIndexFiles,
  type IndexEntry,
} from "../../assets/extensions/dome.markdown/lib/index-render";
import renderIndex from "../../assets/extensions/dome.markdown/processors/render-index";
import type { DiagnosticEffect, PatchEffect } from "../../src/core/effect";
import { treeOid, type ExtensionConfig, type Snapshot } from "../../src/core/processor";
import { commitOid } from "../../src/core/source-ref";
import { makeProcessorContext } from "../../src/processors/context";

const HEAD_COMMIT = commitOid("4444444444444444444444444444444444444444");
const TREE = treeOid("5555555555555555555555555555555555555555");

const START = "<!-- dome.markdown:index-catalog:start -->";
const END = "<!-- dome.markdown:index-catalog:end -->";

describe("dome.markdown.render-index", () => {
  test("renders root map + per-category shards from description frontmatter", async () => {
    const effects = await runRenderIndex({
      "wiki/entities/a.md": "---\ndescription: Engineer\n---\n\n# A\n",
      "wiki/concepts/b.md": "# B\n",
    });

    expect(effects).toHaveLength(1);
    const patch = expectPatch(effects, 0);
    expect(patch.mode).toBe("auto");
    const byPath = changesByPath(patch);
    expect([...byPath.keys()].sort()).toEqual([
      "index.md",
      "meta/index-concepts.md",
      "meta/index-entities.md",
    ]);

    // Contents match the pure renderer byte-for-byte.
    const expected = renderIndexFiles(
      [
        { path: "wiki/concepts/b.md", description: null, category: "concepts" },
        { path: "wiki/entities/a.md", description: "Engineer", category: "entities" },
      ] satisfies IndexEntry[],
      { shardBudgetChars: 24_000 },
    );
    for (const [path, change] of byPath) {
      expect(change.kind).toBe("write");
      if (change.kind !== "write") continue;
      expect(change.content).toBe(expected[path] as string);
    }

    const entities = byPath.get("meta/index-entities.md");
    expect(entities?.kind === "write" && entities.content).toContain(
      "- [[wiki/entities/a]] — Engineer",
    );
    // Missing description still indexes the page, with the muted placeholder.
    const concepts = byPath.get("meta/index-concepts.md");
    expect(concepts?.kind === "write" && concepts.content).toContain(
      "- [[wiki/concepts/b]] — *(no description yet)*",
    );
  });

  test("index: false frontmatter excludes the page entirely", async () => {
    const effects = await runRenderIndex({
      "wiki/entities/a.md": "---\ndescription: Engineer\n---\n\n# A\n",
      "wiki/entities/hidden.md": "---\nindex: false\n---\n\n# Hidden\n",
    });

    const patch = expectPatch(effects, 0);
    const entities = changesByPath(patch).get("meta/index-entities.md");
    expect(entities?.kind === "write" && entities.content).toContain(
      "wiki/entities/a",
    );
    expect(entities?.kind === "write" && entities.content).not.toContain("hidden");
  });

  test("zero effects when no pages fall under the configured categories", async () => {
    const effects = await runRenderIndex({
      "index.md": "# Docs vault\n\nHand-written map — no catalog block here.\n",
      "wiki/specs/processors.md": "# Processors\n",
      "notes/scratch.md": "# Scratch\n",
    });

    expect(effects).toHaveLength(0);
  });

  test("zero effects when the index files already match (diff-before-emit)", async () => {
    const seed: Record<string, string> = {
      "wiki/entities/a.md": "---\ndescription: Engineer\n---\n\n# A\n",
      "wiki/concepts/b.md": "# B\n",
    };
    const first = expectPatch(await runRenderIndex(seed), 0);
    const next = { ...seed };
    for (const [path, change] of changesByPath(first)) {
      if (change.kind === "write") next[path] = change.content;
    }

    const second = await runRenderIndex(next);
    expect(second).toHaveLength(0);
  });

  test("human prose outside the generated block is preserved", async () => {
    const effects = await runRenderIndex({
      "wiki/entities/a.md": "---\ndescription: Engineer\n---\n\n# A\n",
      "meta/index-entities.md": [
        "Hand notes.",
        "",
        START,
        "- [[wiki/entities/old]] — Gone",
        END,
        "",
        "Trailing prose stays too.",
        "",
      ].join("\n"),
    });

    const patch = expectPatch(effects, 0);
    const change = changesByPath(patch).get("meta/index-entities.md");
    expect(change?.kind).toBe("write");
    if (change?.kind !== "write") return;
    expect(change.content.startsWith("Hand notes.")).toBe(true);
    expect(change.content).toContain("Trailing prose stays too.");
    expect(change.content).toContain("- [[wiki/entities/a]] — Engineer");
    expect(change.content).not.toContain("wiki/entities/old");
  });

  test("stale shards: splice the block out around prose, delete only pure renders", async () => {
    const effects = await runRenderIndex({
      "wiki/entities/a.md": "---\ndescription: Engineer\n---\n\n# A\n",
      // A stale shard that is nothing but our block (whitespace aside):
      // entirely our render, so deletion destroys nothing → delete.
      "index-pure.md": `${START}\n- [[wiki/pure/old]] — Gone\n${END}\n`,
      // A stale shard carrying content outside the block (heading + trailing
      // prose): the block is spliced OUT and the prose survives — never
      // deleted wholesale.
      "index-projects.md": `# Index — projects\n\n${START}\n- [[wiki/projects/old]] — Gone\n${END}\n\nHand notes below the block.\n`,
      // A human file matching the shard name pattern but without our block:
      // never touched (it is not ours).
      "index-handmade.md": "# My own index\n\nHands off.\n",
    });

    const patch = expectPatch(effects, 0);
    const byPath = changesByPath(patch);
    expect(byPath.get("index-pure.md")?.kind).toBe("delete");
    const spliced = byPath.get("index-projects.md");
    expect(spliced?.kind).toBe("write");
    if (spliced?.kind === "write") {
      expect(spliced.content).toBe(
        "# Index — projects\n\nHand notes below the block.\n",
      );
    }
    expect(byPath.has("index-handmade.md")).toBe(false);
  });

  test("legacy root shards are retired when the catalog renders under meta/", async () => {
    const effects = await runRenderIndex({
      "wiki/entities/a.md": "---\ndescription: Engineer\n---\n\n# A\n",
      // Pre-meta/ render at the old root location, heading + block (exactly
      // what the old renderer produced via wrapBlock) → deleted, not stubbed.
      "index-entities.md": `# Index — entities\n\n${START}\n- [[wiki/entities/a]] — Engineer\n${END}\n`,
      // Legacy overflow shard with the paginated title form → deleted too.
      "index-entities-2.md": `# Index — entities (2/2)\n\n${START}\n- [[wiki/entities/z]] — Gone\n${END}\n`,
      // Stale shard at the NEW location, entirely ours → deleted too.
      "meta/index-old.md": `${START}\n- [[wiki/old/x]] — Gone\n${END}\n`,
    });

    const patch = expectPatch(effects, 0);
    const byPath = changesByPath(patch);
    expect(byPath.get("index-entities.md")?.kind).toBe("delete");
    expect(byPath.get("index-entities-2.md")?.kind).toBe("delete");
    expect(byPath.get("meta/index-old.md")?.kind).toBe("delete");
    expect(byPath.get("meta/index-entities.md")?.kind).toBe("write");
  });

  test("half-open markers: info diagnostic surfaces, file is left untouched", async () => {
    // The unterminated start marker makes the splice refuse; the refusal must
    // leave a trace (info diagnostic) instead of silently dropping the change.
    const effects = await runRenderIndex({
      "wiki/entities/a.md": "---\ndescription: Engineer\n---\n\n# A\n",
      "index-entities.md": [
        "Hand notes.",
        "",
        START,
        "- [[wiki/entities/old]] — Gone",
        "",
      ].join("\n"),
    });

    const diagnostics = diagnosticsOf(effects);
    expect(diagnostics).toHaveLength(1);
    const diagnostic = diagnostics[0] as DiagnosticEffect;
    expect(diagnostic.severity).toBe("info");
    expect(diagnostic.code).toBe("dome.markdown.generated-block-anomaly");
    expect(diagnostic.message).toContain("unterminated");

    // The rest of the render still lands; only the damaged file is skipped.
    const patch = expectPatch(effects, 1);
    const byPath = changesByPath(patch);
    expect(byPath.has("index-entities.md")).toBe(false);
    expect(byPath.has("index.md")).toBe(true);
  });

  test("empty index_categories map disables rendering", async () => {
    // Mirrors the docs/ dogfood vault: wiki pages exist under the default
    // category prefixes and the curated root index has no generated block.
    // An explicitly empty map is an opt-out, not a malformed config: zero
    // categories → zero effects — no take-over patch, no degrade-to-defaults,
    // no warning diagnostic, and no stale-shard deletion either.
    const effects = await runRenderIndex(
      {
        "index.md": "# Docs vault\n\nCurated by hand — no catalog block.\n",
        "wiki/entities/a.md": "---\ndescription: Engineer\n---\n\n# A\n",
        "wiki/concepts/b.md": "# B\n",
        // Even a leftover generated shard stays untouched while disabled.
        "index-entities.md": `${START}\n- [[wiki/entities/a]] — Engineer\n${END}\n`,
      },
      { index_categories: {} },
    );

    expect(effects).toHaveLength(0);
  });

  test("non-empty index_categories merges over the defaults", async () => {
    // Adding `notes/: notes` does NOT replace the wiki defaults — the merged
    // map indexes both the added prefix and the default categories.
    const merged = await runRenderIndex(
      {
        "notes/idea.md": "---\ndescription: An idea\n---\n\n# Idea\n",
        "wiki/entities/a.md": "---\ndescription: Engineer\n---\n\n# A\n",
      },
      { index_categories: { "notes/": "notes" } },
    );
    const patch = expectPatch(merged, 0);
    expect([...changesByPath(patch).keys()].sort()).toEqual([
      "index.md",
      "meta/index-entities.md",
      "meta/index-notes.md",
    ]);
  });

  test("mapping a prefix to false removes that default from the merge", async () => {
    // entities/ is dropped; concepts/ stays a default; notes/ is added.
    const effects = await runRenderIndex(
      {
        "notes/idea.md": "---\ndescription: An idea\n---\n\n# Idea\n",
        "wiki/entities/a.md": "---\ndescription: Engineer\n---\n\n# A\n",
        "wiki/concepts/b.md": "# B\n",
      },
      { index_categories: { "notes/": "notes", "wiki/entities/": false } },
    );
    const patch = expectPatch(effects, 0);
    expect([...changesByPath(patch).keys()].sort()).toEqual([
      "index.md",
      "meta/index-concepts.md",
      "meta/index-notes.md",
    ]);

    // Removing EVERY default with false entries empties the merged map —
    // the same deliberate opt-out as the explicit-{} switch: zero effects.
    const disabled = await runRenderIndex(
      { "wiki/entities/a.md": "---\ndescription: Engineer\n---\n\n# A\n" },
      {
        index_categories: {
          "wiki/entities/": false,
          "wiki/concepts/": false,
          "wiki/syntheses/": false,
        },
      },
    );
    expect(disabled).toHaveLength(0);
  });

  test("config overrides budget; malformed config degrades to defaults", async () => {
    // Malformed override: defaults win and a warning diagnostic surfaces.
    const degraded = await runRenderIndex(
      { "wiki/entities/a.md": "---\ndescription: Engineer\n---\n\n# A\n" },
      { index_categories: 42, index_shard_budget_chars: "huge" },
    );
    const diagnostics = diagnosticsOf(degraded);
    expect(diagnostics).toHaveLength(2);
    for (const diagnostic of diagnostics) {
      expect(diagnostic.severity).toBe("warning");
      expect(diagnostic.code).toBe("dome.markdown.render-index-config-invalid");
    }
    const degradedPatch = expectPatch(degraded, 2);
    expect([...changesByPath(degradedPatch).keys()].sort()).toEqual([
      "index.md",
      "meta/index-entities.md",
    ]);
  });
});

async function runRenderIndex(
  files: Readonly<Record<string, string>>,
  extensionConfig?: ExtensionConfig,
): Promise<ReadonlyArray<unknown>> {
  const ctx = makeProcessorContext({
    snapshot: fakeSnapshot(files),
    changedPaths: [],
    proposal: null,
    runId: "run-render-index",
    signal: new AbortController().signal,
    input: {
      kind: "schedule",
      cron: "15 5 * * *",
      firedAt: "2026-06-11T09:15:00.000Z",
    },
    ...(extensionConfig === undefined ? {} : { extensionConfig }),
  });

  return renderIndex.run(ctx);
}

function fakeSnapshot(files: Readonly<Record<string, string>>): Snapshot {
  return Object.freeze({
    commit: HEAD_COMMIT,
    tree: TREE,
    readFile: async (path: string) => files[path] ?? null,
    listMarkdownFiles: async () =>
      Object.freeze(Object.keys(files).filter((path) => path.endsWith(".md"))),
    getFileInfo: async (path: string) =>
      files[path] === undefined
        ? null
        : {
            lastChangedCommit: HEAD_COMMIT,
            lastChangedAt: "2026-06-11T09:00:00.000Z",
            lastHumanChangedAt: "2026-06-11T09:00:00.000Z",
          },
  });
}

function expectPatch(
  effects: ReadonlyArray<unknown>,
  index: number,
): PatchEffect {
  const effect = effects[index];
  if (effect === undefined) throw new Error(`expected effect at index ${index}`);
  if (typeof effect !== "object" || effect === null || !("kind" in effect)) {
    throw new Error("effect is not an object with `kind`");
  }
  if ((effect as { readonly kind: string }).kind !== "patch") {
    throw new Error(
      `expected patch effect, got ${(effect as { readonly kind: string }).kind}`,
    );
  }
  return effect as PatchEffect;
}

function changesByPath(
  patch: PatchEffect,
): ReadonlyMap<string, PatchEffect["changes"][number]> {
  return new Map(patch.changes.map((change) => [String(change.path), change]));
}

function diagnosticsOf(
  effects: ReadonlyArray<unknown>,
): ReadonlyArray<DiagnosticEffect> {
  return effects.filter(
    (effect): effect is DiagnosticEffect =>
      typeof effect === "object" &&
      effect !== null &&
      (effect as { readonly kind?: string }).kind === "diagnostic",
  );
}
