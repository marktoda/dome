// tests/core/anchor-id-stability.test.ts
//
// Golden anchor IDs. ^t…/^c… anchors are durable identity in committed user
// markdown — if any refactor changes these hashes, every task and claim in
// every vault gets re-identified. These literals are computed from the
// CURRENT implementation and must never change.

import { describe, expect, test } from "bun:test";

import { claimAnchorId } from "../../assets/extensions/dome.claims/processors/claims-shared";
import { taskAnchorId } from "../../assets/extensions/dome.daily/processors/daily-shared";

describe("anchor id stability", () => {
  test("taskAnchorId golden value", () => {
    const a = taskAnchorId({
      path: "wiki/dailies/2026-06-01.md",
      body: "Follow up with Maya about the platform review",
      occurrence: 0,
    });
    expect(a).toMatch(/^t[0-9a-f]{8}$/);
    expect(a).toBe("t4609d1b2");
  });

  test("taskAnchorId path normalization: ./ prefix is NOT stripped (DIVERGENCE from claimAnchorId)", () => {
    // normalizeSourcePath trims, strips fragment (#...), appends .md if missing,
    // but does NOT strip a leading ./ prefix.
    // DIVERGENCE: claimAnchorId.path uses `input.path.replace(/^\.\//, "")` — strips ./
    //             taskAnchorId.path uses normalizeSourcePath which preserves ./
    // So "wiki/dailies/2026-06-01.md" vs "./wiki/dailies/2026-06-01.md" produce
    // DIFFERENT hashes for taskAnchorId. Frozen — do not unify.
    const withoutDot = taskAnchorId({
      path: "wiki/dailies/2026-06-01.md",
      body: "Follow up with Maya about the platform review",
      occurrence: 0,
    });
    const withDot = taskAnchorId({
      path: "./wiki/dailies/2026-06-01.md",
      body: "Follow up with Maya about the platform review",
      occurrence: 0,
    });
    expect(withoutDot).toBe("t4609d1b2");
    expect(withDot).toBe("t19af4521");
    // They are NOT equal — the ./ prefix changes the hash for taskAnchorId.
    expect(withDot).not.toBe(withoutDot);
  });

  test("taskAnchorId body whitespace collapse: multiple spaces normalize to same id", () => {
    // normalizeOpenLoopBody: semanticActionBody(body).toLowerCase().replace(/\s+/g, " ").trim()
    // Multiple internal spaces are collapsed to single spaces before hashing.
    const a = taskAnchorId({
      path: "wiki/dailies/2026-06-01.md",
      body: "Follow up with Maya about the platform review",
      occurrence: 0,
    });
    const collapsed = taskAnchorId({
      path: "wiki/dailies/2026-06-01.md",
      body: "Follow  up with  Maya about the platform review",
      occurrence: 0,
    });
    // Both normalize to the same body — equal hashes.
    expect(collapsed).toBe("t4609d1b2");
    expect(collapsed).toBe(a);
  });

  test("claimAnchorId golden value", () => {
    const a = claimAnchorId({
      path: "wiki/entities/acme.md",
      key: "Headcount",
      occurrence: 0,
    });
    expect(a).toMatch(/^c[0-9a-f]{8}$/);
    expect(a).toBe("c056f7a79");
  });

  test("claimAnchorId path normalization: ./ prefix IS stripped", () => {
    // claimAnchorId does: input.path.replace(/^\.\//, "") before hashing.
    // So "wiki/entities/acme.md" and "./wiki/entities/acme.md" hash the SAME.
    // This is the OPPOSITE behavior from taskAnchorId. Frozen — do not unify.
    const a = claimAnchorId({
      path: "wiki/entities/acme.md",
      key: "Headcount",
      occurrence: 0,
    });
    const b = claimAnchorId({
      path: "./wiki/entities/acme.md",
      key: "Headcount",
      occurrence: 0,
    });
    expect(b).toBe(a); // ./ stripped — equal hashes
    expect(b).toBe("c056f7a79");
  });

  test("claimAnchorId key normalization: case-insensitive, whitespace collapsed", () => {
    // normalizeClaimKey: key.toLowerCase().replace(/\s+/g, " ").trim()
    // "Headcount" and "HEADCOUNT" both normalize to "headcount" — same hash.
    const lower = claimAnchorId({
      path: "wiki/entities/acme.md",
      key: "headcount",
      occurrence: 0,
    });
    const upper = claimAnchorId({
      path: "wiki/entities/acme.md",
      key: "Headcount",
      occurrence: 0,
    });
    expect(lower).toBe(upper); // case-insensitive: both "headcount"
    expect(lower).toBe("c056f7a79");

    // "Head  count" normalizes to "head count" (with a space) — different from "headcount"
    const spaced = claimAnchorId({
      path: "wiki/entities/acme.md",
      key: "Head  count",
      occurrence: 0,
    });
    expect(spaced).not.toBe(upper); // "head count" != "headcount"
    expect(spaced).toBe("c1c0639ce"); // golden: "head count" at occurrence 0
  });
});
