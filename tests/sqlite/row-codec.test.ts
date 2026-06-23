import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { rowCodec } from "../../src/sqlite/row-codec";

// A synthetic raw row covering every reader-kind's source column.
type Raw = {
  readonly id: string;
  readonly nickname: string | null;
  readonly input_commit: string;
  readonly output_commit: string | null;
  readonly phase: string;
  readonly tags_json: string;
  readonly first: string;
  readonly second: string;
};

const RAW: Raw = {
  id: "run-1",
  nickname: null,
  input_commit: "abc",
  output_commit: "def",
  phase: "adoption",
  tags_json: '["x","y"]',
  first: "a",
  second: "b",
};

const t = rowCodec<Raw>("ledger.runs");

describe("col — passthrough", () => {
  test("copies the named column verbatim", () => {
    expect(t.col("id")(RAW, { table: "ledger.runs" })).toBe("run-1");
  });

  test("passes a null column value through unchanged", () => {
    expect(t.col("nickname")(RAW, { table: "ledger.runs" })).toBeNull();
  });
});

describe("brand — transform a non-null column", () => {
  test("applies the branding function to the column value", () => {
    const read = t.brand("input_commit", (v) => `oid:${v}`);
    expect(read(RAW, { table: "ledger.runs" })).toBe("oid:abc");
  });
});

describe("nullableBrand — null-guarded transform", () => {
  test("returns null when the column is null", () => {
    const read = t.nullableBrand("nickname", (v) => `name:${v}`);
    expect(read(RAW, { table: "ledger.runs" })).toBeNull();
  });

  test("applies the function when the column is present", () => {
    const read = t.nullableBrand("output_commit", (v) => `oid:${v}`);
    expect(read(RAW, { table: "ledger.runs" })).toBe("oid:def");
  });
});

describe("enumCol — narrow to a closed set", () => {
  const PHASES = ["adoption", "garden", "view"] as const;

  test("returns the value when it is a member", () => {
    expect(t.enumCol("phase", PHASES)(RAW, { table: "ledger.runs" })).toBe(
      "adoption",
    );
  });

  test("throws a table-and-column-qualified error on a corrupt value", () => {
    const read = t.enumCol("phase", PHASES);
    const corrupt: Raw = { ...RAW, phase: "bogus" };
    expect(() => read(corrupt, { table: "ledger.runs" })).toThrow(
      /ledger\.runs\.phase/,
    );
  });
});

describe("jsonCol — parse, validate, freeze", () => {
  const TagsSchema = z.array(z.string());

  test("parses valid JSON into the schema's output type", () => {
    const read = t.jsonCol("tags_json", TagsSchema);
    expect(read(RAW, { table: "ledger.runs" })).toEqual(["x", "y"]);
  });

  test("freezes the parsed value", () => {
    const read = t.jsonCol("tags_json", TagsSchema);
    expect(Object.isFrozen(read(RAW, { table: "ledger.runs" }))).toBe(true);
  });

  test("throws on malformed JSON", () => {
    const read = t.jsonCol("tags_json", TagsSchema);
    const corrupt: Raw = { ...RAW, tags_json: "{not json" };
    expect(() => read(corrupt, { table: "ledger.runs" })).toThrow(
      /invalid JSON/,
    );
  });

  test("throws when the parsed JSON fails the schema", () => {
    const read = t.jsonCol("tags_json", TagsSchema);
    const corrupt: Raw = { ...RAW, tags_json: "[1,2,3]" };
    expect(() => read(corrupt, { table: "ledger.runs" })).toThrow(/validation/);
  });
});

describe("custom — read the whole row for composite fields", () => {
  test("builds a value from more than one column", () => {
    const read = t.custom((row) => `${row.first}/${row.second}`);
    expect(read(RAW, { table: "ledger.runs" })).toBe("a/b");
  });

  test("receives the reader context so it can qualify its own labels", () => {
    const read = t.custom((_row, ctx) => ctx.table);
    expect(read(RAW, { table: "ledger.runs" })).toBe("ledger.runs");
  });
});

describe("define — assemble readers into a frozen domain row", () => {
  type Domain = {
    readonly id: string;
    readonly inputCommit: string;
    readonly outputCommit: string | null;
    readonly tags: ReadonlyArray<string>;
  };

  const TagsSchema = z.array(z.string());

  const codec = t.define<Domain>({
    id: t.col("id"),
    inputCommit: t.brand("input_commit", (v) => `oid:${v}`),
    outputCommit: t.nullableBrand("output_commit", (v) => `oid:${v}`),
    tags: t.jsonCol("tags_json", TagsSchema),
  });

  test("maps a raw row to the declared domain shape", () => {
    expect(codec(RAW)).toEqual({
      id: "run-1",
      inputCommit: "oid:abc",
      outputCommit: "oid:def",
      tags: ["x", "y"],
    });
  });

  test("freezes the produced domain row", () => {
    expect(Object.isFrozen(codec(RAW))).toBe(true);
  });

  test("threads the table name into reader error labels", () => {
    const corrupt: Raw = { ...RAW, tags_json: "{bad" };
    expect(() => codec(corrupt)).toThrow(/ledger\.runs\.tags_json/);
  });
});
