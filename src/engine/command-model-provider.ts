import { z } from "zod";

import type { CommandModelProviderConfig } from "./capability-policy";
import {
  parseModelProviderResponse,
  parseModelStepResponse,
  type ModelProvider,
  type ModelProviderRequest,
  type ModelProviderResponse,
  type ModelStepProvider,
  type ModelStepRequest,
  type ModelStepResponse,
} from "./model-invoke";

const REQUEST_SCHEMA = "dome.model-provider.request/v1";

const STEP_REQUEST_SCHEMA = "dome.model-provider.step/v1";

const PROBE_SCHEMA = "dome.model-provider.probe/v1";

const DEFAULT_PROBE_TIMEOUT_MS = 8_000;

type CommandModelStepRequest = {
  readonly schema: typeof STEP_REQUEST_SCHEMA;
  readonly messages: ModelStepRequest["messages"];
  readonly tools: ModelStepRequest["tools"];
  readonly model?: string;
};

type CommandModelProviderRequest = {
  readonly schema: typeof REQUEST_SCHEMA;
  readonly prompt: string;
  readonly model?: string;
  readonly temperature?: number;
};

export function buildCommandModelProvider(
  config: CommandModelProviderConfig,
  opts: { readonly cwd?: string } = {},
): ModelProvider {
  return async (request) => invokeCommandProvider(config, request, opts);
}

// ----- probe (dome.model-provider.probe/v1) ----------------------------------

/**
 * Outcome taxonomy for probing a configured command model provider. Per
 * docs/wiki/specs/cli.md §"dome doctor":
 *
 * - `responsive` — exit 0 with a valid probe response. `keyPresent` lets the
 *   caller report credential presence separately from reachability.
 * - `probe-unsupported` — the command started, read the envelope, and exited
 *   non-zero (e.g. a hand-written pre-probe provider rejecting an unknown
 *   schema). Alive; not a failure.
 * - `spawn-failed` — the command could not be started at all.
 * - `invalid-response` — exit 0 but stdout was not a valid probe response.
 * - `timed-out` — no exit within the probe timeout.
 */
export type ModelProviderProbeResult =
  | {
      readonly status: "responsive";
      readonly provider?: string;
      readonly keyPresent?: boolean;
      readonly defaultModel?: string;
    }
  | { readonly status: "probe-unsupported"; readonly detail: string }
  | { readonly status: "spawn-failed"; readonly detail: string }
  | { readonly status: "invalid-response"; readonly detail: string }
  | { readonly status: "timed-out"; readonly detail: string };

const ProbeResponseSchema = z.object({
  schema: z.literal(PROBE_SCHEMA),
  ok: z.literal(true),
  provider: z.string().optional(),
  keyPresent: z.boolean().optional(),
  defaultModel: z.string().optional(),
});

/**
 * Probe a configured command model provider with a
 * `dome.model-provider.probe/v1` envelope. Cheap by construction: a
 * conforming provider answers locally without any network or paid API call,
 * and the prober never sends a request/step envelope. Never throws — every
 * failure mode is a `ModelProviderProbeResult` variant.
 */
export async function probeCommandModelProvider(
  config: CommandModelProviderConfig,
  opts: {
    readonly cwd?: string;
    readonly env?: Record<string, string | undefined>;
    readonly timeoutMs?: number;
  } = {},
): Promise<ModelProviderProbeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn([...config.command], {
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    return Object.freeze({
      status: "spawn-failed" as const,
      detail: messageFor(error),
    });
  }

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  try {
    proc.stdin.write(JSON.stringify({ schema: PROBE_SCHEMA }));
    proc.stdin.end();
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (timedOut) {
      return Object.freeze({
        status: "timed-out" as const,
        detail: `model provider command did not answer the probe within ${timeoutMs}ms`,
      });
    }
    if (exitCode !== 0) {
      // The command started, consumed the envelope, and returned an error —
      // alive, just predating (or declining) the probe schema.
      return Object.freeze({
        status: "probe-unsupported" as const,
        detail: `model provider command exited ${exitCode}${formatStderr(stderr)}`,
      });
    }
    return parseProbeResponse(stdout);
  } catch (error) {
    return Object.freeze({
      status: "spawn-failed" as const,
      detail: messageFor(error),
    });
  } finally {
    clearTimeout(timeout);
  }
}

function parseProbeResponse(stdout: string): ModelProviderProbeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    return Object.freeze({
      status: "invalid-response" as const,
      detail: `probe response was not valid JSON: ${messageFor(error)}`,
    });
  }
  const result = ProbeResponseSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    return Object.freeze({
      status: "invalid-response" as const,
      detail:
        issue === undefined
          ? "probe response did not match dome.model-provider.probe/v1"
          : `probe response did not match dome.model-provider.probe/v1: ${
              issue.path.length === 0 ? "response" : issue.path.join(".")
            }: ${issue.message}`,
    });
  }
  const value = result.data;
  return Object.freeze({
    status: "responsive" as const,
    ...(value.provider !== undefined ? { provider: value.provider } : {}),
    ...(value.keyPresent !== undefined ? { keyPresent: value.keyPresent } : {}),
    ...(value.defaultModel !== undefined
      ? { defaultModel: value.defaultModel }
      : {}),
  });
}

export function buildCommandModelStepProvider(
  config: CommandModelProviderConfig,
  opts: { readonly cwd?: string } = {},
): ModelStepProvider {
  return async (request) => invokeCommandStepProvider(config, request, opts);
}

async function invokeCommandStepProvider(
  config: CommandModelProviderConfig,
  request: ModelStepRequest,
  opts: { readonly cwd?: string },
): Promise<ModelStepResponse> {
  if (request.signal.aborted) {
    throw new Error("model provider command was aborted before it started");
  }
  const proc = Bun.spawn([...config.command], {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const onAbort = (): void => {
    proc.kill();
  };
  request.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const payload: CommandModelStepRequest = {
      schema: STEP_REQUEST_SCHEMA,
      messages: request.messages,
      tools: request.tools,
      ...(request.model !== undefined ? { model: request.model } : {}),
    };
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(
        `model provider command exited ${exitCode}${formatStderr(stderr)}`,
      );
    }
    return parseStepResponse(stdout);
  } finally {
    request.signal.removeEventListener("abort", onAbort);
  }
}

function parseStepResponse(stdout: string): ModelStepResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `model provider command returned invalid JSON: ${messageFor(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("model provider command response must be a JSON object");
  }
  return parseModelStepResponse(parsed);
}

async function invokeCommandProvider(
  config: CommandModelProviderConfig,
  request: ModelProviderRequest,
  opts: { readonly cwd?: string },
): Promise<ModelProviderResponse> {
  if (request.signal.aborted) {
    throw new Error("model provider command was aborted before it started");
  }

  const proc = Bun.spawn([...config.command], {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const onAbort = (): void => {
    proc.kill();
  };
  request.signal.addEventListener("abort", onAbort, { once: true });

  try {
    proc.stdin.write(JSON.stringify(commandRequest(request)));
    proc.stdin.end();
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(
        `model provider command exited ${exitCode}${formatStderr(stderr)}`,
      );
    }
    return parseProviderResponse(stdout);
  } finally {
    request.signal.removeEventListener("abort", onAbort);
  }
}

function commandRequest(
  request: ModelProviderRequest,
): CommandModelProviderRequest {
  return Object.freeze({
    schema: REQUEST_SCHEMA,
    prompt: request.prompt,
    ...(request.model !== undefined ? { model: request.model } : {}),
    ...(request.temperature !== undefined
      ? { temperature: request.temperature }
      : {}),
  });
}

function parseProviderResponse(stdout: string): ModelProviderResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `model provider command returned invalid JSON: ${messageFor(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("model provider command response must be a JSON object");
  }
  return parseModelProviderResponse(parsed);
}

function formatStderr(stderr: string): string {
  const trimmed = stderr.trim();
  if (trimmed === "") return "";
  return `: ${trimmed.slice(0, 1000)}`;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
