// Unit coverage for the shared dispatchView core (surface/adapter.ts).
//
// The open-failed branch is tested here directly (fast — a non-vault temp
// dir needs no init/sync). The problem + ok branches are exercised
// end-to-end through every adapter (tests/mcp, tests/http, tests/cli),
// since all three route through dispatchView after the migration.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatchView } from "../../src/surface/adapter";
import type { CatalogViewProblem, ViewRenderer } from "../../src/surface/adapter";
import type { OpenVaultError } from "../../src/vault";
import { FIRST_PARTY_VIEWS } from "../../src/surface/view-catalog";

type Call =
  | { readonly method: "openFailed"; readonly error: OpenVaultError }
  | { readonly method: "problem"; readonly problem: CatalogViewProblem };

function recordingRenderer(): {
  readonly renderer: ViewRenderer<string>;
  readonly calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    renderer: {
      openFailed: (error) => {
        calls.push({ method: "openFailed", error });
        return "OPEN_FAILED";
      },
      problem: (problem) => {
        calls.push({ method: "problem", problem });
        return "PROBLEM";
      },
    },
  };
}

describe("dispatchView", () => {
  test("routes an open failure to renderer.openFailed and returns its envelope", async () => {
    const notAVault = mkdtempSync(join(tmpdir(), "dome-dispatch-"));
    const { renderer, calls } = recordingRenderer();

    const result = await dispatchView(
      { path: notAVault },
      FIRST_PARTY_VIEWS.query,
      Object.freeze({ text: "anything" }),
      renderer,
    );

    expect(result.kind).toBe("rendered");
    if (result.kind === "rendered") {
      expect(result.envelope).toBe("OPEN_FAILED");
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("openFailed");
  });
});
