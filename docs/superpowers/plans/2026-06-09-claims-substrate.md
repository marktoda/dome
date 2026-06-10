---
type: plan
tags:
  - claims
  - implementation-plan
created: 2026-06-09
updated: 2026-06-09
status: ready
sources:
  - "[[cohesive/brainstorms/2026-06-09-meaning-consolidation-claims-and-sweeper]]"
---

# Claims Substrate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `dome.claims` first-party bundle — a vault-general claim-line grammar (`**Key:** value ^c-anchor`), a deterministic garden-phase anchor stamper, and a deterministic adoption-phase indexer that projects claims into facts — per the approved design at `docs/cohesive/brainstorms/2026-06-09-meaning-consolidation-claims-and-sweeper.md`.

**Architecture:** Mirrors the shipped `dome.daily` task substrate exactly: a pure shared grammar module (like `daily-shared.ts`), a garden-phase `patch.auto` stamper (like `stamp-block-id.ts` — garden, not adoption, because a capability-denied auto-patch in adoption becomes a blocking diagnostic), and an adoption-phase `graph.write` indexer (like `task-index.ts`). One deliberate delta from the design doc: the doc said both processors run in adoption; shipped precedent (`dome.daily.stamp-block-id`) runs stampers in garden with a documented rationale — we follow the precedent. **Claim anchor identity hashes the key, not the value** (supersession = same anchor, new value), unlike task anchors which hash the body.

**Tech Stack:** TypeScript on Bun, `bun test`, existing SDK primitives (`defineProcessorImplementation`, `patchEffect`, `factEffect`, `src/core/block-anchor.ts`).

**Worktree:** `.claude/worktrees/claims-sweeper` (branch `worktree-claims-sweeper`), based on local `main`.

**Verify the environment first:** `bun test tests/processors/daily-stamp-block-id.test.ts` should pass before you start.

---

### Task 1: Claim grammar — pure parser module

**Files:**
- Create: `assets/extensions/dome.claims/processors/claims-shared.ts`
- Test: `tests/processors/claims-grammar.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/processors/claims-grammar.test.ts
import { describe, expect, test } from "bun:test";

import { claimsFromMarkdown } from "../../assets/extensions/dome.claims/processors/claims-shared";

describe("claimsFromMarkdown", () => {
  test("parses a bulleted claim line with anchor, as-of date, and wikilinks", () => {
    const content = [
      "# Alice",
      "",
      "- **Level:** UNI-4 Engineering Manager — approved 2026-05 ([[wiki/sources/alice-promo-doc]]) ^c1a2b3c4d",
      "- **Pod managed:** [[wiki/entities/protocol-growth-pod]] *(as of 2026-05-22)*",
      "",
    ].join("\n");
    const claims = claimsFromMarkdown(content);
    expect(claims).toHaveLength(2);
    expect(claims[0]).toMatchObject({
      line: 3,
      key: "Level",
      anchor: "c1a2b3c4d",
      asOf: null,
    });
    expect(claims[0]!.value).toContain("UNI-4 Engineering Manager");
    expect(claims[0]!.value).not.toContain("^c1a2b3c4d");
    expect(claims[1]).toMatchObject({
      line: 4,
      key: "Pod managed",
      anchor: null,
      asOf: "2026-05-22",
    });
  });

  test("parses an un-bulleted bold-key line (the existing Profile convention)", () => {
    const content = "**Tenure at Uniswap:** ~5 years (one of the longest-tenured)\n";
    const claims = claimsFromMarkdown(content);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ key: "Tenure at Uniswap" });
  });

  test("requires the bold key to open the line: mid-paragraph bold is not a claim", () => {
    const content = "She said **Level:** matters a lot in prose.\n";
    expect(claimsFromMarkdown(content)).toHaveLength(0);
  });

  test("ignores lines inside fenced code blocks", () => {
    const content = [
      "```md",
      "- **Level:** example inside a fence",
      "```",
    ].join("\n");
    expect(claimsFromMarkdown(content)).toHaveLength(0);
  });

  test("ignores blockquoted lines (quoted material is never a claim)", () => {
    const content = "> - **Level:** quoted from somewhere\n";
    expect(claimsFromMarkdown(content)).toHaveLength(0);
  });

  test("ignores YAML frontmatter", () => {
    const content = ["---", "type: entity", "---", "", "- **Status:** live", ""].join("\n");
    const claims = claimsFromMarkdown(content);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ line: 5, key: "Status" });
  });

  test("skips bold-key lines with an empty value or empty key", () => {
    expect(claimsFromMarkdown("- **Level:**\n")).toHaveLength(0);
    expect(claimsFromMarkdown("- **:** something\n")).toHaveLength(0);
  });

  test("bold emphasis without a trailing colon is not a claim", () => {
    expect(claimsFromMarkdown("**Important** this is just emphasis\n")).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/processors/claims-grammar.test.ts`
Expected: FAIL — `Cannot find module '../../assets/extensions/dome.claims/processors/claims-shared'`

- [ ] **Step 3: Write the parser**

```typescript
// assets/extensions/dome.claims/processors/claims-shared.ts
// dome.claims — the pure claim-line grammar, shared by stamp and index.
//
// A claim line is, on any page: optional list bullet, a line-opening
// `**Key:**` bold prefix, then a non-empty value (wikilinks welcome), an
// optional `*(as of YYYY-MM-DD)*` marker, and an optional trailing
// `^c…` block anchor. Lines inside YAML frontmatter, fenced code blocks,
// and blockquotes are never claims, so quoted material can't be
// over-anchored. Pure (string-only, no IO) like daily-shared's extractors.

import { createHash } from "node:crypto";

import {
  appendBlockAnchor,
  parseBlockAnchor,
} from "../../../../src/core/block-anchor";

export type ClaimLine = {
  /** 1-based line number in the document. */
  readonly line: number;
  /** The key exactly as written (untrimmed of internal spacing). */
  readonly key: string;
  /** The value text with any trailing block anchor removed. */
  readonly value: string;
  /** The `*(as of YYYY-MM-DD)*` date when present. */
  readonly asOf: string | null;
  /** The trailing block-anchor id when present. */
  readonly anchor: string | null;
};

/** Optional indent + optional bullet, then a line-opening `**Key:**` + value. */
const CLAIM_LINE_RE = /^(\s*(?:[-*]\s+)?)\*\*([^*\n]+):\*\*\s+(\S.*)$/;
const AS_OF_RE = /\*\(as of (\d{4}-\d{2}-\d{2})\)\*/;

export function claimsFromMarkdown(
  content: string,
): ReadonlyArray<ClaimLine> {
  const lines = content.split(/\r?\n/);
  const excluded = excludedLineFlags(lines);
  const claims: ClaimLine[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (excluded[i] === true) continue;
    const raw = lines[i] ?? "";
    if (raw.trimStart().startsWith(">")) continue;
    const anchored = parseBlockAnchor(raw);
    const body = anchored === null ? raw : anchored.withoutAnchor;
    const match = CLAIM_LINE_RE.exec(body);
    if (match === null) continue;
    const key = (match[2] ?? "").trim();
    const value = (match[3] ?? "").trim();
    if (key.length === 0 || value.length === 0) continue;
    claims.push(
      Object.freeze({
        line: i + 1,
        key,
        value,
        asOf: AS_OF_RE.exec(value)?.[1] ?? null,
        anchor: anchored?.id ?? null,
      }),
    );
  }
  return Object.freeze(claims);
}

/**
 * Per-line exclusion flags for YAML frontmatter and fenced code blocks.
 * Fence open/close lines are themselves excluded; ``` and ~~~ fences must
 * close with their own marker.
 */
function excludedLineFlags(lines: ReadonlyArray<string>): boolean[] {
  const flags = new Array<boolean>(lines.length).fill(false);
  let inFrontmatter = lines[0]?.trim() === "---";
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (inFrontmatter) {
      flags[i] = true;
      if (i > 0 && line.trim() === "---") inFrontmatter = false;
      continue;
    }
    const fenceMatch = /^[ ]{0,3}(```|~~~)/.exec(line);
    if (fence !== null) {
      flags[i] = true;
      if (fenceMatch !== null && fenceMatch[1] === fence) fence = null;
      continue;
    }
    if (fenceMatch !== null) {
      flags[i] = true;
      fence = fenceMatch[1] ?? null;
    }
  }
  return flags;
}

/** Lowercased, whitespace-collapsed key — the identity component. */
export function normalizeClaimKey(key: string): string {
  return key.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Deterministic, collision-resistant block-anchor id for a claim line. The
 * `c` prefix namespaces claim anchors away from task (`t`) and hand-authored
 * anchors. Identity hashes the normalized path, the **normalized key**, and
 * the key's occurrence index within the file — never the value, because
 * supersession edits the value in place under the same anchor.
 */
export function claimAnchorId(input: {
  readonly path: string;
  readonly key: string;
  readonly occurrence: number;
}): string {
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        input.path.replace(/^\.\//, ""),
        normalizeClaimKey(input.key),
        input.occurrence,
      ]),
    )
    .digest("hex")
    .slice(0, 8);
  return `c${hash}`;
}

/**
 * Stamp a stable `^c…` anchor onto every claim line that lacks one,
 * returning the rewritten document — or `null` when nothing needs stamping
 * (the idempotent fixed point). Occurrence counting includes already-anchored
 * claims so a later re-run assigns the same ids it would have on first sight.
 */
export function stampClaimAnchors(input: {
  readonly path: string;
  readonly content: string;
}): string | null {
  const lines = input.content.split(/\r?\n/);
  const occurrences = new Map<string, number>();
  let changed = false;
  for (const claim of claimsFromMarkdown(input.content)) {
    const keyNorm = normalizeClaimKey(claim.key);
    const occurrence = occurrences.get(keyNorm) ?? 0;
    occurrences.set(keyNorm, occurrence + 1);
    if (claim.anchor !== null) continue;
    const idx = claim.line - 1;
    const line = lines[idx];
    if (line === undefined) continue;
    lines[idx] = appendBlockAnchor(
      line,
      claimAnchorId({ path: input.path, key: claim.key, occurrence }),
    );
    changed = true;
  }
  return changed ? lines.join("\n") : null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/processors/claims-grammar.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add assets/extensions/dome.claims/processors/claims-shared.ts tests/processors/claims-grammar.test.ts
git commit -m "feat(dome.claims): pure claim-line grammar — line-opening **Key:** recognizer with fence/quote/frontmatter exclusion"
```

---

### Task 2: Anchor stamping — identity tests

**Files:**
- Test: `tests/processors/claims-stamp.test.ts`
- (Implementation already landed in Task 1's `claims-shared.ts` — this task proves its identity properties, mirroring `tests/processors/daily-stamp-block-id.test.ts`.)

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/processors/claims-stamp.test.ts
import { describe, expect, test } from "bun:test";

import {
  claimAnchorId,
  stampClaimAnchors,
} from "../../assets/extensions/dome.claims/processors/claims-shared";
import { parseBlockAnchor } from "../../src/core/block-anchor";

const PATH = "wiki/entities/alice-henshaw.md";

describe("stampClaimAnchors", () => {
  test("stamps an un-anchored claim and is idempotent", () => {
    const content = "- **Level:** UNI-4 Engineering Manager\n";
    const stamped = stampClaimAnchors({ path: PATH, content });
    expect(stamped).not.toBeNull();
    expect(parseBlockAnchor(stamped!.split("\n")[0]!)?.id).toMatch(/^c[0-9a-f]{8}$/);
    expect(stampClaimAnchors({ path: PATH, content: stamped! })).toBeNull();
  });

  test("identity is keyed by the key, not the value: a value edit keeps the anchor", () => {
    const before = stampClaimAnchors({ path: PATH, content: "- **Pod:** AMM Growth\n" })!;
    const anchor = parseBlockAnchor(before.split("\n")[0]!)!.id;
    // Supersession: edit the value in place, anchor untouched, nothing re-stamps.
    const superseded = before.replace("AMM Growth", "Protocol Growth");
    expect(stampClaimAnchors({ path: PATH, content: superseded })).toBeNull();
    expect(parseBlockAnchor(superseded.split("\n")[0]!)?.id).toBe(anchor);
    // A fresh stamp of the new value at occurrence 0 yields the SAME id.
    expect(claimAnchorId({ path: PATH, key: "Pod", occurrence: 0 })).toBe(anchor);
  });

  test("two same-key claims in one file get distinct anchors", () => {
    const content = "- **Status:** one\n- **Status:** two\n";
    const stamped = stampClaimAnchors({ path: PATH, content })!;
    const ids = stamped
      .split("\n")
      .map((l) => parseBlockAnchor(l)?.id)
      .filter((id): id is string => id !== undefined);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  test("occurrence counting includes already-anchored claims", () => {
    // First claim anchored at occurrence 0; the new second claim must get
    // occurrence 1, not 0 (which would collide).
    const content = [
      `- **Status:** one ^${claimAnchorId({ path: PATH, key: "Status", occurrence: 0 })}`,
      "- **Status:** two",
      "",
    ].join("\n");
    const stamped = stampClaimAnchors({ path: PATH, content })!;
    const secondId = parseBlockAnchor(stamped.split("\n")[1]!)?.id;
    expect(secondId).toBe(claimAnchorId({ path: PATH, key: "Status", occurrence: 1 }));
  });

  test("key normalization: case and spacing do not split identity", () => {
    expect(claimAnchorId({ path: PATH, key: "Pod  Managed", occurrence: 0 })).toBe(
      claimAnchorId({ path: PATH, key: "pod managed", occurrence: 0 }),
    );
  });

  test("returns null for documents with no claims", () => {
    expect(stampClaimAnchors({ path: PATH, content: "# Just prose\n" })).toBeNull();
  });

  test("is deterministic for the same path and content", () => {
    const content = "- **Level:** deterministic\n";
    expect(stampClaimAnchors({ path: PATH, content })).toBe(
      stampClaimAnchors({ path: PATH, content }),
    );
  });
});
```

- [ ] **Step 2: Run tests**

Run: `bun test tests/processors/claims-stamp.test.ts`
Expected: PASS (7 tests — implementation exists from Task 1). If any fail, the implementation has a real bug: fix `claims-shared.ts`, not the test. The most likely failure is occurrence counting — re-read the loop in `stampClaimAnchors`: the counter must advance *before* the `claim.anchor !== null` skip.

- [ ] **Step 3: Commit**

```bash
git add tests/processors/claims-stamp.test.ts
git commit -m "test(dome.claims): anchor identity properties — key-not-value hashing, occurrence stability, idempotent fixed point"
```

---

### Task 3: Bundle manifest + stamp processor

**Files:**
- Create: `assets/extensions/dome.claims/manifest.yaml`
- Create: `assets/extensions/dome.claims/processors/stamp-anchor.ts`

- [ ] **Step 1: Write the stamp processor** (garden phase, exact `stamp-block-id.ts` pattern)

```typescript
// assets/extensions/dome.claims/processors/stamp-anchor.ts
// dome.claims.stamp — stamp stable ^c-anchor identity onto claim lines.
//
// Garden-phase, deterministic, patch.auto — garden, not adoption, for the
// same reason as dome.daily.stamp-block-id: a capability-denied auto-patch
// in adoption becomes a severity:"block" diagnostic that refuses to advance
// the adopted ref; in garden a narrow grant simply skips the stamp. The
// transformation is idempotent, so the garden cascade converges at depth 1.

import {
  patchEffect,
  type Effect,
  type FileChangeInput,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";

import { stampClaimAnchors } from "./claims-shared";

const stampAnchor = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const changes: FileChangeInput[] = [];
    const sourceRefs = [];
    for (const path of ctx.changedPaths.filter((p) => p.endsWith(".md"))) {
      const content = await ctx.snapshot.readFile(path);
      if (content === null) continue;
      const stamped = stampClaimAnchors({ path, content });
      if (stamped === null) continue;
      changes.push({ kind: "write", path, content: stamped });
      sourceRefs.push(ctx.sourceRef(path, { startLine: 1, endLine: 1 }));
    }
    if (changes.length === 0) return [];
    return [
      patchEffect({
        mode: "auto",
        changes,
        reason: "stamp stable ^c-anchor identity onto claim lines",
        sourceRefs,
      }),
    ];
  },
});

export default stampAnchor;
```

- [ ] **Step 2: Write the bundle manifest**

```yaml
# assets/extensions/dome.claims/manifest.yaml
id: dome.claims
version: 0.1.0
processors:
  - id: dome.claims.stamp
    version: 0.1.0
    phase: garden
    triggers:
      - kind: signal
        name: document.changed
        pathPattern: "wiki/**/*.md"
      - kind: signal
        name: file.created
        pathPattern: "wiki/**/*.md"
      - kind: signal
        name: document.changed
        pathPattern: "notes/*.md"
      - kind: signal
        name: file.created
        pathPattern: "notes/*.md"
    capabilities:
      - kind: read
        paths: ["wiki/**/*.md", "notes/*.md"]
      - kind: patch.auto
        paths: ["wiki/**/*.md", "notes/*.md"]
    module: processors/stamp-anchor.ts
```

- [ ] **Step 3: Verify the bundle loads**

Run: `bun test tests/processors/registry.test.ts tests/integration/`
Expected: registry tests PASS. Some integration tests may FAIL on the new bundle (e.g. bundle-matrix-lockstep wants a matrix row, config fixtures may enumerate bundles) — read each failure; matrix/config registration is Task 5, so only proceed past failures that are explicitly about registration coverage, and note them for Task 5. Any *other* failure must be fixed now.

- [ ] **Step 4: Commit**

```bash
git add assets/extensions/dome.claims/manifest.yaml assets/extensions/dome.claims/processors/stamp-anchor.ts
git commit -m "feat(dome.claims): bundle manifest + garden-phase ^c-anchor stamper"
```

---

### Task 4: Claim index processor (adoption → facts)

**Files:**
- Create: `assets/extensions/dome.claims/processors/claim-index.ts`
- Modify: `assets/extensions/dome.claims/manifest.yaml` (append processor entry)
- Test: `tests/processors/claims-index.test.ts`

- [ ] **Step 1: Write the failing test** (the fact-object encoding is pure — test it directly)

```typescript
// tests/processors/claims-index.test.ts
import { describe, expect, test } from "bun:test";

import { claimFactValue } from "../../assets/extensions/dome.claims/processors/claim-index";

describe("claimFactValue", () => {
  test("encodes key, value, and asOf as canonical JSON", () => {
    const encoded = claimFactValue({
      line: 3,
      key: "Pod managed",
      value: "[[wiki/entities/protocol-growth-pod]] *(as of 2026-05-22)*",
      asOf: "2026-05-22",
      anchor: "c1a2b3c4d",
    });
    expect(JSON.parse(encoded)).toEqual({
      key: "Pod managed",
      value: "[[wiki/entities/protocol-growth-pod]] *(as of 2026-05-22)*",
      asOf: "2026-05-22",
    });
  });

  test("omits asOf when absent", () => {
    const encoded = claimFactValue({
      line: 1,
      key: "Level",
      value: "UNI-4",
      asOf: null,
      anchor: null,
    });
    expect(JSON.parse(encoded)).toEqual({ key: "Level", value: "UNI-4" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/processors/claims-index.test.ts`
Expected: FAIL — `Cannot find module '.../claim-index'`

- [ ] **Step 3: Write the index processor** (adoption phase, exact `task-index.ts` pattern)

```typescript
// assets/extensions/dome.claims/processors/claim-index.ts
// dome.claims.index — project claim lines into facts.
//
// Adoption-phase, deterministic, rebuildable: one `dome.claims.claim` fact
// per claim line, object = canonical JSON {key, value, asOf?}, sourceRef
// carrying the line range and (when stamped) the ^c-anchor as stableId.
// The fact value never includes the anchor — the anchor is identity, and it
// already rides the sourceRef; duplicating it into the value would make the
// first post-stamp adoption a spurious value change.

import { factEffect, type Effect } from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";

import { claimsFromMarkdown, type ClaimLine } from "./claims-shared";

const CLAIM_PREDICATE = "dome.claims.claim";

/** Canonical JSON encoding of a claim for the fact object literal. */
export function claimFactValue(claim: ClaimLine): string {
  return JSON.stringify({
    key: claim.key,
    value: claim.value,
    ...(claim.asOf !== null ? { asOf: claim.asOf } : {}),
  });
}

const claimIndex = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const effects: Effect[] = [];
    for (const path of ctx.changedPaths.filter((p) => p.endsWith(".md"))) {
      const content = await ctx.snapshot.readFile(path);
      if (content === null) continue;
      for (const claim of claimsFromMarkdown(content)) {
        const range = { startLine: claim.line, endLine: claim.line };
        const ref =
          claim.anchor !== null
            ? ctx.sourceRef(path, range, claim.anchor)
            : ctx.sourceRef(path, range);
        effects.push(
          factEffect({
            subject: { kind: "page", path },
            predicate: CLAIM_PREDICATE,
            object: { kind: "string", value: claimFactValue(claim) },
            assertion: "extracted",
            sourceRefs: [ref],
          }),
        );
      }
    }
    return Object.freeze(effects);
  },
});

export default claimIndex;
```

- [ ] **Step 4: Append the manifest entry** (triggers mirror `dome.daily.task-index`, including `file.deleted` so the projection clears removed pages)

```yaml
  - id: dome.claims.index
    version: 0.1.0
    phase: adoption
    triggers:
      - kind: signal
        name: document.changed
        pathPattern: "wiki/**/*.md"
      - kind: signal
        name: document.changed
        pathPattern: "notes/*.md"
      - kind: signal
        name: file.created
        pathPattern: "wiki/**/*.md"
      - kind: signal
        name: file.created
        pathPattern: "notes/*.md"
      - kind: signal
        name: file.deleted
        pathPattern: "wiki/**/*.md"
      - kind: signal
        name: file.deleted
        pathPattern: "notes/*.md"
    capabilities:
      - kind: read
        paths: ["wiki/**/*.md", "notes/*.md"]
      - kind: graph.write
        namespaces: ["dome.claims.*"]
    module: processors/claim-index.ts
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/processors/claims-index.test.ts tests/processors/registry.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add assets/extensions/dome.claims/processors/claim-index.ts assets/extensions/dome.claims/manifest.yaml tests/processors/claims-index.test.ts
git commit -m "feat(dome.claims): adoption-phase claim indexer — dome.claims.claim facts with anchor stableIds"
```

---

### Task 5: Registration — default grants + bundle matrix row

**Files:**
- Modify: `src/cli/default-vault-config.ts` (the `extension(...)` list, after the `dome.daily` entry at ~line 42)
- Modify: `docs/wiki/matrices/extension-bundle-shape.md` (add a row to the bundle table; `dome.graph`'s row at line ~40 is the format template)

- [ ] **Step 1: Add the default-config entry** (enabled by default — deterministic and harmless, like `dome.daily`)

```typescript
    extension("dome.claims", true, {
      read: ["wiki/**/*.md", "notes/*.md"],
      "patch.auto": ["wiki/**/*.md", "notes/*.md"],
      "graph.write": ["dome.claims.*"],
    }),
```

- [ ] **Step 2: Add the matrix row**, matching `dome.graph`'s exact column format:

```markdown
| **`dome.claims`** *(first-party)* | `shipped` | — | — | `stamp-anchor.ts`, `claim-index.ts` | — | `read: ["wiki/**/*.md", "notes/*.md"]`; `patch.auto: ["wiki/**/*.md", "notes/*.md"]`; `graph.write: ["dome.claims.*"]` |
```

Place it in the bundle table adjacent to the other first-party rows. Then read the surrounding prose in that file — if the document states a bundle *count*, update it.

- [ ] **Step 3: Run the lockstep + integration suites**

Run: `bun test tests/integration/`
Expected: PASS — in particular `bundle-matrix-lockstep.test.ts` (matrix row ↔ assets agreement) and `bundle-deps.test.ts` (no LLM/MCP imports from the new bundle). If lockstep fails on cell format, read the test's parser and adjust the row to what it asserts — the test is the source of truth for column conventions.

- [ ] **Step 4: Run the full suite**

Run: `bun test`
Expected: PASS. Known pre-existing failures (4 `v1-dogfood-preflight` tests predate this branch — verify by `git stash && bun test <those files> && git stash pop` if unsure) are not yours; anything else is.

- [ ] **Step 5: Commit**

```bash
git add src/cli/default-vault-config.ts docs/wiki/matrices/extension-bundle-shape.md
git commit -m "feat(dome.claims): register bundle — default grants + extension-shape matrix row"
```

---

### Task 6: Spec page

**Files:**
- Create: `docs/wiki/specs/claims.md`
- Modify: `docs/index.md` (add the spec to the specs list, as a wikilink line matching its neighbors)

- [ ] **Step 1: Write the spec page** (repo discipline: the substrate documents every shipped subsystem)

```markdown
---
type: spec
created: 2026-06-09
updated: 2026-06-09
sources:
  - "[[cohesive/brainstorms/2026-06-09-meaning-consolidation-claims-and-sweeper]]"
---

# Claims

A **claim** is a vault-general markdown primitive — like wikilinks and task
blocks — recognized by shape on any page outside `raw/`:

​```markdown
- **<Key>:** <value prose, wikilinks welcome> *(as of YYYY-MM-DD)* ^c<hash>
​```

- The line-opening `**Key:**` bold prefix is the recognizer (after an optional
  list bullet). Lines inside YAML frontmatter, fenced code blocks, and
  blockquotes are never claims, so quoted material can't be over-anchored.
- The `*(as of date)*` marker is optional; omitted dates fall back to coarser
  context (enclosing dated section, git date) at read time.
- The `^c…` anchor is the claim's stable identity, stamped by
  `dome.claims.stamp` (garden, deterministic, idempotent). Identity hashes the
  normalized path + **normalized key** + occurrence index — never the value.
- **Supersession is an in-place value edit under the same anchor.** Git
  history of the block through adopted commits is the bi-temporal store: no
  archive sections, no deletion, "what did I believe in March" is a derived
  view.
- The claim's subject is its **host page**. Relations to other pages ride
  wikilinks in the value, traversable via `dome.graph.links`.

## Processors

| Processor | Phase | Kind | Effect |
|---|---|---|---|
| `dome.claims.stamp` | garden | deterministic, `patch.auto` | Anchors claim lines lacking `^c…` ids; converges at depth 1. |
| `dome.claims.index` | adoption | deterministic, `graph.write dome.claims.*` | One `dome.claims.claim` fact per claim line: object = JSON `{key, value, asOf?}`, sourceRef carries the line range and anchor stableId. |

## Invariant posture

The engine never learns about claims: a markdown convention plus two
deterministic processors. Model processors still emit no durable facts
([[wiki/invariants/MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS]]) — any LLM that
writes claim lines does so as ordinary proposed markdown, and this indexer
extracts the facts from adopted pages, preserving
[[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]].

## Anticipated consumers

The nightly sweeper (`dome.agent.sweep`, planned) supersedes claim values
in place; `dome explain <page>#^c…` (planned) renders a claim's timeline
from block git history; the warden contradiction pre-filter shortlists
same-key/different-value claims across pages.
```

(Remove the zero-width characters around the inner code fence when writing the real file — they exist here only to nest the fence in this plan.)

- [ ] **Step 2: Link it from `docs/index.md`** — find the specs section listing `[[wiki/specs/...]]` entries and add `[[wiki/specs/claims]]` in the same format as its neighbors (read two adjacent lines and match exactly).

- [ ] **Step 3: Run the docs-touching tests**

Run: `bun test tests/integration/`
Expected: PASS (invariant-coverage and matrix lockstep unaffected — no new invariant was declared).

- [ ] **Step 4: Commit**

```bash
git add docs/wiki/specs/claims.md docs/index.md
git commit -m "docs(specs): claims — the vault-general claim-line grammar and its two processors"
```

---

### Task 7: Final verification

- [ ] **Step 1: Full suite + typecheck**

Run: `bun test && bunx tsc --noEmit 2>/dev/null || bun run typecheck`
(Use whichever typecheck script `package.json` defines; if none, `bunx tsc --noEmit`.)
Expected: PASS apart from the 4 documented pre-existing `v1-dogfood-preflight` failures.

- [ ] **Step 2: Manual smoke** — prove the loop end-to-end in a scratch vault:

```bash
cd "$(mktemp -d)" && /Users/mark.toda/dev/dome/.claude/worktrees/claims-sweeper/bin/dome init scratch && cd scratch
printf '# Probe\n\n- **Status:** testing claims\n' > wiki/probe.md
git add wiki/probe.md && git commit -m "probe claim"
/Users/mark.toda/dev/dome/.claude/worktrees/claims-sweeper/bin/dome sync --json
grep -n "\^c" wiki/probe.md          # expect: anchored claim line
/Users/mark.toda/dev/dome/.claude/worktrees/claims-sweeper/bin/dome inspect facts | grep dome.claims  # expect: one claim fact
```

Expected: the claim line gains a `^c[0-9a-f]{8}` anchor after the garden cascade and one `dome.claims.claim` fact appears. If `inspect facts` syntax differs, `dome inspect --help` lists subjects.

- [ ] **Step 3: Report** — summarize commits, test results, and the one deliberate spec delta (stamp runs garden, not adoption) for the final review.

---

## Out of scope for this plan

The sweeper (queue builder, sweep ledger, `dome.agent.sweep`, brief digest) is Plan 2, written after this substrate lands. Enabling `dome.claims` in existing vaults (`~/vaults/work/.dome/config.yaml`, `docs/.dome/config.yaml`) is a deployment step, not a code change — note it in the final report.
