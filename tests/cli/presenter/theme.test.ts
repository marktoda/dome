import { describe, expect, test } from "bun:test";
import { bold, glyph, paint, statusGlyph } from "../../../src/cli/presenter/theme";

const ASCII = { color: false, unicode: false, width: 80 };
const UNI = { color: false, unicode: true, width: 80 };
const COLOR_UNI = { color: true, unicode: true, width: 80 };

describe("glyph", () => {
  test("unicode caps emit unicode glyphs", () => {
    expect(glyph("ok", UNI)).toBe("✓");
    expect(glyph("err", UNI)).toBe("✗");
    expect(glyph("warn", UNI)).toBe("⚠");
    expect(glyph("pending", UNI)).toBe("○");
    expect(glyph("pointer", UNI)).toBe("→");
    expect(glyph("sep", UNI)).toBe("·");
    expect(glyph("bullet", UNI)).toBe("•");
  });
  test("ascii caps emit ascii fallbacks", () => {
    expect(glyph("ok", ASCII)).toBe("√");
    expect(glyph("err", ASCII)).toBe("x");
    expect(glyph("warn", ASCII)).toBe("!");
    expect(glyph("pointer", ASCII)).toBe(">");
    expect(glyph("sep", ASCII)).toBe("-");
    expect(glyph("bullet", ASCII)).toBe("*");
  });
});

describe("paint", () => {
  test("color:false returns text unchanged", () => {
    expect(paint("hi", "ok", ASCII)).toBe("hi");
  });
  test("color:true wraps with ANSI for a hued tone", () => {
    const out = paint("hi", "ok", COLOR_UNI);
    expect(out).not.toBe("hi");
    expect(out).toContain("hi");
    expect(out).toContain("\x1b["); // contains an ANSI escape
  });
  test("plain tone is never colored", () => {
    expect(paint("hi", "plain", COLOR_UNI)).toBe("hi");
  });
});

describe("statusGlyph", () => {
  test("maps tone to its status glyph name", () => {
    expect(statusGlyph("ok", UNI)).toBe("✓");
    expect(statusGlyph("warn", UNI)).toBe("⚠");
    expect(statusGlyph("err", UNI)).toBe("✗");
    expect(statusGlyph("muted", UNI)).toBe("○");
  });
});

describe("bold", () => {
  test("color:false returns text unchanged", () => {
    expect(bold("hi", { color: false, unicode: true, width: 80 })).toBe("hi");
  });
  test("color:true wraps with ANSI", () => {
    const out = bold("hi", { color: true, unicode: true, width: 80 });
    expect(out).not.toBe("hi");
    expect(out).toContain("hi");
    expect(out).toContain("\x1b[");
  });
});
