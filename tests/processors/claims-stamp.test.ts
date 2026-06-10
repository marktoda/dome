// tests/processors/claims-stamp.test.ts
import { describe, expect, test } from "bun:test";

import {
  claimAnchorId,
  stampClaimAnchors,
} from "../../assets/extensions/dome.claims/processors/claims-shared";
import { parseBlockAnchor } from "../../src/core/block-anchor";

const PATH = "wiki/entities/alice-henshaw.md";

describe("stampClaimAnchors", () => {
  test("stamps an un-anchored claim and is idempotent", () => {
    const content = "- **Level:** UNI-4 Engineering Manager\n";
    const stamped = stampClaimAnchors({ path: PATH, content });
    expect(stamped).not.toBeNull();
    expect(parseBlockAnchor(stamped!.split("\n")[0]!)?.id).toMatch(/^c[0-9a-f]{8}$/);
    expect(stampClaimAnchors({ path: PATH, content: stamped! })).toBeNull();
  });

  test("identity is keyed by the key, not the value: a value edit keeps the anchor", () => {
    const before = stampClaimAnchors({ path: PATH, content: "- **Pod:** AMM Growth\n" })!;
    const anchor = parseBlockAnchor(before.split("\n")[0]!)?.id;
    expect(anchor).toBeDefined();
    // Supersession: edit the value in place, anchor untouched, nothing re-stamps.
    const superseded = before.replace("AMM Growth", "Protocol Growth");
    expect(stampClaimAnchors({ path: PATH, content: superseded })).toBeNull();
    expect(parseBlockAnchor(superseded.split("\n")[0]!)?.id).toBe(anchor);
    // A fresh stamp of the new value at occurrence 0 yields the SAME id.
    expect(claimAnchorId({ path: PATH, key: "Pod", occurrence: 0 })).toBe(anchor);
  });

  test("two same-key claims in one file get distinct anchors", () => {
    const content = "- **Status:** one\n- **Status:** two\n";
    const stamped = stampClaimAnchors({ path: PATH, content })!;
    const ids = stamped
      .split("\n")
      .map((l) => parseBlockAnchor(l)?.id)
      .filter((id): id is string => id !== undefined);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  test("occurrence counting includes already-anchored claims", () => {
    // First claim anchored at occurrence 0; the new second claim must get
    // occurrence 1, not 0 (which would collide).
    const content = [
      `- **Status:** one ^${claimAnchorId({ path: PATH, key: "Status", occurrence: 0 })}`,
      "- **Status:** two",
      "",
    ].join("\n");
    const stamped = stampClaimAnchors({ path: PATH, content })!;
    const secondId = parseBlockAnchor(stamped.split("\n")[1]!)?.id;
    expect(secondId).toBeDefined();
    expect(secondId).toBe(claimAnchorId({ path: PATH, key: "Status", occurrence: 1 }));
  });

  test("key normalization: case and spacing do not split identity", () => {
    expect(claimAnchorId({ path: PATH, key: "Pod  Managed", occurrence: 0 })).toBe(
      claimAnchorId({ path: PATH, key: "pod managed", occurrence: 0 }),
    );
  });

  test("returns null for documents with no claims", () => {
    expect(stampClaimAnchors({ path: PATH, content: "# Just prose\n" })).toBeNull();
  });

  test("is deterministic for the same path and content", () => {
    const content = "- **Level:** deterministic\n";
    expect(stampClaimAnchors({ path: PATH, content })).toBe(
      stampClaimAnchors({ path: PATH, content }),
    );
  });
});
