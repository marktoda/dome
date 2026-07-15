import { describe, expect, test } from "bun:test";

import { PWA_OPTIONS } from "../vite.config";

describe("generated PWA policy", () => {
  test("keeps update activation explicit and caches no runtime documents", () => {
    expect(PWA_OPTIONS.registerType).toBe("prompt");
    expect(PWA_OPTIONS.injectRegister).toBe(false);
    expect(PWA_OPTIONS.workbox.runtimeCaching).toEqual([]);
    expect(PWA_OPTIONS.workbox.navigateFallback).toBe("/index.html");
    expect(PWA_OPTIONS.workbox.navigateFallbackAllowlist.map(String)).toEqual(["/^\\/$/"]);
    expect(PWA_OPTIONS.manifest.icons).toEqual([]);
  });
});
