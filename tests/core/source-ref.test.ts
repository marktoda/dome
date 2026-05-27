// Smoke tests for src/core/source-ref.ts: the SourceRef boundary schemas,
// constructor freeze + optional-key cleanliness, and the OID brand helpers.

import { describe, test, expect } from "bun:test";
import {
  SourceRefSchema,
  blobOid,
  commitOid,
  sourceRef,
  type BlobOid,
  type CommitOid,
} from "../../src/core/source-ref";
import { treeOid, type TreeOid } from "../../src/core/processor";

describe("SourceRefSchema", () => {
  test("parses a valid SourceRef and round-trips identity", () => {
    const input = {
      commit: "abc123",
      path: "wiki/entities/danny.md",
      blob: "deadbeef",
      range: { startLine: 1, endLine: 5 },
      stableId: "task-42",
    };
    const parsed = SourceRefSchema.parse(input);
    expect(parsed).toEqual(input);
  });

  test("rejects an empty commit string", () => {
    expect(() =>
      SourceRefSchema.parse({ commit: "", path: "wiki/x.md" }),
    ).toThrow();
  });

  test("rejects unknown keys (strict object shape)", () => {
    expect(() =>
      SourceRefSchema.parse({
        commit: "abc",
        path: "wiki/x.md",
        extra: "nope",
      }),
    ).toThrow();
  });
});

describe("sourceRef constructor", () => {
  test("returns a frozen object", () => {
    const ref = sourceRef({
      commit: commitOid("abc"),
      path: "wiki/x.md",
    });
    expect(Object.isFrozen(ref)).toBe(true);
  });

  test("only sets optional fields when defined (no `key: undefined`)", () => {
    const ref = sourceRef({
      commit: commitOid("abc"),
      path: "wiki/x.md",
    });
    expect("blob" in ref).toBe(false);
    expect("range" in ref).toBe(false);
    expect("stableId" in ref).toBe(false);
  });

  test("sets optional fields when provided", () => {
    const ref = sourceRef({
      commit: commitOid("abc"),
      path: "wiki/x.md",
      blob: blobOid("deadbeef"),
      stableId: "task-7",
    });
    expect(ref.blob).toBe(blobOid("deadbeef"));
    expect(ref.stableId).toBe("task-7");
  });
});

describe("OID brand helpers", () => {
  test("commitOid brands a string compatible with CommitOid", () => {
    const c: CommitOid = commitOid("abc");
    // Branded type carries the runtime string value; structural narrowing.
    expect(c as string).toBe("abc");
  });

  test("blobOid brands a string compatible with BlobOid", () => {
    const b: BlobOid = blobOid("abc");
    expect(b as string).toBe("abc");
  });

  test("treeOid brands a string compatible with TreeOid", () => {
    const t: TreeOid = treeOid("abc");
    expect(t as string).toBe("abc");
  });
});
