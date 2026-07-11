// dome.agent per-processor model routing — resolve
// `extensions.dome.agent.config.model_overrides` (a map of processor key →
// model string) and inject the resolved model into every `step()` call.
//
// Same degrade-not-crash config idiom as `garden_targets`: malformed input
// falls back to the default (here: no
// model field, i.e. the provider's default model) with a `problem` string the
// processor surfaces as the `dome.agent.model-config-invalid` warning
// diagnostic. Config must never crash a nightly run.
//
// The override rides the existing provider-neutral `step({ model })` field —
// nothing engine-side changes. The engine's model-allowlist machinery still
// gates the value: with no `modelAllowlist` on the declared/granted
// `model.invoke` capability (the dome.agent manifest declares none) the
// model flows through; a vault grant that DOES declare an allowlist denies
// out-of-list overrides at call time (routing cannot bypass the allowlist).
//
// Note for vault owners: switching models mid-day invalidates the provider's
// prompt cache per model, and per-model output quality is the owner's call —
// routing ships unset by default (see the runbook's recommendations).

import type { ModelStepFn } from "./agent-loop";

/** The routable agent processors, keyed by short name in config. */
export const MODEL_OVERRIDE_KEYS = Object.freeze([
  "ingest",
  "garden",
  "brief",
] as const);

export type ModelOverrideKey = (typeof MODEL_OVERRIDE_KEYS)[number];

export type ModelOverrideResolution = {
  /** The model to pass on every step() call; undefined → omit the field
   * (the provider's default model). */
  readonly model: string | undefined;
  /**
   * Non-null when a malformed config value was ignored in favor of the
   * default — the caller surfaces it as a `dome.agent.model-config-invalid`
   * warning diagnostic.
   */
  readonly problem: string | null;
};

const NONE = Object.freeze({ model: undefined, problem: null });

/**
 * Resolve the model override for one agent processor from
 * `extensions.dome.agent.config.model_overrides[key]`. Unset → no model
 * field (provider default); malformed map or entry → default + problem.
 */
export function resolveModelOverride(
  config: Readonly<Record<string, unknown>> | undefined,
  key: ModelOverrideKey,
): ModelOverrideResolution {
  const raw = config?.model_overrides;
  if (raw === undefined) return NONE;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return Object.freeze({
      model: undefined,
      problem:
        "dome.agent config model_overrides must be an object mapping " +
        `{${MODEL_OVERRIDE_KEYS.join("|")}} to model strings; ` +
        "ignoring it (provider default model)",
    });
  }
  const entry = (raw as Record<string, unknown>)[key];
  if (entry === undefined) return NONE;
  if (typeof entry !== "string" || entry.trim().length === 0) {
    return Object.freeze({
      model: undefined,
      problem:
        `dome.agent config model_overrides.${key} must be a non-empty ` +
        "model string; ignoring it (provider default model)",
    });
  }
  return Object.freeze({ model: entry.trim(), problem: null });
}

/**
 * Wrap a model-step function so every call carries the resolved model.
 * With no override the original function is returned unchanged — the step
 * input then omits `model` and the provider uses its default.
 */
export function withStepModel(
  step: ModelStepFn,
  model: string | undefined,
): ModelStepFn {
  if (model === undefined) return step;
  return (input) => step({ ...input, model });
}
