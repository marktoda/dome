// product-host/home-model-provider: resolves Home's model runtime without
// changing vault configuration. The shipped Anthropic command is replaced by
// the closed Keychain helper; custom commands run with an explicit scrubbed
// environment and never receive Dome's Keychain credential.

import { homedir, tmpdir } from "node:os";

import {
  loadCapabilityPolicy,
  type CommandModelProviderConfig,
} from "../engine/core/capability-policy";
import type { ModelProvider, ModelStepProvider } from "../engine/core/model-invoke";
import {
  buildCommandModelProvider,
  buildCommandModelStepProvider,
  probeCommandModelProvider,
  type ModelProviderProbeResult,
} from "../engine/host/command-model-provider";
import { HomeCredentialError, openHomeCredentials, type HomeCredentials } from "./home-credentials";

export const SHIPPED_HOME_MODEL_COMMAND = Object.freeze(["bun", ".dome/model-provider.ts"] as const);
const HOME_MODEL_READINESS_CACHE_MS = 1_000;

export type HomeModelConfiguration = "shipped-anthropic" | "missing" | "custom" | "invalid";

export type HomeModelRuntime = Readonly<{
  configuration: HomeModelConfiguration;
  credential: "present" | "missing" | "locked" | "denied" | "unavailable" | "not-managed";
  modelState: "ready" | "unconfigured" | "unreachable";
  probe: ModelProviderProbeResult | null;
  detail: string | null;
  modelStateResolver?: () => Promise<"ready" | "unconfigured" | "unreachable">;
  modelProvider?: ModelProvider;
  modelStepProvider?: ModelStepProvider;
}>;

export type HomeModelProviderDeps = Readonly<{
  credentials?: HomeCredentials;
  loadPolicy?: typeof loadCapabilityPolicy;
  probe?: typeof probeCommandModelProvider;
  environment?: Record<string, string | undefined>;
  sourceEnvironment?: NodeJS.ProcessEnv;
}>;

export async function resolveHomeModelRuntime(
  vaultPath: string,
  deps: HomeModelProviderDeps = {},
): Promise<HomeModelRuntime> {
  const loaded = await (deps.loadPolicy ?? loadCapabilityPolicy)(vaultPath);
  if (!loaded.ok) {
    return Object.freeze({ configuration: "invalid", credential: "not-managed", modelState: "unreachable", probe: null, detail: loaded.error });
  }
  const configured = loaded.value.runtime.modelProvider;
  if (configured === undefined) {
    return Object.freeze({ configuration: "missing", credential: "not-managed", modelState: "unconfigured", probe: null,
      detail: "vault model_provider is not configured" });
  }
  const shipped = isShippedHomeModelConfig(configured);
  const credentials = deps.credentials ?? openHomeCredentials();
  const modelStateResolver = createManagedModelStateResolver(credentials, vaultPath);
  let runtimeConfig = configured;
  let environment = deps.environment ?? scrubbedProviderEnvironment();
  let managedCommandReady = false;
  if (shipped) {
    try {
      runtimeConfig = Object.freeze({
        kind: "command" as const,
        command: await credentials.modelProviderCommand(vaultPath),
      });
      managedCommandReady = true;
      environment = fixedHelperEnvironment(deps.sourceEnvironment ?? process.env);
      const inspection = await credentials.inspect(vaultPath);
      if (!inspection.present) {
        return Object.freeze({ configuration: "shipped-anthropic", credential: "missing", modelState: "unconfigured", probe: null,
          detail: "model credential is not configured",
          modelStateResolver,
          modelProvider: buildCommandModelProvider(runtimeConfig, { cwd: vaultPath, env: environment }),
          modelStepProvider: buildCommandModelStepProvider(runtimeConfig, { cwd: vaultPath, env: environment }) });
      }
      await credentials.check(vaultPath);
    } catch (error) {
      const code = error instanceof HomeCredentialError ? error.code : "failed";
      const credential = code === "missing" ? "missing" as const
        : code === "locked" ? "locked" as const
          : code === "denied" ? "denied" as const
            : "unavailable" as const;
      return Object.freeze({ configuration: "shipped-anthropic", credential,
        modelState: credential === "missing" ? "unconfigured" : "unreachable", probe: null,
        detail: error instanceof Error ? error.message : String(error),
        modelStateResolver,
        ...(managedCommandReady ? {
          modelProvider: buildCommandModelProvider(runtimeConfig, { cwd: vaultPath, env: environment }),
          modelStepProvider: buildCommandModelStepProvider(runtimeConfig, { cwd: vaultPath, env: environment }),
        } : {}) });
    }
  }
  const probe = await (deps.probe ?? probeCommandModelProvider)(runtimeConfig, {
    cwd: vaultPath,
    env: environment,
  });
  if (shipped && probe.status === "probe-unsupported") {
    const credential = probe.exitCode === 44 ? "missing" as const
      : probe.exitCode === 5 ? "locked" as const
        : probe.exitCode === 3 ? "denied" as const
          : "unavailable" as const;
    return Object.freeze({ configuration: "shipped-anthropic", credential,
      modelState: credential === "missing" ? "unconfigured" : "unreachable", probe,
      detail: probe.detail,
      modelStateResolver,
      modelProvider: buildCommandModelProvider(runtimeConfig, { cwd: vaultPath, env: environment }),
      modelStepProvider: buildCommandModelStepProvider(runtimeConfig, { cwd: vaultPath, env: environment }) });
  }
  const ready = probe.status === "responsive" && (!shipped || probe.keyPresent === true);
  const supportedCustom = !shipped && probe.status === "probe-unsupported";
  const modelState = ready || supportedCustom ? "ready" : "unreachable";
  const detail = probe.status === "responsive" ? null : probe.detail;
  return Object.freeze({
    configuration: shipped ? "shipped-anthropic" : "custom",
    credential: shipped ? "present" : "not-managed",
    modelState,
    probe,
    detail: modelState === "ready" ? null : detail,
    ...(shipped ? { modelStateResolver } : {}),
    modelProvider: buildCommandModelProvider(runtimeConfig, { cwd: vaultPath, env: environment }),
    modelStepProvider: buildCommandModelStepProvider(runtimeConfig, { cwd: vaultPath, env: environment }),
  });
}

async function resolveManagedModelState(
  credentials: HomeCredentials,
  vaultPath: string,
): Promise<"ready" | "unconfigured" | "unreachable"> {
  try {
    await credentials.check(vaultPath);
    return "ready";
  } catch (error) {
    return error instanceof HomeCredentialError && error.code === "missing"
      ? "unconfigured"
      : "unreachable";
  }
}

function createManagedModelStateResolver(
  credentials: HomeCredentials,
  vaultPath: string,
): () => Promise<"ready" | "unconfigured" | "unreachable"> {
  type State = "ready" | "unconfigured" | "unreachable";
  let cached: Readonly<{ value: State; expiresAt: number }> | undefined;
  let inFlight: Promise<State> | undefined;
  return () => {
    const now = performance.now();
    if (cached !== undefined && now < cached.expiresAt) return Promise.resolve(cached.value);
    if (inFlight !== undefined) return inFlight;
    inFlight = (async () => {
      try {
        const value = await resolveManagedModelState(credentials, vaultPath);
        cached = Object.freeze({ value, expiresAt: performance.now() + HOME_MODEL_READINESS_CACHE_MS });
        return value;
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  };
}

export function isShippedHomeModelConfig(config: CommandModelProviderConfig): boolean {
  return config.kind === "command" && config.command.length === 2 &&
    config.command[0] === SHIPPED_HOME_MODEL_COMMAND[0] &&
    config.command[1] === SHIPPED_HOME_MODEL_COMMAND[1];
}

export function scrubbedProviderEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  return Object.freeze({
    HOME: source.HOME ?? homedir(),
    PATH: source.PATH ?? "/usr/bin:/bin",
    TMPDIR: source.TMPDIR ?? tmpdir(),
    ...(source.LANG !== undefined ? { LANG: source.LANG } : {}),
    ...(source.LC_ALL !== undefined ? { LC_ALL: source.LC_ALL } : {}),
  });
}

function fixedHelperEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const settings = [
    "ANTHROPIC_MODEL", "ANTHROPIC_MAX_TOKENS",
    "ANTHROPIC_INPUT_COST_PER_MTOK", "ANTHROPIC_OUTPUT_COST_PER_MTOK",
    "DOME_DISABLE_PROMPT_CACHE",
  ] as const;
  return Object.freeze(Object.fromEntries([
    ["HOME", source.HOME ?? homedir()], ["PATH", "/usr/bin:/bin"], ["TMPDIR", source.TMPDIR ?? tmpdir()],
    ...settings.flatMap((name) => source[name] === undefined ? [] : [[name, source[name]!]]),
  ]));
}
