import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { PWA_OPTIONS } from "../vite.config";

describe("generated PWA policy", () => {
  test("keeps update activation explicit and caches no runtime documents", () => {
    expect(PWA_OPTIONS.registerType).toBe("prompt");
    expect(PWA_OPTIONS.injectRegister).toBe(false);
    expect(PWA_OPTIONS.workbox.runtimeCaching).toEqual([]);
    expect(PWA_OPTIONS.workbox.navigateFallback).toBe("/index.html");
    expect(PWA_OPTIONS.workbox.navigateFallbackAllowlist.map(String)).toEqual(["/^\\/$/"]);
    expect(PWA_OPTIONS.manifest).toMatchObject({
      id: "/",
      lang: "en",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#111111",
      theme_color: "#111111",
    });
    expect(PWA_OPTIONS.manifest.icons).toEqual([
      { src: "pwa-64x64.png", sizes: "64x64", type: "image/png", purpose: "any" },
      { src: "pwa-192x192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "pwa-512x512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "maskable-icon-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ]);
    expect(PWA_OPTIONS.workbox.globPatterns).toEqual([
      "**/*.{js,css,html}",
      "favicon.ico",
      "dome.svg",
      "apple-touch-icon-180x180.png",
    ]);
  });

  test("tracks the exact generated install assets at their declared dimensions", async () => {
    const expected = new Map([
      ["pwa-64x64.png", { dimensions: [64, 64], opaque: false }],
      ["pwa-192x192.png", { dimensions: [192, 192], opaque: false }],
      ["pwa-512x512.png", { dimensions: [512, 512], opaque: false }],
      ["maskable-icon-512x512.png", { dimensions: [512, 512], opaque: true }],
      ["apple-touch-icon-180x180.png", { dimensions: [180, 180], opaque: true }],
    ] as const);
    for (const [name, contract] of expected) {
      const bytes = await readFile(join(import.meta.dir, "..", "public", name));
      expect(bytes.byteLength).toBeGreaterThan(24);
      expect(Array.from(bytes.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([...contract.dimensions]);
      expect(!pngHasChunk(bytes, "tRNS")).toBe(contract.opaque);
    }
    const svg = await readFile(join(import.meta.dir, "..", "public", "dome.svg"), "utf8");
    expect(svg).toContain('viewBox="0 0 512 512"');
    expect(svg).toContain('fill="#111111"');
    expect(svg).toContain('stroke="#c8f0d8"');
    expect(svg).toContain('<rect width="512" height="512" fill="#111111"/>');
    const generator = await readFile(join(import.meta.dir, "..", "pwa-assets.config.mjs"), "utf8");
    expect(generator).toContain('background: "#111111"');
    expect(generator.match(/padding: 0,/g)).toHaveLength(2);
    expect((await readFile(join(import.meta.dir, "..", "public", "favicon.ico"))).byteLength)
      .toBeGreaterThan(100);
  });
});

function pngHasChunk(bytes: Buffer, expected: string): boolean {
  let offset = 8;
  while (offset + 12 <= bytes.byteLength) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === expected) return true;
    offset += 12 + length;
  }
  return false;
}
