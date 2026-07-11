import { describe, expect, test } from "bun:test";
import {
  compileGardeningPlan,
  type GardenDocument,
} from "../../../assets/extensions/dome.agent/lib/gardening";

function doc(path: string, content: string): GardenDocument {
  return { path, content };
}

const fm = (description: string, body = "") =>
  `---\ndescription: ${description}\nstatus: active\n---\n\n${body}\n`;

describe("compileGardeningPlan", () => {
  test("ranks evidence-backed semantic issues and keeps the result bounded", () => {
    const oldClaim = "- **Status:** active *(as of 2025-01-01)* ^cstatus";
    const huge = Array.from({ length: 605 }, (_, i) => `line ${i}`).join("\n");
    const plan = compileGardeningPlan({
      today: "2026-07-09",
      limit: 2,
      documents: [
        doc("wiki/entities/alice.md", fm("Alice product leader", oldClaim)),
        doc("wiki/entities/alice-profile.md", fm("Alice product leader", "- **Status:** inactive *(as of 2026-06-01)*")),
        doc("wiki/syntheses/large.md", fm("Large synthesis", huge)),
      ],
    });

    expect(plan.opportunities).toHaveLength(2);
    expect(plan.totalOpportunities).toBeGreaterThan(2);
    expect(plan.counts["oversized-page"]).toBe(1);
    expect(plan.counts["stale-claims"]).toBe(1);
    expect(plan.counts["conflicting-claims"]).toBe(1);
  });

  test("recent daily material becomes an integration opportunity until sources settle it", () => {
    const daily = doc(
      "wiki/dailies/2026-07-08.md",
      "Met with [[wiki/entities/alice]] and learned she now owns launch.",
    );
    const destination = doc("wiki/entities/alice.md", fm("Alice", "# Alice"));
    const open = compileGardeningPlan({
      today: "2026-07-09",
      documents: [daily, destination],
    });
    expect(open.opportunities.some((item) => item.kind === "integrate-material")).toBe(true);

    const settled = compileGardeningPlan({
      today: "2026-07-09",
      documents: [
        daily,
        doc(
          "wiki/entities/alice.md",
          "---\ndescription: Alice\nstatus: active\nsources:\n  - \"[[wiki/dailies/2026-07-08]]\"\n---\n# Alice\n",
        ),
      ],
    });
    expect(settled.opportunities.some((item) => item.kind === "integrate-material")).toBe(false);
  });

  test("groups explicit destinations into one bounded source-centered opportunity", () => {
    const daily = doc(
      "wiki/dailies/2026-07-08.md",
      "Met [[wiki/entities/alice]] and [[wiki/entities/bob]].",
    );
    const plan = compileGardeningPlan({
      today: "2026-07-09",
      documents: [
        daily,
        doc("wiki/entities/alice.md", fm("Alice")),
        doc("wiki/entities/bob.md", fm("Bob")),
      ],
    });
    const material = plan.opportunities.filter((item) => item.kind === "integrate-material");
    expect(material).toHaveLength(1);
    expect(material[0]?.paths).toEqual([
      "wiki/dailies/2026-07-08.md",
      "wiki/entities/alice.md",
      "wiki/entities/bob.md",
    ]);
  });

  test("proposal decisions settle exact evidence but changed evidence re-arms", () => {
    const documents = [doc("wiki/entities/lonely.md", fm("Lonely page", "# Lonely"))];
    const first = compileGardeningPlan({ today: "2026-07-09", documents });
    const orphan = first.opportunities.find((item) => item.kind === "orphan-page")!;
    const settled = compileGardeningPlan({
      today: "2026-07-09",
      documents,
      settledOpportunityIds: new Set([orphan.id]),
    });
    expect(settled.opportunities.some((item) => item.id === orphan.id)).toBe(false);

    const changed = compileGardeningPlan({
      today: "2026-07-09",
      documents: [doc("wiki/entities/lonely.md", fm("Renamed lonely page", "# Lonely"))],
      settledOpportunityIds: new Set([orphan.id]),
    });
    expect(changed.opportunities.some((item) => item.kind === "orphan-page")).toBe(true);
  });

  test("superseded pages are excluded and quiet pages enter stateless rotation", () => {
    const plan = compileGardeningPlan({
      today: "2026-07-09",
      documents: [
        doc("wiki/entities/active.md", fm("Active", "[[wiki/entities/other]]")),
        doc("wiki/entities/other.md", fm("Other", "[[wiki/entities/active]]")),
        doc(
          "wiki/entities/old.md",
          "---\ndescription: Old\nstatus: superseded\n---\n",
        ),
      ],
    });
    expect(plan.totalSemanticPages).toBe(2);
    expect(plan.opportunities.some((item) => item.kind === "rotation-review")).toBe(true);
    expect(plan.opportunities.flatMap((item) => item.paths)).not.toContain("wiki/entities/old.md");
  });
});
