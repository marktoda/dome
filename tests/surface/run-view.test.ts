import { describe, expect, test } from "bun:test";

import { runInstalledView, viewRunStatus } from "../../src/surface/run-view";

function vaultWith(runView: () => Promise<unknown>) {
  return {
    listViews: () => [
      { command: "custom", processorId: "x.custom", processorVersion: "1", extensionId: "x" },
    ],
    runView,
  } as never;
}

describe("runInstalledView", () => {
  test("renders arbitrary plugin views and preserves their provenance scope", async () => {
    const document = await runInstalledView(
      vaultWith(async () => ({
        kind: "ok",
        structured: null,
        brokerDiagnostics: [],
        views: [{
          kind: "view",
          name: "x.custom",
          content: { kind: "markdown", body: "# Custom" },
          scope: [{ path: "wiki/x.md", commit: "abc" }],
        }],
      })),
      "custom",
      { topic: "x" },
    );

    expect(document.status).toBe("ok");
    if (document.status !== "ok") throw new Error("expected ok");
    expect(document.views[0]).toMatchObject({
      name: "x.custom",
      kind: "markdown",
      scope: [{ path: "wiki/x.md", commit: "abc" }],
    });
    expect(viewRunStatus(document)).toBe(200);
  });

  test("rejects a command not contributed by an installed plugin", async () => {
    const document = await runInstalledView(vaultWith(async () => {
      throw new Error("must not dispatch");
    }), "missing");
    expect(document).toMatchObject({ status: "error", error: "view-not-found" });
    expect(viewRunStatus(document)).toBe(404);
  });
});
