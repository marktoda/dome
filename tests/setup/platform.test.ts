import { describe, expect, test } from "bun:test";

import { setupHostIsSupported } from "../../src/setup/platform";

describe("setup publication host policy", () => {
  test("admits macOS and glibc Linux only", () => {
    expect(setupHostIsSupported({ platform: "darwin", architecture: "arm64", libc: null })).toBeTrue();
    expect(setupHostIsSupported({ platform: "linux", architecture: "x64", libc: "glibc" })).toBeTrue();
    expect(setupHostIsSupported({ platform: "linux", architecture: "x64", libc: "other" })).toBeFalse();
    expect(setupHostIsSupported({ platform: "win32", architecture: "x64", libc: null })).toBeFalse();
  });
});
