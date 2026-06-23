import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { validateStructuredRun } from "../../src/surface/adapter";

const payload = z.object({ n: z.number() });
const expected = { viewName: "v.test", schemaTag: "v.test/v1", payload };

describe("validateStructuredRun (generic payload)", () => {
  test("parses a valid payload to the typed value", () => {
    const r = validateStructuredRun(
      { views: [{ name: "v.test" }], structured: { schema: "v.test/v1", data: { n: 7 } } },
      expected,
    );
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.data.n).toBe(7);
  });

  test("a payload that fails the schema is an invalid-payload problem", () => {
    const r = validateStructuredRun(
      { views: [{ name: "v.test" }], structured: { schema: "v.test/v1", data: { n: "nope" } } },
      expected,
    );
    expect(r.kind).toBe("problem");
    if (r.kind === "problem") expect(r.problem.kind).toBe("invalid-payload");
  });

  test("schemaTag mismatch is still wrong-schema, not invalid-payload", () => {
    const r = validateStructuredRun(
      { views: [{ name: "v.test" }], structured: { schema: "v.test/v2", data: { n: 1 } } },
      expected,
    );
    expect(r.kind).toBe("problem");
    if (r.kind === "problem") expect(r.problem.kind).toBe("wrong-schema");
  });
});
