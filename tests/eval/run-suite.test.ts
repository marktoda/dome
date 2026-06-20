import { describe, expect, test } from "bun:test";
import { runEvalSuite } from "../../src/eval/run-suite";
import type { EvalCase, EvalEnv } from "../../src/eval/types";

const ENV: EvalEnv = {
  modelStepProvider: async (_request) => ({ text: "x" }),
  mode: "hermetic",
  trajectory: [],
};

describe("runEvalSuite", () => {
  test("reports per-case failures, awaits async assertions, survives a throwing run/assertion", async () => {
    const cases: EvalCase<number>[] = [
      { name: "passes", run: async () => 1, assertions: [(o) => (o === 1 ? null : "bad"), async (o) => (o > 0 ? null : "neg")] },
      { name: "fails-sync", run: async () => 2, assertions: [(o) => (o === 1 ? null : `got ${o}`)] },
      { name: "fails-async", run: async () => 3, assertions: [async () => "always"] },
      { name: "run-throws", run: async () => { throw new Error("boom"); }, assertions: [() => null] },
      { name: "assertion-throws", run: async () => 4, assertions: [() => { throw new Error("kaboom"); }] },
    ];
    const report = await runEvalSuite(cases as EvalCase<unknown>[], { env: ENV });
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(4);
    const byName = Object.fromEntries(report.results.map((r) => [r.case, r.failures]));
    expect(byName["passes"]).toEqual([]);
    expect(byName["fails-sync"]).toEqual(["got 2"]);
    expect(byName["fails-async"]).toEqual(["always"]);
    expect(byName["run-throws"]?.[0]).toContain("boom");
    expect(byName["assertion-throws"]?.[0]).toContain("kaboom");
  });
});
