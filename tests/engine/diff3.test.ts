import { describe, expect, test } from "bun:test";
import { merge3 } from "../../src/engine/core/diff3";

describe("merge3", () => {
  test("disjoint edits compose cleanly", () => {
    const base = "L1\nL2\nL3\nL4\n";
    const ours = "L1\nOURS\nL3\nL4\n";     // edited line 2
    const theirs = "L1\nL2\nL3\nTHEIRS\n"; // edited line 4
    const r = merge3({ base, ours, theirs });
    expect(r.conflict).toBe(false);
    expect(r.text).toBe("L1\nOURS\nL3\nTHEIRS\n");
  });
  test("identical theirs===base is a no-op merge (keeps ours)", () => {
    const base = "A\nB\n", ours = "A\nX\n", theirs = "A\nB\n";
    const r = merge3({ base, ours, theirs });
    expect(r.conflict).toBe(false);
    expect(r.text).toBe("A\nX\n");
  });
  test("identical ours===base takes theirs (fast-equivalent)", () => {
    const base = "A\nB\n", ours = "A\nB\n", theirs = "A\nY\n";
    const r = merge3({ base, ours, theirs });
    expect(r.conflict).toBe(false);
    expect(r.text).toBe("A\nY\n");
  });
  test("overlapping edits to same line → conflict, resolves to ours", () => {
    const base = "A\nB\nC\n", ours = "A\nOURS\nC\n", theirs = "A\nTHEIRS\nC\n";
    const r = merge3({ base, ours, theirs });
    expect(r.conflict).toBe(true);
    expect(r.text).toBe("A\nOURS\nC\n"); // landed change wins; never reverts
  });
  test("both sides make the identical change → no conflict", () => {
    const base = "A\nB\nC\n", ours = "A\nZ\nC\n", theirs = "A\nZ\nC\n";
    const r = merge3({ base, ours, theirs });
    expect(r.conflict).toBe(false);
    expect(r.text).toBe("A\nZ\nC\n");
  });
  test("disjoint insertions on both sides both land", () => {
    const base = "A\nB\nC\n";
    const ours = "A\nNEW1\nB\nC\n";      // inserted after A
    const theirs = "A\nB\nC\nNEW2\n";    // appended at end
    const r = merge3({ base, ours, theirs });
    expect(r.conflict).toBe(false);
    expect(r.text).toBe("A\nNEW1\nB\nC\nNEW2\n");
  });
  test("empty base, ours adds lines, theirs empty → keeps ours", () => {
    const r = merge3({ base: "", ours: "A\nB\n", theirs: "" });
    expect(r.text).toBe("A\nB\n");
  });

  // Extra edge cases.
  test("deletion on theirs side lands (ours unchanged)", () => {
    const base = "A\nB\nC\n", ours = "A\nB\nC\n", theirs = "A\nC\n";
    const r = merge3({ base, ours, theirs });
    expect(r.conflict).toBe(false);
    expect(r.text).toBe("A\nC\n");
  });
  test("no-newline shape of ours is preserved", () => {
    const base = "A\nB", ours = "A\nX", theirs = "A\nB";
    const r = merge3({ base, ours, theirs });
    expect(r.conflict).toBe(false);
    expect(r.text).toBe("A\nX");
  });
});
