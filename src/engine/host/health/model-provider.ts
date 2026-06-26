// engine/host/health/model-provider: model-provider preflight probes
// (missing grant, unreachable probe, missing key).
import type { Capability } from "../../../core/processor";
import type { ProcessorRegistry } from "../../../processors/registry";
import { capabilityKinds } from "./capability";
import type { HealthFinding, ModelProviderProbeInput } from "./types";

export function modelProviderFindings(opts: {
  readonly registry: ProcessorRegistry;
  readonly resolveGrants: (processorId: string) => ReadonlyArray<Capability>;
  readonly modelProviderConfigured: boolean;
}): ReadonlyArray<HealthFinding> {
  if (opts.modelProviderConfigured) return Object.freeze([]);

  const processorIds = [...opts.registry.all()]
    .filter((processor) =>
      capabilityKinds(processor.capabilities).has("model.invoke") &&
      capabilityKinds(opts.resolveGrants(processor.id)).has("model.invoke"),
    )
    .map((processor) => processor.id)
    .sort();
  if (processorIds.length === 0) return Object.freeze([]);

  return Object.freeze([
    Object.freeze({
      code: "model.provider-missing" as const,
      severity: "warning" as const,
      subject: "config" as const,
      id: "model_provider" as const,
      message:
        `${processorIds.length} enabled processor(s) can invoke models, ` +
        "but no model provider is configured for this vault.",
      recovery:
        "Configure model_provider in .dome/config.yaml, run the host with an " +
        "injected ModelProvider, or disable the model-capable bundle until " +
        "the provider is ready.",
      model: Object.freeze({
        processorIds: Object.freeze(processorIds),
      }),
    }),
  ]);
}

/**
 * Translate a doctor-side provider probe into findings. Per
 * docs/wiki/specs/cli.md §"dome doctor":
 *
 * - `responsive` with `keyPresent: false` → `model.provider-key-missing`
 *   (warning) — reachability and credential presence are reported
 *   separately.
 * - `spawn-failed` / `invalid-response` / `timed-out` →
 *   `model.provider-unreachable` (error).
 * - `responsive` with key present and `probe-unsupported` (a pre-probe
 *   provider that started, read the envelope, and returned a well-formed
 *   error) → no finding.
 */
export function modelProviderProbeFindings(
  probe: ModelProviderProbeInput,
): ReadonlyArray<HealthFinding> {
  const command = Object.freeze([...probe.command]);
  const result = probe.result;
  if (
    result.status === "spawn-failed" ||
    result.status === "invalid-response" ||
    result.status === "timed-out"
  ) {
    return Object.freeze([
      Object.freeze({
        code: "model.provider-unreachable" as const,
        severity: "error" as const,
        subject: "config" as const,
        id: "model_provider" as const,
        message:
          `The configured model provider command (${command.join(" ")}) ` +
          `failed the dome.model-provider.probe/v1 probe: ` +
          `${result.status} — ${result.detail}`,
        recovery:
          "Run the command manually from the vault root with a probe " +
          'envelope (echo \'{"schema":"dome.model-provider.probe/v1"}\' | ' +
          "<command>) to reproduce, fix the script or the model_provider " +
          "command in .dome/config.yaml, then re-run `dome doctor`.",
        model: Object.freeze({
          command,
          probeStatus: result.status,
          detail: result.detail,
        }),
      }),
    ]);
  }
  if (result.status === "responsive" && result.keyPresent === false) {
    return Object.freeze([
      Object.freeze({
        code: "model.provider-key-missing" as const,
        severity: "warning" as const,
        subject: "config" as const,
        id: "model_provider" as const,
        message:
          `The configured model provider command (${command.join(" ")}) is ` +
          "spawnable and probe-responsive, but reports its credential " +
          "environment variable is not set" +
          (result.provider === undefined
            ? "."
            : ` (provider: ${result.provider}).`),
        recovery:
          "Export the provider's API key (ANTHROPIC_API_KEY for the shipped " +
          "anthropic template) in the environment that runs `dome serve` / " +
          "`dome sync` — for a `dome install`ed daemon that means the " +
          "launchd service environment — then re-run `dome doctor`.",
        model: Object.freeze({
          command,
          ...(result.provider !== undefined
            ? { provider: result.provider }
            : {}),
        }),
      }),
    ]);
  }
  return Object.freeze([]);
}

/**
 * Mirrored-config check for the daily note path. `dome.agent.brief` resolves
 * the daily note from `extensions.dome.agent.config.daily_path` while
 * `dome.daily.create-daily` reads `extensions.dome.daily.config.daily_path`
 * — a vault overriding only one gets a wrong-path morning brief plus a
 * duplicate skeleton at 06:00. When both bundles are enabled, the two keys
 * must agree (both unset = both on the shared default = fine). The engine
 * compares the raw config values — it deliberately does not know the
 * bundles' default template, only that divergent keys diverge.
 */
