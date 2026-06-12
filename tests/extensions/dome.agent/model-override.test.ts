// dome.agent per-processor model routing — the shared config helper.
//
// `extensions.dome.agent.config.model_overrides` maps processor key →
// model string; the resolved model rides the existing provider-neutral
// `step({ model })` field. Same degrade-not-crash idiom as
// consolidate_targets/sweep_targets: malformed values fall back to the
// provider default with a `problem` the processor surfaces as the
// `dome.agent.model-config-invalid` warning. The engine's allowlist
// machinery still gates the value (tests/engine/model-step.test.ts pins
// that: no declared allowlist → flows freely; granted allowlist → denied).

import { describe, expect, test } from "bun:test";

import type { ModelStepFn } from "../../../assets/extensions/dome.agent/lib/agent-loop";
import {
  resolveModelOverride,
  withStepModel,
} from "../../../assets/extensions/dome.agent/lib/model-override";

describe("resolveModelOverride", () => {
  test("unset map / unset key → no model, no problem (provider default)", () => {
    expect(resolveModelOverride(undefined, "ingest")).toEqual({
      model: undefined,
      problem: null,
    });
    expect(resolveModelOverride({}, "ingest")).toEqual({
      model: undefined,
      problem: null,
    });
    expect(
      resolveModelOverride(
        { model_overrides: { consolidate: "claude-sonnet-4-6" } },
        "ingest",
      ),
    ).toEqual({ model: undefined, problem: null });
  });

  test("valid entry resolves (trimmed) for its key only", () => {
    const config = {
      model_overrides: {
        ingest: " claude-haiku-4-5 ",
        sweep: "claude-haiku-4-5",
      },
    };
    expect(resolveModelOverride(config, "ingest").model).toBe(
      "claude-haiku-4-5",
    );
    expect(resolveModelOverride(config, "sweep").problem).toBeNull();
    expect(resolveModelOverride(config, "brief").model).toBeUndefined();
  });

  test("model_overrides that is not an object → default + problem", () => {
    for (const bad of ["claude-haiku-4-5", 42, null, ["claude-haiku-4-5"]]) {
      const res = resolveModelOverride({ model_overrides: bad }, "brief");
      expect(res.model).toBeUndefined();
      expect(res.problem).toContain("model_overrides must be an object");
    }
  });

  test("malformed entry → default + problem naming the key", () => {
    for (const bad of [42, "", "   ", { id: "x" }]) {
      const res = resolveModelOverride(
        { model_overrides: { consolidate: bad } },
        "consolidate",
      );
      expect(res.model).toBeUndefined();
      expect(res.problem).toContain("model_overrides.consolidate");
    }
  });
});

describe("withStepModel", () => {
  test("undefined model returns the original step fn unchanged", () => {
    const step: ModelStepFn = async () => ({ text: "done" });
    expect(withStepModel(step, undefined)).toBe(step);
  });

  test("a resolved model is injected into every step call", async () => {
    const seen: Array<string | undefined> = [];
    const step: ModelStepFn = async (input) => {
      seen.push(input.model);
      return { text: "done" };
    };
    const routed = withStepModel(step, "claude-haiku-4-5");
    await routed({ messages: [], tools: [] });
    await routed({ messages: [], tools: [] });
    expect(seen).toEqual(["claude-haiku-4-5", "claude-haiku-4-5"]);
  });
});
