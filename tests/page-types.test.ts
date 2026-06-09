import { describe, expect, test } from "bun:test";

import { DEFAULT_PAGE_TYPE_REGISTRY } from "../src/page-types";

describe("default page-type registry", () => {
  test("allows common descriptive metadata on default page types", () => {
    expectOptionalFields("entity", [
      "aliases",
      "description",
      "last_interaction",
      "metadata",
      "name",
      "status",
      "superseded_by",
    ]);
    expectOptionalFields("concept", [
      "description",
      "metadata",
      "name",
      "status",
      "superseded_by",
    ]);
    expectOptionalFields("source", [
      "author",
      "captured",
      "description",
      "external",
      "metadata",
      "name",
      "published",
      "status",
      "superseded_by",
      "url",
    ]);
    expectOptionalFields("synthesis", [
      "description",
      "generated_from",
      "input_hash",
      "metadata",
      "name",
      "processor",
      "status",
      "superseded_by",
    ]);
  });
});

function expectOptionalFields(
  typeName: string,
  fields: ReadonlyArray<string>,
): void {
  const schema = DEFAULT_PAGE_TYPE_REGISTRY.types.get(typeName);
  if (schema === undefined) {
    throw new Error(`missing default page type: ${typeName}`);
  }
  for (const field of fields) {
    expect(schema.optional.has(field), `${typeName}.${field}`).toBe(true);
  }
}
