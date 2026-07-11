import { describe, expect, test } from "bun:test";
import {
  validateSplitProposal,
  type SplitProposalInput,
} from "../../../assets/extensions/dome.agent/lib/split-proposal";

const ORIGINAL = [
  "---",
  "description: An accreted page",
  "---",
  "# Subject",
  "",
  "## Alpha",
  "Alpha detail",
  "",
  "## Beta",
  "Beta detail",
].join("\n");

function validSplit(): SplitProposalInput {
  return {
    hubPath: "wiki/concepts/subject.md",
    hubContent: [
      "---",
      "description: Subject hub",
      "---",
      "# Subject",
      "[[wiki/concepts/subject-alpha]]",
      "[[wiki/concepts/subject-beta]]",
    ].join("\n"),
    subPages: [
      {
        path: "wiki/concepts/subject-alpha.md",
        content: "---\ndescription: Alpha aspect\n---\n## Alpha\nAlpha detail\n",
      },
      {
        path: "wiki/concepts/subject-beta.md",
        content: "---\ndescription: Beta aspect\n---\n## Beta\nBeta detail\n",
      },
    ],
    reason: "separate two durable concepts",
  };
}

describe("semantic-garden split validation", () => {
  test("accepts a lossless, linked sibling split", () => {
    expect(validateSplitProposal(validSplit(), ORIGINAL)).toBeNull();
  });

  test("rejects a split that drops original knowledge", () => {
    const candidate = validSplit();
    const lossy = {
      ...candidate,
      subPages: candidate.subPages.map((page, index) =>
        index === 1 ? { ...page, content: "---\ndescription: Beta aspect\n---\n## Beta\n" } : page
      ),
    };
    expect(validateSplitProposal(lossy, ORIGINAL)?.code).toBe("lossy-split");
  });

  test("requires full-path hub links", () => {
    const candidate = validSplit();
    const shortLinks = {
      ...candidate,
      hubContent: candidate.hubContent.replace(
        "[[wiki/concepts/subject-beta]]",
        "[[subject-beta]]",
      ),
    };
    expect(validateSplitProposal(shortLinks, ORIGINAL)?.code).toBe(
      "missing-hub-wikilink",
    );
  });
});
