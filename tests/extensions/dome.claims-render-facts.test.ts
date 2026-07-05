// dome.claims.render-facts — garden processor tests. A claim-rich page gets a
// deterministic `## Current facts` generated block (owner dome.claims, block
// current-facts) spliced in after frontmatter + first H1; a page that drops
// below the threshold has a stale block spliced OUT. Same snapshot → same
// patch; matching desired state → ZERO effects (idempotent). The rendered
// block uses NO `**Key:**` claim grammar, so it is never re-indexed as claims.
import { describe, expect, test } from "bun:test";

import renderFacts, {
  isPlaceholderValue,
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
    const path = "wiki/entities/phoenix.md";
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
    // The digest predicts the same deterministic anchors that
    // dome.claims.stamp will apply in the same garden cascade, so the first
    // rendered block is already the fixed-point block with backlinks.
    expect(
      content.match(/\(\[\[wiki\/entities\/phoenix#\^c[0-9a-f]{8}\]\]\)/g) ??
        [],
    ).toHaveLength(3);
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
    const path = "wiki/entities/phoenix.md";
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

  test("non-entity page (wiki/notes) with an existing block ABOVE threshold: touched again → block removed (scope guard, not threshold)", async () => {
    // Recharter: digests survive on wiki/entities/** ONLY. This page carries
    // 3 claims (at/above the default min) and an existing correct block, so
    // pre-recharter logic would consider it "desired" and leave it alone.
    // Under the scope guard a non-entity page is NEVER desired, so the
    // existing splice-out branch fires regardless of claim count.
    const path = "wiki/notes/plenty.md";
    const content = [
      "# Plenty",
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
      "**Stage:** Build",
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
    expect(change.content).toContain("# Plenty");
    expect(change.content).toContain("Surviving prose.");
    // The original claim lines (human prose) survive untouched.
    expect(change.content).toContain("**Status:** Active");
  });

  test("entity page renders a capped+sorted digest: most-recent-asOf-first", async () => {
    const path = "wiki/entities/danny.md";
    const content = [
      "# Danny",
      "",
      "**Status:** Active *(as of 2026-06-01)*",
      "**Owner:** [[Mark]] *(as of 2026-06-20)*",
      "**Stage:** Build *(as of 2026-06-10)*",
      "**Extra:** Undated claim",
      "",
    ].join("\n");

    const patch = expectPatch(await runRenderFacts([path], { [path]: content }), 0);
    const change = patch.changes.find((c) => String(c.path) === path);
    expect(change?.kind).toBe("write");
    if (change?.kind !== "write") return;
    const block = change.content.slice(
      change.content.indexOf(START),
      change.content.indexOf(END) + END.length,
    );
    const bulletLines = block
      .split("\n")
      .filter((line) => line.startsWith("- **"));
    // Most-recent-asOf-first; the undated claim (no asOf) sorts last. Anchors
    // are stripped for comparison — they're deterministic but irrelevant
    // noise for the ordering assertion this test cares about.
    const stripAnchor = (line: string) => line.replace(/ \(\[\[.*?\]\]\)$/, "");
    expect(bulletLines.map(stripAnchor)).toEqual([
      "- **Owner** — [[Mark]] *(as of 2026-06-20)*",
      "- **Stage** — Build *(as of 2026-06-10)*",
      "- **Status** — Active *(as of 2026-06-01)*",
      "- **Extra** — Undated claim",
    ]);
  });

  test("placeholder claim ([-bracketed template text) is excluded from the rendered digest", async () => {
    const path = "wiki/entities/template-page.md";
    const content = [
      "# Template Page",
      "",
      "**Status:** Active",
      "**Owner:** [[Mark]]",
      "**Stage:** Build",
      "**Incident:** [Specific incident — fill in or drop]",
      "",
    ].join("\n");

    const patch = expectPatch(await runRenderFacts([path], { [path]: content }), 0);
    const change = patch.changes.find((c) => String(c.path) === path);
    expect(change?.kind).toBe("write");
    if (change?.kind !== "write") return;
    const block = change.content.slice(
      change.content.indexOf(START),
      change.content.indexOf(END) + END.length,
    );
    // The real claims render; the placeholder never does.
    expect(block).toContain("- **Status** — Active");
    expect(block).toContain("- **Owner** — [[Mark]]");
    expect(block).toContain("- **Stage** — Build");
    expect(block).not.toContain("Incident");
    expect(block).not.toContain("fill in or drop");
    // The placeholder claim is excluded from the count too: only 3 bullets.
    expect(block.split("\n").filter((line) => line.startsWith("- **"))).toHaveLength(3);
  });

  test("placeholder shielded by a supersession tail (*(as of …)* [[source]]) is STILL excluded", async () => {
    // The sweep supersedes values in place and appends `*(as of …)* [[source]]`.
    // A never-filled placeholder that went through that path arrives wearing a
    // trailing wikilink — a naive endsWith-`]]` wikilink guard would suppress
    // detection and launder the scaffolding into the digest. The annotations
    // must be peeled BEFORE the placeholder-shape test.
    const path = "wiki/entities/laundered.md";
    const content = [
      "# Laundered",
      "",
      "**Status:** Active",
      "**Owner:** [[Mark]]",
      "**Stage:** Build",
      "**Incident:** [Specific incident — fill in or drop] *(as of 2026-06-12)* [[meta/sources/x]]",
      "",
    ].join("\n");

    const patch = expectPatch(await runRenderFacts([path], { [path]: content }), 0);
    const change = patch.changes.find((c) => String(c.path) === path);
    expect(change?.kind).toBe("write");
    if (change?.kind !== "write") return;
    const block = change.content.slice(
      change.content.indexOf(START),
      change.content.indexOf(END) + END.length,
    );
    expect(block).not.toContain("Incident");
    expect(block).not.toContain("fill in or drop");
    expect(block.split("\n").filter((line) => line.startsWith("- **"))).toHaveLength(3);
  });

  test("legitimate bracketed fragments inside a value are NOT placeholders and render", async () => {
    // Bracket fragments inside real prose must never classify as placeholder:
    // `[A] and [B]` (two bracketed citations), `Shipped v2 [beta] on …`
    // (a mid-string version tag), and `[Owner] and [[Mark]]` (an unfilled slot
    // alongside substantive content — borderline, and the conservative posture
    // lets a borderline real claim through rather than dropping a real fact).
    const path = "wiki/entities/bracketed.md";
    const content = [
      "# Bracketed",
      "",
      "**Cites:** [A] and [B]",
      "**Release:** Shipped v2 [beta] on 2026-06-01",
      "**Maintainers:** [Owner] and [[Mark]]",
      "",
    ].join("\n");

    const patch = expectPatch(await runRenderFacts([path], { [path]: content }), 0);
    const change = patch.changes.find((c) => String(c.path) === path);
    expect(change?.kind).toBe("write");
    if (change?.kind !== "write") return;
    const block = change.content.slice(
      change.content.indexOf(START),
      change.content.indexOf(END) + END.length,
    );
    expect(block).toContain("- **Cites** — [A] and [B]");
    expect(block).toContain("- **Release** — Shipped v2 [beta] on 2026-06-01");
    expect(block).toContain("- **Maintainers** — [Owner] and [[Mark]]");
    expect(block.split("\n").filter((line) => line.startsWith("- **"))).toHaveLength(3);
  });

  test("entity page BELOW threshold (2 claims), no block: zero effects — entity scope alone never forces a digest", async () => {
    const path = "wiki/entities/thin-entity.md";
    const content = ["# Thin Entity", "", "**Status:** Active", "**Owner:** [[Mark]]", ""].join("\n");
    const effects = await runRenderFacts([path], { [path]: content });
    expect(effects).toHaveLength(0);
  });

  test("13 claims on an entity page: capped at 12 bullets + `+1 more — dome query <subject>` tail", async () => {
    const path = "wiki/entities/prolific.md";
    const claimLines = Array.from({ length: 13 }, (_, i) => {
      const n = i + 1;
      const day = String(n).padStart(2, "0");
      return `**Key${n}:** Value ${n} *(as of 2026-01-${day})*`;
    });
    const content = ["# Prolific", "", ...claimLines, ""].join("\n");

    const patch = expectPatch(await runRenderFacts([path], { [path]: content }), 0);
    const change = patch.changes.find((c) => String(c.path) === path);
    expect(change?.kind).toBe("write");
    if (change?.kind !== "write") return;
    const block = change.content.slice(
      change.content.indexOf(START),
      change.content.indexOf(END) + END.length,
    );
    const bulletLines = block
      .split("\n")
      .filter((line) => line.startsWith("- **"));
    expect(bulletLines).toHaveLength(12);
    // Most-recent-asOf-first: Key13 (2026-01-13) sorts first, Key2 is the
    // 12th (last shown); Key1 (the oldest) is the one dropped.
    expect(bulletLines[0]).toContain("Key13");
    expect(bulletLines[11]).toContain("Key2");
    // Key1 (2026-01-01, the oldest) is the one dropped by the cap.
    expect(block).not.toContain("**Key1**");
    expect(block).toContain("- +1 more — `dome query prolific`");
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
    const path = "wiki/entities/phoenix.md";
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
    const path = "wiki/entities/dated.md";
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

  test("mid-value as-of marker + trailing wikilink (real sweep shape): date appears EXACTLY ONCE, wikilink preserved", async () => {
    // The canonical superseded claim (sweep charter): the `*(as of …)*` marker
    // sits MID-value with a `[[wikilink]]` AFTER it. claims-shared strips only
    // the trailing `^c…` anchor, so the marker stays embedded in `claim.value`.
    // A trailing-anchored strip would miss it and the date would double.
    const path = "wiki/entities/superseded.md";
    const content = [
      "# Superseded",
      "",
      "**Status:** Active *(as of 2026-06-12)* [[meta/sources/x]]",
      "**Owner:** [[Mark]]",
      "**Stage:** Build",
      "",
    ].join("\n");

    const patch = expectPatch(await runRenderFacts([path], { [path]: content }), 0);
    const change = patch.changes.find((c) => String(c.path) === path);
    expect(change?.kind).toBe("write");
    if (change?.kind !== "write") return;
    const block = change.content.slice(
      change.content.indexOf(START),
      change.content.indexOf(END) + END.length,
    );
    // Date once, wikilink preserved, re-rendered with the marker at the end.
    expect(block.split("*(as of 2026-06-12)*").length - 1).toBe(1);
    expect(block).toContain("[[meta/sources/x]]");
    expect(block).toContain("- **Status** — Active [[meta/sources/x]] *(as of 2026-06-12)*");
  });

  test("block-only page below threshold: splice-out is guarded (no empty-file write), zero effects", async () => {
    // A page that is nothing but the block + heading (no frontmatter, no prose)
    // drops below threshold. removeBlockAt would yield "" — but the conscious
    // guard refuses to write an empty file (and refuses to delete the note),
    // so the page gets no patch at all.
    const path = "wiki/notes/block-only.md";
    const content = [
      START,
      "## Current facts",
      "",
      "- **Status** — Active",
      "- **Owner** — [[Mark]]",
      "- **Stage** — Build",
      END,
      "",
    ].join("\n");

    const effects = await runRenderFacts([path], { [path]: content });
    expect(effects).toHaveLength(0);
  });

  test("replace→replace idempotency: editing one claim re-renders the block once, re-run is a no-op", async () => {
    const path = "wiki/entities/phoenix.md";
    // Seed: a page that already carries a correct block.
    const seeded = expectPatch(await runRenderFacts([path], { [path]: THREE_CLAIMS }), 0);
    const seededWrite = seeded.changes.find((c) => String(c.path) === path);
    expect(seededWrite?.kind).toBe("write");
    if (seededWrite?.kind !== "write") return;

    // Edit one claim's value in the human prose, keeping count >= threshold.
    const edited = seededWrite.content.replace("**Stage:** Build", "**Stage:** Ship");

    const first = expectPatch(await runRenderFacts([path], { [path]: edited }), 0);
    const firstWrite = first.changes.find((c) => String(c.path) === path);
    expect(firstWrite?.kind).toBe("write");
    if (firstWrite?.kind !== "write") return;
    // The re-rendered block reflects the edit.
    const block = firstWrite.content.slice(
      firstWrite.content.indexOf(START),
      firstWrite.content.indexOf(END) + END.length,
    );
    expect(block).toContain("- **Stage** — Ship");

    // Run AGAIN on that output → zero effects.
    const second = await runRenderFacts([path], { [path]: firstWrite.content });
    expect(second).toHaveLength(0);
  });

  test("no frontmatter and no H1: block inserted at top of body, idempotent on re-run", async () => {
    const path = "wiki/entities/bare.md";
    const content = [
      "**Status:** Active",
      "**Owner:** [[Mark]]",
      "**Stage:** Build",
      "",
      "Some prose.",
      "",
    ].join("\n");

    const patch = expectPatch(await runRenderFacts([path], { [path]: content }), 0);
    const change = patch.changes.find((c) => String(c.path) === path);
    expect(change?.kind).toBe("write");
    if (change?.kind !== "write") return;
    // No frontmatter / no H1 → block lands at the top of the body.
    expect(change.content.startsWith(START)).toBe(true);
    expect(change.content).toContain("## Current facts");
    expect(change.content).toContain("Some prose.");

    // Re-run on that output → zero effects.
    const second = await runRenderFacts([path], { [path]: change.content });
    expect(second).toHaveLength(0);
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

describe("isPlaceholderValue (pure)", () => {
  test("placeholder: one bracket pair wrapping the entire value", () => {
    expect(isPlaceholderValue("[Specific incident — fill in or drop]")).toBe(true);
    expect(isPlaceholderValue("[fill in]")).toBe(true);
  });

  test("placeholder: supersession tail (as-of marker + trailing wikilinks) is peeled first", () => {
    expect(
      isPlaceholderValue(
        "[Specific incident — fill in or drop] *(as of 2026-06-12)* [[meta/sources/x]]",
      ),
    ).toBe(true);
    // Multiple trailing annotations peel too.
    expect(isPlaceholderValue("[fill in] [[a]] [[b]]")).toBe(true);
  });

  test("not a placeholder: bracketed fragments inside a larger value", () => {
    expect(isPlaceholderValue("[A] and [B]")).toBe(false);
    expect(isPlaceholderValue("Shipped v2 [beta] on 2026-06-01")).toBe(false);
    // An unfilled slot alongside substantive content is borderline — the
    // conservative posture renders it rather than dropping a real fact.
    expect(isPlaceholderValue("[Owner] and [[Mark]]")).toBe(false);
  });

  test("not a placeholder: whole-value wikilink, plain prose, empty-ish", () => {
    expect(isPlaceholderValue("[[Mark]]")).toBe(false);
    expect(isPlaceholderValue("Active")).toBe(false);
    expect(isPlaceholderValue("Active *(as of 2026-06-12)*")).toBe(false);
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
