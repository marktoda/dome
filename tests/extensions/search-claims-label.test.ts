import { describe, expect, test } from "bun:test";

import {
  CLAIM_PREDICATE,
  parseClaimFact,
} from "../../assets/extensions/dome.claims/processors/claim-fact";
import { searchFactObjectLabel } from "../../assets/extensions/dome.search/processors/labels";
import type { FactEffect } from "../../src/core/effect";

function claimFact(object: string): FactEffect {
  return {
    kind: "fact",
    subject: { kind: "page", path: "wiki/projects/atlas.md" },
    predicate: CLAIM_PREDICATE,
    object: { kind: "string", value: object },
    assertion: "extracted",
    sourceRefs: [],
  } as unknown as FactEffect;
}

describe("parseClaimFact", () => {
  test("decodes a claim fact with an as-of date", () => {
    const parsed = parseClaimFact(
      claimFact(JSON.stringify({ key: "Status", value: "in design review", asOf: "2026-06-12" })),
    );
    expect(parsed).toEqual({ key: "Status", value: "in design review", asOf: "2026-06-12" });
  });

  test("strips the inline as-of marker the indexer stores in value", () => {
    const parsed = parseClaimFact(
      claimFact(
        JSON.stringify({
          key: "Status",
          value: "in design review *(as of 2026-06-12)*",
          asOf: "2026-06-12",
        }),
      ),
    );
    expect(parsed).toEqual({ key: "Status", value: "in design review", asOf: "2026-06-12" });
  });

  test("decodes a claim fact without an as-of date", () => {
    const parsed = parseClaimFact(
      claimFact(JSON.stringify({ key: "Owner", value: "[[danny]]" })),
    );
    expect(parsed).toEqual({ key: "Owner", value: "[[danny]]", asOf: null });
  });

  test("returns null for a non-claim predicate", () => {
    const fact = { ...claimFact("{}"), predicate: "dome.graph.links_to" } as FactEffect;
    expect(parseClaimFact(fact)).toBeNull();
  });

  test("returns null for malformed JSON (defensive, no throw)", () => {
    expect(parseClaimFact(claimFact("not json"))).toBeNull();
    expect(parseClaimFact(claimFact(JSON.stringify({ key: "x" })))).toBeNull(); // missing value
  });

  test("returns null for a non-string object kind", () => {
    const fact = {
      ...claimFact("{}"),
      object: { kind: "number", value: 5 },
    } as FactEffect;
    expect(parseClaimFact(fact)).toBeNull();
  });

  test("returns null when JSON parses to a non-object", () => {
    expect(parseClaimFact(claimFact("[1,2]"))).toBeNull(); // array
    expect(parseClaimFact(claimFact("42"))).toBeNull(); // number
  });
});

describe("searchFactObjectLabel for claims", () => {
  test("renders Key: value (as of date)", () => {
    expect(
      searchFactObjectLabel(
        claimFact(JSON.stringify({ key: "Status", value: "in design review", asOf: "2026-06-12" })),
      ),
    ).toBe("Status: in design review (as of 2026-06-12)");
  });

  test("renders a single as-of for the indexer's inline-marker value", () => {
    expect(
      searchFactObjectLabel(
        claimFact(
          JSON.stringify({
            key: "Status",
            value: "in design review *(as of 2026-06-12)*",
            asOf: "2026-06-12",
          }),
        ),
      ),
    ).toBe("Status: in design review (as of 2026-06-12)");
  });

  test("renders Key: value when no as-of", () => {
    expect(
      searchFactObjectLabel(claimFact(JSON.stringify({ key: "Owner", value: "[[danny]]" }))),
    ).toBe("Owner: [[danny]]");
  });
});
