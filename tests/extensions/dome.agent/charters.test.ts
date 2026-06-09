// Charter pins for the supersession convention (memory-quality M2).
//
// The charters are prompts, not code paths, so these pins are deliberately
// loose: they assert each charter carries the load-bearing supersession
// instructions from [[wiki/specs/page-schema]] §"Supersession (ADR
// pattern)" — consolidate proposes status flips instead of rewrites or
// deletes, brief and ingest treat superseded pages as history and follow
// the forward link — without freezing prompt wording.

import { describe, expect, test } from "bun:test";

import { BRIEF_CHARTER } from "../../../assets/extensions/dome.agent/lib/brief-charter";
import { consolidateCharter } from "../../../assets/extensions/dome.agent/lib/consolidate-charter";
import { INGEST_CHARTER } from "../../../assets/extensions/dome.agent/lib/ingest-charter";

describe("dome.agent charters — supersession convention", () => {
  const consolidate = consolidateCharter({
    ledgerPath: "consolidation-ledger.md",
    maxChangedFiles: 30,
  });

  test("consolidate retires absorbed pages with the status flip, not deletePage", () => {
    expect(consolidate).toContain("status: superseded");
    expect(consolidate).toContain("superseded_by");
    expect(consolidate).toContain(
      "Retire each absorbed page with the supersession flip",
    );
    // deletePage survives only for pages that should never have existed.
    expect(consolidate).toContain("never deleted");
    expect(consolidate).not.toContain("`deletePage` each absorbed page");
  });

  test("consolidate documents the ## Superseded section-move for mixed pages", () => {
    expect(consolidate).toContain("## Superseding outdated pages");
    expect(consolidate).toContain("`## Superseded` section");
    expect(consolidate).toContain("one flip + one forward link");
  });

  test("brief never cites superseded pages as current", () => {
    expect(BRIEF_CHARTER).toContain("status: superseded");
    expect(BRIEF_CHARTER).toContain("never cite one as current");
    expect(BRIEF_CHARTER).toContain("superseded_by");
  });

  test("ingest integrates into the forward target, not the superseded page", () => {
    expect(INGEST_CHARTER).toContain("## Superseded pages are history");
    expect(INGEST_CHARTER).toContain("superseded_by");
    expect(INGEST_CHARTER).toContain("Never extend a superseded page");
  });
});
