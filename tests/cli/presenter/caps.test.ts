import { describe, expect, test } from "bun:test";
import { resolveCaps } from "../../../src/cli/presenter/caps";

describe("resolveCaps", () => {
  const base = { isTTY: true, columns: 120 };

  test("TTY with no NO_COLOR enables color and uses columns", () => {
    const caps = resolveCaps(base, {});
    expect(caps.color).toBe(true);
    expect(caps.width).toBe(120);
  });

  test("NO_COLOR disables color even on a TTY", () => {
    const caps = resolveCaps(base, { NO_COLOR: "1" });
    expect(caps.color).toBe(false);
  });

  test("FORCE_COLOR enables color when not a TTY", () => {
    const caps = resolveCaps({ isTTY: false }, { FORCE_COLOR: "1" });
    expect(caps.color).toBe(true);
  });

  test("FORCE_COLOR exclusions: 0 and false disable color even when set", () => {
    expect(resolveCaps({ isTTY: false }, { FORCE_COLOR: "0" }).color).toBe(false);
    expect(resolveCaps({ isTTY: false }, { FORCE_COLOR: "false" }).color).toBe(false);
  });

  test("non-TTY without FORCE_COLOR disables color and falls back to width 80", () => {
    const caps = resolveCaps({ isTTY: false }, {});
    expect(caps.color).toBe(false);
    expect(caps.width).toBe(80);
  });

  test("unicode requires a TTY and a UTF locale", () => {
    expect(resolveCaps(base, { LANG: "en_US.UTF-8" }).unicode).toBe(true);
    expect(resolveCaps(base, { LANG: "C" }).unicode).toBe(false);
    expect(resolveCaps({ isTTY: false, columns: 120 }, { LANG: "en_US.UTF-8" }).unicode).toBe(false);
  });
});
