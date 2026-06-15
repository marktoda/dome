// dome.claims.render-facts — garden processor tests. A claim-rich page gets a
// deterministic `## Current facts` generated block (owner dome.claims, block
// current-facts) spliced in after frontmatter + first H1; a page that drops
// below the threshold has a stale block spliced OUT. Same snapshot → same
// patch; matching desired state → ZERO effects (idempotent). The rendered
// block uses NO `**Key:**` claim grammar, so it is never re-indexed as claims.
import { describe, expect, test } from "bun:test";

import renderFacts, {
  renderCurrentFactsBlock,
  renderCurrentFactsBody,
} from "../../assets/extensions/dome.claims/processors/render-facts";
import { claimsFromMarkdown } from "../../assets/extensions/dome.claims/processors/claims-shared";
import type { PatchEffect } from "../../src/core/effect";
import { treeOid, type ExtensionConfig, type Snapshot } from "../../src/core/processor";
import { commitOid } from "../../src/core/source-ref";
import { makeProcessorContext } from "../../src/processors/context";

const HEAD_COMMIT = commitOid("4444444444444444444444444444444444444444");
const TREE = treeOid("5555555555555555555555555555555555555555");

const START = "<!-- dome.claims:current-facts:start -->";
const END = "<!-- dome.claims:current-facts:end -->";

const THREE_CLAIMS = [
  "---",
  "kind: project",
  "---",
  "",
  "# Project Phoenix",
  "",
  "**Status:** Active",
  "**Owner:** [[Mark]]",
  "**Stage:** Build",
  "",
  "Some prose about the project.",
  "",
].join("\n");

describe("dome.claims.render-facts", () => {
  test("3-claim page with no block: one patch inserting the Current facts block after frontmatter + H1", async () => {
    const path = "wiki/notes/phoenix.md";
    const effects = await runRenderFacts([path], { [path]: THREE_CLAIMS });

    expect(effects).toHaveLength(1);
    const patch = expectPatch(effects, 0);
    expect(patch.mode).toBe("auto");
    const change = changesByPath(patch).get(path);
    expect(change?.kind).toBe("write");
    if (change?.kind !== "write") return;
    const content = change.content;

    // Block markers + heading present.
    expect(content).toContain(START);
    expect(content).toContain(END);
    expect(content).toContain("## Current facts");
    // All three facts listed.
    expect(content).toContain("Status");
    expect(content).toContain("Owner");
    expect(content).toContain("Stage");
    // Inserted AFTER frontmatter and the first H1: the H1 precedes the block,
    // the block precedes the original prose.
    const h1At = content.indexOf("# Project Phoenix");
    const startAt = content.indexOf(START);
    const proseAt = content.indexOf("Some prose about the project.");
    expect(h1At).toBeGreaterThanOrEqual(0);
    expect(startAt).toBeGreaterThan(h1At);
    expect(proseAt).toBeGreaterThan(content.indexOf(END));
    // Frontmatter preserved at the very top.
    expect(content.startsWith("---\nkind: project\n---")).toBe(true);
    // Body prose preserved.
    expect(content).toContain("Some prose about the project.");
  });

  test("idempotent: re-running on a page that already has the correct block yields ZERO effects", async () => {
    const path = "wiki/notes/phoenix.md";
    const first = expectPatch(await runRenderFacts([path], { [path]: THREE_CLAIMS }), 0);
    const written = first.changes.find((c) => String(c.path) === path);
    expect(written?.kind).toBe("write");
    if (written?.kind !== "write") return;

    const second = await runRenderFacts([path], { [path]: written.content });
    expect(second).toHaveLength(0);
  });

  test("below threshold (2 claims), no block: zero effects", async () => {
    const path = "wiki/notes/thin.md";
    const content = ["# Thin", "", "**Status:** Active", "**Owner:** [[Mark]]", ""].join("\n");
    const effects = await runRenderFacts([path], { [path]: content });
    expect(effects).toHaveLength(0);
  });

  test("below threshold with a stale block: one patch splicing the block OUT, prose preserved", async () => {
    const path = "wiki/notes/shrunk.md";
    const content = [
      "# Shrunk",
      "",
      START,
      "## Current facts",
      "",
      "- **Status** — Active",
      "- **Owner** — [[Mark]]",
      "- **Stage** — Build",
      END,
      "",
      "**Status:** Active",
      "**Owner:** [[Mark]]",
      "",
      "Surviving prose.",
      "",
    ].join("\n");

    const effects = await runRenderFacts([path], { [path]: content });
    expect(effects).toHaveLength(1);
    const change = changesByPath(expectPatch(effects, 0)).get(path);
    expect(change?.kind).toBe("write");
    if (change?.kind !== "write") return;
    expect(change.content).not.toContain(START);
    expect(change.content).not.toContain(END);
    expect(change.content).not.toContain("## Current facts");
    expect(change.content).toContain("# Shrunk");
    expect(change.content).toContain("Surviving prose.");
    // The original claim lines (human prose) survive untouched.
    expect(change.content).toContain("**Status:** Active");
  });

  test("rendered block body uses NO **Key:** claim grammar (cannot be re-indexed)", async () => {
    const path = "wiki/notes/phoenix.md";
    const patch = expectPatch(await runRenderFacts([path], { [path]: THREE_CLAIMS }), 0);
    const change = patch.changes.find((c) => String(c.path) === path);
    expect(change?.kind).toBe("write");
    if (change?.kind !== "write") return;
    // Scope to the generated block region: it names the key without the
    // colon-bold claim grammar. (The page's original claim prose, which
    // render-facts preserves verbatim, still carries `**Status:**`.)
    const block = change.content.slice(
      change.content.indexOf(START),
      change.content.indexOf(END) + END.length,
    );
    expect(block).toContain("Status");
    expect(block).not.toContain("**Status:**");
    // The generated block, re-parsed in isolation, yields zero claims — and
    // claimsFromMarkdown ignores generated-block regions, so the whole page
    // re-parses to exactly its 3 human claim lines, never 6.
    expect(claimsFromMarkdown(block)).toHaveLength(0);
    expect(claimsFromMarkdown(change.content)).toHaveLength(3);
  });

  test("inline as-of marker renders the date EXACTLY ONCE (no doubling)", async () => {
    const path = "wiki/notes/dated.md";
    const content = [
      "# Dated",
      "",
      "**Status:** Active *(as of 2026-06-12)*",
      "**Owner:** [[Mark]]",
      "**Stage:** Build",
      "",
    ].join("\n");

    const patch = expectPatch(await runRenderFacts([path], { [path]: content }), 0);
    const change = patch.changes.find((c) => String(c.path) === path);
    expect(change?.kind).toBe("write");
    if (change?.kind !== "write") return;
    // Scope to the rendered block: the value carried the marker inline, and
    // the renderer must strip-then-re-append so it appears once, not twice.
    const block = change.content.slice(
      change.content.indexOf(START),
      change.content.indexOf(END) + END.length,
    );
    expect(block.split("*(as of 2026-06-12)*").length - 1).toBe(1);
  });
});

describe("renderCurrentFactsBody / renderCurrentFactsBlock (pure)", () => {
  test("one bolded-key-without-colon line per claim in document order", () => {
    const claims = claimsFromMarkdown(THREE_CLAIMS);
    const body = renderCurrentFactsBody(claims, "wiki/notes/phoenix");
    const lines = body.split("\n");
    expect(lines).toEqual([
      "- **Status** — Active",
      "- **Owner** — [[Mark]]",
      "- **Stage** — Build",
    ]);
    expect(body).not.toContain("**Status:**");
  });

  test("strips a trailing inline as-of from the value and re-appends it once", () => {
    const claims = claimsFromMarkdown(
      ["# X", "", "**Status:** Active *(as of 2026-06-12)*", ""].join("\n"),
    );
    const body = renderCurrentFactsBody(claims, "wiki/notes/x");
    expect(body).toBe("- **Status** — Active *(as of 2026-06-12)*");
    expect(body.split("*(as of 2026-06-12)*").length - 1).toBe(1);
  });

  test("block wraps the heading inside the markers", () => {
    const claims = claimsFromMarkdown(THREE_CLAIMS);
    const block = renderCurrentFactsBlock(claims, "wiki/notes/phoenix");
    expect(block.startsWith(`${START}\n## Current facts\n`)).toBe(true);
    expect(block.endsWith(END)).toBe(true);
  });
});

async function runRenderFacts(
  changedPaths: ReadonlyArray<string>,
  files: Readonly<Record<string, string>>,
  extensionConfig?: ExtensionConfig,
): Promise<ReadonlyArray<unknown>> {
  const ctx = makeProcessorContext({
    snapshot: fakeSnapshot(files),
    changedPaths: [...changedPaths],
    proposal: null,
    runId: "run-render-facts",
    signal: new AbortController().signal,
    input: {
      kind: "schedule",
      cron: "15 5 * * *",
      firedAt: "2026-06-11T09:15:00.000Z",
    },
    ...(extensionConfig === undefined ? {} : { extensionConfig }),
  });
  return renderFacts.run(ctx);
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
