import { describe, expect, test } from "bun:test";

import { isHomeUpgradeVersionAdvance } from "../../src/product-host/home-upgrade-version";

describe("Home upgrade version ordering", () => {
  test("uses strict SemVer precedence including prereleases", () => {
    expect(isHomeUpgradeVersionAdvance("1.0.0-alpha.1", "1.0.0-alpha.2")).toBeTrue();
    expect(isHomeUpgradeVersionAdvance("1.0.0-alpha.2", "1.0.0")).toBeTrue();
    expect(isHomeUpgradeVersionAdvance("1.0.0", "1.0.1-alpha.1")).toBeTrue();
    expect(isHomeUpgradeVersionAdvance("1.0.0+old", "1.0.1+build.2")).toBeTrue();
    expect(isHomeUpgradeVersionAdvance("1.0.1-alpha.1+old", "1.0.1-alpha.2+build.2")).toBeTrue();
    expect(isHomeUpgradeVersionAdvance("1.0.0", "1.0.0-beta.1")).toBeFalse();
    expect(isHomeUpgradeVersionAdvance("1.0.0+old", "1.0.0+new")).toBeFalse();
  });

  test("rejects malformed versions on either side", () => {
    for (const malformed of ["v1.0.1", "=1.0.1", "01.0.1", "1.0.0-01", " 1.0.1", "1.0.1 "]) {
      expect(isHomeUpgradeVersionAdvance(malformed, "2.0.0")).toBeFalse();
      expect(isHomeUpgradeVersionAdvance("1.0.0", malformed)).toBeFalse();
    }
  });
});
