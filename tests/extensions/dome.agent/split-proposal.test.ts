import { describe, expect, test } from "bun:test";

import {
  MAX_SPLIT_SUB_PAGES,
  validateSplitProposal,
  type SplitProposalInput,
} from "../../../assets/extensions/dome.agent/lib/split-proposal";
import { proposeSplitTool } from "../../../assets/extensions/dome.agent/lib/consolidate-tools";
import { finishAgentRun } from "../../../assets/extensions/dome.agent/lib/agent-run-effects";
import type { AgentRunState } from "../../../assets/extensions/dome.agent/lib/agent-loop";
import { commitOid, sourceRef } from "../../../src/core/source-ref";

function freshState(): AgentRunState {
  return { edits: new Map(), questions: [], integrityFlags: [] };
}

const reader = (files: Record<string, string> = {}) => ({
  readFile: async (p: string) => files[p] ?? null,
  listMarkdownFiles: async () => Object.keys(files),
});

// ----- Fixtures ---------------------------------------------------------

const DANNY_ORIGINAL = [
  "---",
  "type: entity",
  "description: Danny — colleague and cross-team collaborator",
  "sources:",
  "  - [[wiki/sources/standup-notes]]",
  "---",
  "# Danny",
  "",
  "<!-- dome.claims:current-facts:start -->",
  "## Current facts",
  "- **Role** — Staff engineer, Payments team",
  "<!-- dome.claims:current-facts:end -->",
  "",
  "## Promo push 2026",
  "Danny is leading the promo packet effort for the 2026 cycle.",
  "He needs three more peer reviews before the committee deadline.",
  "",
  "## Onboarding notes",
  "Danny onboarded in March and paired with the platform team for two weeks.",
  "He set up the initial CI pipeline for the payments service.",
  "",
  "## See Also",
  "- [[wiki/entities/acme]]",
  "",
].join("\n");

const DANNY_HUB = [
  "---",
  "type: entity",
  "description: Danny — colleague and cross-team collaborator",
  "sources:",
  "  - [[wiki/sources/standup-notes]]",
  "---",
  "# Danny",
  "",
  "<!-- dome.claims:current-facts:start -->",
  "## Current facts",
  "- **Role** — Staff engineer, Payments team",
  "<!-- dome.claims:current-facts:end -->",
  "",
  "## Split into",
  "- [[wiki/entities/danny-promo-2026]] — the 2026 promo packet push",
  "- [[wiki/entities/danny-onboarding]] — onboarding history",
  "",
  "## See Also",
  "- [[wiki/entities/acme]]",
  "",
].join("\n");

const DANNY_SUB_PROMO = [
  "---",
  "type: entity",
  "description: Danny's 2026 promo packet push",
  "sources:",
  "  - [[wiki/entities/danny]]",
  "---",
  "# Danny — promo push 2026",
  "",
  "## Promo push 2026",
  "Danny is leading the promo packet effort for the 2026 cycle.",
  "He needs three more peer reviews before the committee deadline.",
  "",
].join("\n");

const DANNY_SUB_ONBOARDING = [
  "---",
  "type: entity",
  "description: Danny's onboarding history",
  "sources:",
  "  - [[wiki/entities/danny]]",
  "---",
  "# Danny — onboarding",
  "",
  "## Onboarding notes",
  "Danny onboarded in March and paired with the platform team for two weeks.",
  "He set up the initial CI pipeline for the payments service.",
  "",
].join("\n");

function dannyInput(
  overrides: Partial<SplitProposalInput> = {},
): SplitProposalInput {
  return {
    hubPath: "wiki/entities/danny.md",
    hubContent: DANNY_HUB,
    subPages: [
      { path: "wiki/entities/danny-promo-2026.md", content: DANNY_SUB_PROMO },
      { path: "wiki/entities/danny-onboarding.md", content: DANNY_SUB_ONBOARDING },
    ],
    reason: "dome.agent.consolidate: split danny.md into promo + onboarding",
    ...overrides,
  };
}

// ----- validateSplitProposal ---------------------------------------------

describe("validateSplitProposal — lossless line accounting", () => {
  test("a lossless danny-shaped split (hub + 2 sub-pages, a generated block in the original) is valid", () => {
    expect(validateSplitProposal(dannyInput(), DANNY_ORIGINAL)).toBeNull();
  });

  test("dropping an original body line from every sub-page is lossy", () => {
    const lossySub = DANNY_SUB_PROMO.replace(
      "He needs three more peer reviews before the committee deadline.\n",
      "",
    );
    const result = validateSplitProposal(
      dannyInput({
        subPages: [
          { path: "wiki/entities/danny-promo-2026.md", content: lossySub },
          { path: "wiki/entities/danny-onboarding.md", content: DANNY_SUB_ONBOARDING },
        ],
      }),
      DANNY_ORIGINAL,
    );
    expect(result?.code).toBe("lossy-split");
    expect(result?.message).toContain("committee deadline");
  });

  test("the original's known generated-block content is excluded from accounting even when the hub regenerates it differently", () => {
    const original = [
      "# Hub",
      "<!-- dome.claims:current-facts:start -->",
      "## Current facts",
      "- **Role** — regenerated digest content that changes every run",
      "<!-- dome.claims:current-facts:end -->",
      "",
      "## Topic A",
      "Line A1.",
      "Line A2.",
      "",
      "## Topic B",
      "Line B1.",
      "Line B2.",
      "",
    ].join("\n");
    const hub = [
      "---",
      "description: Hub page",
      "---",
      "# Hub",
      "<!-- dome.claims:current-facts:start -->",
      "## Current facts",
      "- **Role** — a totally different digest string this run",
      "<!-- dome.claims:current-facts:end -->",
      "",
      "## Split into",
      "- [[wiki/entities/hub-topic-a]]",
      "- [[wiki/entities/hub-topic-b]]",
      "",
    ].join("\n");
    const subA = [
      "---",
      "description: Topic A detail",
      "---",
      "# Topic A",
      "## Topic A",
      "Line A1.",
      "Line A2.",
      "",
    ].join("\n");
    const subB = [
      "---",
      "description: Topic B detail",
      "---",
      "# Topic B",
      "## Topic B",
      "Line B1.",
      "Line B2.",
      "",
    ].join("\n");
    const result = validateSplitProposal(
      {
        hubPath: "wiki/entities/hub.md",
        hubContent: hub,
        subPages: [
          { path: "wiki/entities/hub-topic-a.md", content: subA },
          { path: "wiki/entities/hub-topic-b.md", content: subB },
        ],
        reason: "split hub",
      },
      original,
    );
    expect(result).toBeNull();
  });

  test("an UNKNOWN owner/block pair is not excluded — its lines must still be accounted for", () => {
    const original = [
      "# Hub",
      "<!-- dome.unknownbundle:widget:start -->",
      "This line is inside an unrecognized block and must still be preserved.",
      "<!-- dome.unknownbundle:widget:end -->",
      "",
      "## Topic A",
      "Line A1.",
      "",
      "## Topic B",
      "Line B1.",
      "",
    ].join("\n");
    const hub = [
      "---",
      "description: Hub page",
      "---",
      "# Hub",
      "## Split into",
      "- [[wiki/entities/hub-topic-a]]",
      "- [[wiki/entities/hub-topic-b]]",
      "",
    ].join("\n");
    const subA = [
      "---",
      "description: Topic A detail",
      "---",
      "## Topic A",
      "Line A1.",
      "",
    ].join("\n");
    const subB = [
      "---",
      "description: Topic B detail",
      "---",
      "## Topic B",
      "Line B1.",
      "",
    ].join("\n");
    const result = validateSplitProposal(
      {
        hubPath: "wiki/entities/hub.md",
        hubContent: hub,
        subPages: [
          { path: "wiki/entities/hub-topic-a.md", content: subA },
          { path: "wiki/entities/hub-topic-b.md", content: subB },
        ],
        reason: "split hub",
      },
      original,
    );
    // The unrecognized block's marker lines AND body are all ordinary
    // content here (3 lines: start marker, body, end marker) — none of it
    // was blanked, so all 3 are reported missing from the output.
    expect(result?.code).toBe("lossy-split");
    expect(result?.message).toContain("loses 3 line(s)");
  });
});

describe("validateSplitProposal — structural checks", () => {
  test("hubPath must end in .md", () => {
    const result = validateSplitProposal(
      dannyInput({ hubPath: "wiki/entities/danny" }),
      DANNY_ORIGINAL,
    );
    expect(result?.code).toBe("hub-not-markdown");
  });

  test("fewer than 2 sub-pages is rejected", () => {
    const result = validateSplitProposal(
      dannyInput({
        subPages: [{ path: "wiki/entities/danny-promo-2026.md", content: DANNY_SUB_PROMO }],
      }),
      DANNY_ORIGINAL,
    );
    expect(result?.code).toBe("sub-page-count");
  });

  test(`more than ${MAX_SPLIT_SUB_PAGES} sub-pages is rejected`, () => {
    const many = Array.from({ length: MAX_SPLIT_SUB_PAGES + 1 }, (_, i) => ({
      path: `wiki/entities/danny-part-${i}.md`,
      content: `---\ndescription: part ${i}\n---\n# Part ${i}\n`,
    }));
    const result = validateSplitProposal(
      dannyInput({ subPages: many }),
      DANNY_ORIGINAL,
    );
    expect(result?.code).toBe("sub-page-count");
  });

  test("a sub-page path not ending in .md is rejected", () => {
    const result = validateSplitProposal(
      dannyInput({
        subPages: [
          { path: "wiki/entities/danny-promo-2026", content: DANNY_SUB_PROMO },
          { path: "wiki/entities/danny-onboarding.md", content: DANNY_SUB_ONBOARDING },
        ],
      }),
      DANNY_ORIGINAL,
    );
    expect(result?.code).toBe("sub-page-not-markdown");
  });

  test("a sub-page outside the hub's directory is rejected", () => {
    const result = validateSplitProposal(
      dannyInput({
        subPages: [
          { path: "wiki/concepts/danny-promo-2026.md", content: DANNY_SUB_PROMO },
          { path: "wiki/entities/danny-onboarding.md", content: DANNY_SUB_ONBOARDING },
        ],
      }),
      DANNY_ORIGINAL,
    );
    expect(result?.code).toBe("sub-page-wrong-directory");
  });

  test("the hub must link every sub-page as a [[wikilink]]", () => {
    const hubMissingLink = DANNY_HUB.replace(
      "- [[wiki/entities/danny-onboarding]] — onboarding history\n",
      "",
    );
    const result = validateSplitProposal(
      dannyInput({ hubContent: hubMissingLink }),
      DANNY_ORIGINAL,
    );
    expect(result?.code).toBe("missing-hub-wikilink");
    expect(result?.message).toContain("[[wiki/entities/danny-onboarding]]");
  });

  test("a SHORT-FORM hub link ([[danny-onboarding]]) does NOT satisfy the check — full path required, message teaches the fix", () => {
    const hubShortLink = DANNY_HUB.replace(
      "- [[wiki/entities/danny-onboarding]] — onboarding history",
      "- [[danny-onboarding]] — onboarding history",
    );
    const result = validateSplitProposal(
      dannyInput({ hubContent: hubShortLink }),
      DANNY_ORIGINAL,
    );
    expect(result?.code).toBe("missing-hub-wikilink");
    // The error is the model's self-correction signal: it must name the
    // exact full-path form to write and call out the short form as invalid.
    expect(result?.message).toContain("FULL-PATH");
    expect(result?.message).toContain("[[wiki/entities/danny-onboarding]]");
    expect(result?.message).toContain("[[danny-onboarding]]");
  });

  test("full-path hub links with an |alias or #anchor suffix still satisfy the check", () => {
    const hubDecoratedLinks = DANNY_HUB.replace(
      "- [[wiki/entities/danny-promo-2026]] — the 2026 promo packet push",
      "- [[wiki/entities/danny-promo-2026|the promo push]] — the 2026 promo packet push",
    ).replace(
      "- [[wiki/entities/danny-onboarding]] — onboarding history",
      "- [[wiki/entities/danny-onboarding#Onboarding notes]] — onboarding history",
    );
    const result = validateSplitProposal(
      dannyInput({ hubContent: hubDecoratedLinks }),
      DANNY_ORIGINAL,
    );
    // The lossless check is unaffected: the replaced lines were hub
    // additions, not original body lines.
    expect(result).toBeNull();
  });

  test("a duplicated sub-page path is rejected (silent overwrite otherwise)", () => {
    const result = validateSplitProposal(
      dannyInput({
        subPages: [
          { path: "wiki/entities/danny-promo-2026.md", content: DANNY_SUB_PROMO },
          { path: "wiki/entities/danny-promo-2026.md", content: DANNY_SUB_ONBOARDING },
        ],
      }),
      DANNY_ORIGINAL,
    );
    expect(result?.code).toBe("duplicate-sub-page-path");
    expect(result?.message).toContain("wiki/entities/danny-promo-2026.md");
  });

  test("every sub-page needs frontmatter with a description: line", () => {
    const noDescription = DANNY_SUB_PROMO.replace(
      "description: Danny's 2026 promo packet push\n",
      "",
    );
    const result = validateSplitProposal(
      dannyInput({
        subPages: [
          { path: "wiki/entities/danny-promo-2026.md", content: noDescription },
          { path: "wiki/entities/danny-onboarding.md", content: DANNY_SUB_ONBOARDING },
        ],
      }),
      DANNY_ORIGINAL,
    );
    expect(result?.code).toBe("sub-page-missing-description");
  });
});

// ----- proposeSplitTool ----------------------------------------------------

describe("proposeSplitTool", () => {
  test("a valid split sets state.splitProposal", async () => {
    const tool = proposeSplitTool(reader({ "wiki/entities/danny.md": DANNY_ORIGINAL }));
    const state = freshState();
    const out = await tool.execute(dannyInput(), state);
    expect(out).toContain("wiki/entities/danny.md");
    expect(out).toContain("danny-promo-2026.md");
    expect(state.splitProposal).toEqual(dannyInput());
  });

  test("errors (self-correctable) when the hub page does not exist", async () => {
    const tool = proposeSplitTool(reader({}));
    const state = freshState();
    const out = await tool.execute(dannyInput(), state);
    expect(out).toStartWith("error:");
    expect(out).toContain("does not exist");
    expect(state.splitProposal).toBeUndefined();
  });

  test("errors when a sub-page path already exists", async () => {
    const tool = proposeSplitTool(
      reader({
        "wiki/entities/danny.md": DANNY_ORIGINAL,
        "wiki/entities/danny-promo-2026.md": "already here",
      }),
    );
    const state = freshState();
    const out = await tool.execute(dannyInput(), state);
    expect(out).toStartWith("error:");
    expect(out).toContain("already exists");
    expect(state.splitProposal).toBeUndefined();
  });

  test("forwards the validator's error message on an invalid (lossy) split", async () => {
    const tool = proposeSplitTool(reader({ "wiki/entities/danny.md": DANNY_ORIGINAL }));
    const state = freshState();
    const lossySub = DANNY_SUB_PROMO.replace(
      "He needs three more peer reviews before the committee deadline.\n",
      "",
    );
    const out = await tool.execute(
      dannyInput({
        subPages: [
          { path: "wiki/entities/danny-promo-2026.md", content: lossySub },
          { path: "wiki/entities/danny-onboarding.md", content: DANNY_SUB_ONBOARDING },
        ],
      }),
      state,
    );
    expect(out).toStartWith("error:");
    expect(state.splitProposal).toBeUndefined();
  });

  test("a second proposeSplit call in the same run is rejected", async () => {
    const tool = proposeSplitTool(reader({ "wiki/entities/danny.md": DANNY_ORIGINAL }));
    const state = freshState();
    const first = await tool.execute(dannyInput(), state);
    expect(first).not.toStartWith("error:");
    const second = await tool.execute(dannyInput(), state);
    expect(second).toStartWith("error:");
    expect(second).toContain("one split proposal per run");
    // The first proposal is left intact.
    expect(state.splitProposal).toEqual(dannyInput());
  });
});

// ----- finishAgentRun harness wiring --------------------------------------

const refs = [sourceRef({ commit: commitOid("a".repeat(40)), path: "meta/consolidation-ledger.md" })];

function stateWithSplit(opts: {
  readonly split: SplitProposalInput | null;
  readonly writes?: ReadonlyArray<readonly [string, string]>;
  readonly questions?: ReadonlyArray<string>;
}): AgentRunState {
  const state: AgentRunState = { edits: new Map(), questions: [], integrityFlags: [] };
  for (const [path, content] of opts.writes ?? []) {
    state.edits.set(path, { kind: "write", path, content });
  }
  for (const q of opts.questions ?? []) {
    state.questions.push({ question: q, idempotencyKey: `k:${q}` });
  }
  state.splitProposal = opts.split;
  return state;
}

describe("finishAgentRun emits the split proposal as a second, propose-mode PatchEffect", () => {
  test("a split alongside the normal auto patch yields exactly one auto + one propose PatchEffect", () => {
    const split = dannyInput();
    const state = stateWithSplit({
      split,
      writes: [["meta/consolidation-ledger.md", "updated ledger"]],
    });
    const effects = finishAgentRun({
      state,
      stopReason: "final",
      sourceRefs: refs,
      patchReason: "dome.agent: consolidate vault",
      truncatedMessage: "unused",
    });
    const patches = effects.filter((e) => e.kind === "patch");
    expect(patches).toHaveLength(2);
    const auto = patches.find((p) => p.kind === "patch" && p.mode === "auto");
    const propose = patches.find((p) => p.kind === "patch" && p.mode === "propose");
    expect(auto).toBeDefined();
    expect(propose).toBeDefined();
    if (propose?.kind !== "patch") throw new Error("expected a propose patch");
    expect(propose.reason).toBe(split.reason);
    const paths = propose.changes.map((c) => String(c.path));
    expect(paths).toEqual([
      split.hubPath,
      ...split.subPages.map((s) => s.path),
    ]);
    const hubChange = propose.changes[0];
    expect(hubChange?.kind === "write" && hubChange.content).toBe(split.hubContent);
  });

  test("the split patch's sourceRefs resolve via the `sourceRef` callback to the hub path, not the run's general sourceRefs", () => {
    const split = dannyInput();
    const state = stateWithSplit({ split });
    const effects = finishAgentRun({
      state,
      stopReason: "final",
      sourceRefs: refs,
      patchReason: "dome.agent: consolidate vault",
      truncatedMessage: "unused",
      sourceRef: (path) => sourceRef({ commit: commitOid("b".repeat(40)), path }),
    });
    const propose = effects.find((e) => e.kind === "patch" && e.mode === "propose");
    if (propose?.kind !== "patch") throw new Error("expected a propose patch");
    expect(propose.sourceRefs).toHaveLength(1);
    expect(String(propose.sourceRefs[0]?.path)).toBe(split.hubPath);
    expect(propose.sourceRefs[0]?.commit).toBe(commitOid("b".repeat(40)));
  });

  test("without a `sourceRef` callback the split patch falls back to the run's general sourceRefs", () => {
    const split = dannyInput();
    const state = stateWithSplit({ split });
    const effects = finishAgentRun({
      state,
      stopReason: "final",
      sourceRefs: refs,
      patchReason: "dome.agent: consolidate vault",
      truncatedMessage: "unused",
    });
    const propose = effects.find((e) => e.kind === "patch" && e.mode === "propose");
    if (propose?.kind !== "patch") throw new Error("expected a propose patch");
    expect(propose.sourceRefs).toEqual(refs);
  });

  test("a split-only run (no edits, no questions) is NOT flagged as a no-op", () => {
    const split = dannyInput();
    const state = stateWithSplit({ split });
    const effects = finishAgentRun({
      state,
      stopReason: "final",
      sourceRefs: refs,
      patchReason: "dome.agent: consolidate vault",
      truncatedMessage: "unused",
      noOp: {
        code: "dome.agent.consolidate-no-op",
        message: (excerpt) => `no-op: ${excerpt}`,
        finalText: "Proposed a split, nothing else to do.",
      },
    });
    expect(effects.some((e) => e.kind === "diagnostic" && e.code === "dome.agent.consolidate-no-op")).toBe(
      false,
    );
    const patches = effects.filter((e) => e.kind === "patch");
    expect(patches).toHaveLength(1);
    expect(patches[0]?.kind === "patch" && patches[0].mode).toBe("propose");
  });

  test("an overreaching auto patch is rolled back but the split proposal survives untouched", () => {
    const split = dannyInput();
    const state = stateWithSplit({
      split,
      writes: [
        ["wiki/a.md", "A"],
        ["wiki/b.md", "B"],
        ["wiki/c.md", "C"],
      ],
    });
    const effects = finishAgentRun({
      state,
      stopReason: "final",
      sourceRefs: refs,
      patchReason: "dome.agent: consolidate vault",
      truncatedMessage: "unused",
      cap: {
        maxChangedFiles: 2,
        code: "dome.agent.consolidate-overreach",
        message: (count) => `touched ${count} files (cap 2); rolled back.`,
      },
    });
    const patches = effects.filter((e) => e.kind === "patch");
    expect(patches).toHaveLength(1);
    expect(patches[0]?.kind === "patch" && patches[0].mode).toBe("propose");
    const overreach = effects.find(
      (e) => e.kind === "diagnostic" && e.code === "dome.agent.consolidate-overreach",
    );
    expect(overreach).toBeDefined();
  });

  test("with no split proposal, behavior is unchanged: only the auto patch", () => {
    const state = stateWithSplit({ split: null, writes: [["wiki/a.md", "A"]] });
    const effects = finishAgentRun({
      state,
      stopReason: "final",
      sourceRefs: refs,
      patchReason: "dome.agent: consolidate vault",
      truncatedMessage: "unused",
    });
    const patches = effects.filter((e) => e.kind === "patch");
    expect(patches).toHaveLength(1);
    expect(patches[0]?.kind === "patch" && patches[0].mode).toBe("auto");
  });
});
