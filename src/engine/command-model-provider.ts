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
