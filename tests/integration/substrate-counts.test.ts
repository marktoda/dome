// tests/integration/substrate-counts.test.ts
//
// Lockstep fence for the substrate-count-drift gotcha
// (docs/wiki/gotchas/substrate-count-drift.md): the spelled-out counts in
// normative docs must agree with the canonical const unions in src/core/
// (effect kinds, capability tiers) or with each other (contribution kinds,
// sync-outcome enumerations).

import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { EffectSchema } from "../../src/core/effect";
import { CapabilitySchema } from "../../src/core/processor";

const REPO_ROOT = join(import.meta.dir, "..", "..");

const NUMBER_WORDS: Record<number, string> = {
  5: "five",
  6: "six",
  7: "seven",
  9: "nine",
  10: "ten",
  11: "eleven",
  12: "twelve",
  16: "sixteen",
  17: "seventeen",
  18: "eighteen",
};

const WORD_TO_NUMBER: Record<string, number> = Object.fromEntries(
  Object.entries(NUMBER_WORDS).map(([n, w]) => [w, Number(n)]),
);

async function doc(rel: string): Promise<string> {
  return readFile(join(REPO_ROOT, "docs", rel), "utf8");
}

test("effect kind count: docs match EffectSchema", async () => {
  const word = NUMBER_WORDS[EffectSchema.options.length];
  expect(word, "add the new count to NUMBER_WORDS").toBeDefined();
  expect((await doc("wiki/specs/effects.md")).toLowerCase()).toContain(
    `${word}-kind`,
  );
  expect((await doc("VISION.md")).toLowerCase()).toContain(`${word} kinds`);
  expect((await doc("index.md")).toLowerCase()).toContain(
    `${word}-kind effect taxonomy`,
  );
});

test("capability tier count: docs match CapabilitySchema", async () => {
  const word = NUMBER_WORDS[CapabilitySchema.options.length];
  expect(word, "add the new count to NUMBER_WORDS").toBeDefined();
  expect((await doc("wiki/specs/capabilities.md")).toLowerCase()).toContain(
    `${word} capability tiers`,
  );
  expect((await doc("index.md")).toLowerCase()).toContain(
    `${word} capability tiers`,
  );
});

test("adoption.md sync-outcome label matches its enumeration", async () => {
  const text = await doc("wiki/specs/adoption.md");
  const match = text.match(/The (\w+) outcomes:\n\n((?:- \*\*[^\n]*\n)+)/);
  expect(match, "outcomes section shape changed — update this regex").not.toBeNull();
  if (match === null) return;
  const labeled = WORD_TO_NUMBER[match[1]!.toLowerCase()];
  expect(labeled, `unknown number word '${match[1]}'`).toBeDefined();
  const bullets = match[2]!.trim().split("\n").length;
  expect(labeled).toBe(bullets);
});

test("bundle contribution-kind count agrees across docs", async () => {
  const matrix = (await doc("wiki/matrices/extension-bundle-shape.md")).toLowerCase();
  const canonical = matrix.match(/(\w+) contribution kinds/);
  expect(canonical).not.toBeNull();
  if (canonical === null) return;

  const surface = (await doc("wiki/specs/sdk-surface.md")).toLowerCase();
  const acrossClaim = surface.match(/contributions across (\w+) kinds/);
  expect(acrossClaim, "sdk-surface 'contributions across N kinds' sentence missing").not.toBeNull();
  expect(acrossClaim![1]).toBe(canonical[1]);

  const inlineClaim = surface.match(/the (\w+) contribution kinds/);
  expect(inlineClaim, "sdk-surface 'the N contribution kinds' sentence missing").not.toBeNull();
  expect(inlineClaim![1]).toBe(canonical[1]);
});
