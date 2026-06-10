---
type: linter
created: 2026-06-10
updated: 2026-06-10
status: v1 (implemented)
sources: ["[[wiki/specs/task-lifecycle]]", "[[wiki/specs/autonomous-agents]]", "[[wiki/specs/preferences]]"]
---

# generated-block-splice-guard

**Status:** v1 substrate; the structural fence behind the generated-block grammar primitive at `src/core/generated-block.ts`. The implemented check lives at `tests/integration/generated-block-splice-guard.test.ts`.

**Statement:** Every non-test TypeScript file under `src/` and `assets/extensions/` whose source constructs or matches a generated-block marker (`<!-- <owner>:<block>:start -->` / `<!-- <owner>:<block>:end -->`, owner matching `dome(\.\w+)*`) imports `src/core/generated-block`. The only file allowed to carry marker grammar without importing the primitive is `src/core/generated-block.ts` itself — it *is* the grammar.

## Why this exists

Marker-spliced generated blocks are the seam where model-derived text re-enters human markdown. The same bug class shipped **three times** before this fence existed:

1. **Brief marker smuggling** — a model body smuggled a complete second `dome.agent.brief:questions:start/end` pair; the deterministic questions pass replaced only the first occurrence, so the fabricated block (with fake `dome resolve` hints) landed verbatim in the daily note. Calendar files are untrusted input flowing into that model, so this was a live prompt-injection path.
2. **dome.daily marker injection** — the same body channel could inject `dome.daily:*` markers and corrupt the carry-forward / open-loops regions owned by another processor.
3. **Double-promote rule-text escape** — a preference rule carrying the `dome.agent:promoted-preferences:end` marker text was promoted into `core.md`; the next splice bounded the block with a raw `indexOf`, cut it at the smuggled marker, and leaked rule text outside the generated block as fake owner prose.

Each fix hand-rolled the same two defenses in a different file: (a) **line-anchored scanning** — a marker is a marker only when the entire trimmed line is the marker, so prose/fence mentions and mid-line smuggles never bound a block; and (b) **body sanitization** — model-derived block bodies drop every line carrying a `<!-- dome…` marker comment and strip stray `<!--`/`-->` fragments. A fourth hand-rolled copy would eventually get one of these wrong (the daily blocks bounded with `indexOf` until this migration). The fence makes the grammar single-implementation: any file that needs to *touch* marker text must go through the primitive.

## What it checks

A source scan over:

```
src/**/*.ts                  (excluding *.test.ts)
assets/extensions/**/*.ts    (excluding *.test.ts)
```

A file **handles markers** when its source matches the detection regex:

```ts
const MARKER_HANDLING = new RegExp(
  [
    /:(?:start|end) -->/.source,      // literal or template-string marker construction
    /<!--\s*dome[.:]/.source,         // dome-prefixed comment literals
    /<!--\\s\*dome/.source,           // regex-source forms (e.g. /<!--\s*dome\./)
  ].join("|"),
);
```

This deliberately catches **template-string constructions** (`` `<!-- ${owner}:${block}:start -->` `` still contains `:start -->`) and **regex sources** that match marker comments, not just full literal markers.

Every matching file must import the primitive — an import specifier ending in `core/generated-block` or a relative `./generated-block` (path-relative variants included). Allow-list: `src/core/generated-block.ts` only.

Files must be read as bytes-tolerant text: at least one marker site (`brief-shared.ts`) legitimately contains a NUL byte in a dedup-key template string, which makes naive `grep` treat it as binary — the fence reads files with `readFile(file, "utf8")`, never shells out to grep.

## What the primitive provides

`src/core/generated-block.ts` (pure, zero IO — same class as `src/core/block-anchor.ts`):

- `generatedBlockMarkers(owner, block)` — the only sanctioned marker constructor.
- `findGeneratedBlock(content, owner, block)` — line-anchored scanner; first line-anchored pair wins; anomalies (extra pairs, unterminated start, orphan end) are reported, never silently bound.
- `extractGeneratedBlockBody` / `replaceGeneratedBlock` — built on the same scanner.
- `sanitizeGeneratedBlockBody(body)` — the injection guard: drops any line carrying a `<!-- dome…` marker comment and strips stray bare `<!--`/`-->` fragments that could recombine; returns what was dropped for diagnostics.
- `containsGeneratedBlockMarker` / `containsHtmlCommentDelimiter` — parse-time rejection predicates (the preferences rule).
- `blankGeneratedBlocks` — line-count-preserving block blanking (the search indexer's strip).

## Exempt contexts

1. **`src/core/generated-block.ts`** — the single implementation.
2. **Test files** (`*.test.ts`) — adversarial tests legitimately write raw marker text as fixtures.
3. **Markdown / docs** — the fence sweeps TypeScript source only; specs quote markers freely.
4. Generic `<!--` handling that is not dome-marker-shaped (e.g. skipping arbitrary HTML comments when summarizing prose) does not trip the detection regex and needs no import.

## Related

- [[wiki/specs/task-lifecycle]] §"Generated-block markers" (the normative grammar)
- [[wiki/specs/autonomous-agents]] §"`dome.agent.brief`" (the marker-injection guard, brief blocks)
- [[wiki/specs/preferences]] (parse-time delimiter ban + splice defense in depth)
- [[wiki/specs/vault-layout]] §"`core.md`" (the promoted-preferences generated block)
- [[wiki/linters/processor-purity]] (sister linter; the same convention-as-substrate pattern)
