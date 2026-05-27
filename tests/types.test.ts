import { test, expect } from "bun:test";
import { type ToolError } from "../src/types";

test("ToolError supports bundle-load-failure kind with detail discriminator", () => {
  const e: ToolError = {
    kind: "bundle-load-failure",
    detail: "page-type-collision",
    message: "bundle 'a' and 'b' both declare page type 'daily'",
  };
  expect(e.kind).toBe("bundle-load-failure");
  if (e.kind === "bundle-load-failure") {
    expect(e.detail).toBe("page-type-collision");
  }
});
