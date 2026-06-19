import { describe, expect, test } from "bun:test";
import { grantedCapabilities, has, type Capability } from "../src/capabilities";

describe("capabilities", () => {
  test("default grant is read/capture/resolve/converse, no author", () => {
    const g = grantedCapabilities({});
    for (const c of ["read", "capture", "resolve", "converse"] as Capability[]) expect(has(g, c)).toBe(true);
    expect(has(g, "author")).toBe(false);
  });
  test("allowWrite adds author", () => {
    expect(has(grantedCapabilities({ allowWrite: true }), "author")).toBe(true);
  });
});
