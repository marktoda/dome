// Deterministic, locale-independent string ordering.
//
// `String.prototype.localeCompare` with no arguments collates through the
// host's default ICU locale, so the relative order of non-ASCII titles,
// task bodies, and emoji-bearing strings can differ across machines and ICU
// versions. Anything that feeds effect output — fact ordering, rendered
// patch content, persisted operational snapshots — must sort identically
// everywhere, or processor idempotency, the fixed-point loop, and rebuild
// equivalence quietly break on the first non-ASCII string.
//
// `compareStrings` orders by UTF-16 code unit (the semantics of `<` / `>`
// on strings): environment-independent, total, and stable. Use it for every
// sort whose result can reach an Effect, a projection row, or a file.
// `tests/integration/deterministic-sort.test.ts` bans bare `localeCompare`
// under `src/` and `assets/extensions/` in favor of this helper.

export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
