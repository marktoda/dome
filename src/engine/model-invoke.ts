import { z } from "zod";

import type {
  Capability,
  ModelInvokeFn,
  ModelInvokeStructuredInput,
  ModelInvokeTextInput,
  ModelMessage,
  ModelStepInput,
  ModelStepResult,
  ModelToolCall,
  ModelToolSchema,
  ProcessorPhase,
} from "../core/processor";
import type { ResolvedExecutionPolicy } from "../processors/execution-policy";
import type { ProcessorExecutionErrorCode } from "./runner-contract";

const MODEL_EXECUTION_ERRORS = new WeakSet<object>();
const PROVIDER_MAX_ATTEMPTS = 2;

export type ModelExecutionErrorCode = Extract<
  ProcessorExecutionErrorCode,
  `model.${string}`
>;

export type ModelExecutionError = Error & {
  readonly code: ModelExecutionErrorCode;
  readonly retryable: boolean;
};

export type ModelProviderRequest = {
  readonly prompt: string;
  readonly model?: string;
  readonly temperature?: number;
  readonly signal: AbortSignal;
};

export type ModelProviderResponse = {
  readonly text: string;
  readonly model?: string;
  readonly costUsd?: number;
};

export type ModelProvider = (
  request: ModelProviderRequest,
) => Promise<ModelProviderResponse>;

export type ModelStepRequest = {
  readonly messages: ReadonlyArray<ModelMessage>;
  readonly tools: ReadonlyArray<ModelToolSchema>;
  readonly model?: string;
  readonly signal: AbortSignal;
};

export type ModelStepResponse = {
  readonly toolCalls?: ReadonlyArray<ModelToolCall>;
  readonly text?: string;
  readonly model?: string;
  readonly costUsd?: number;
};

export type ModelStepProvider = (
  request: ModelStepRequest,
) => Promise<ModelStepResponse>;

const ModelToolCallSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  })
  .passthrough()
  .transform((c): ModelToolCall => Object.freeze({ id: c.id, name: c.name, input: c.input }));

const ModelStepResponseSchema = z.object({
  toolCalls: z.array(ModelToolCallSchema).optional(),
  text: z.string().optional(),
  model: z.string().optional(),
  costUsd: z.number().finite().nonnegative().optional(),
});

export function parseModelStepResponse(response: unknown): ModelStepResponse {
  const parsed = ModelStepResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw invalidProviderResponse(modelProviderResponseError(parsed.error));
  }
  const value = parsed.data;
  return Object.freeze({
    ...(value.toolCalls !== undefined
      ? { toolCalls: Object.freeze(value.toolCalls) }
      : {}),
    ...(value.text !== undefined ? { text: value.text } : {}),
    ...(value.model !== undefined ? { model: value.model } : {}),
    ...(value.costUsd !== undefined ? { costUsd: value.costUsd } : {}),
  });
}

const ModelProviderResponseSchema = z.object({
  text: z.string(),
  model: z.string().optional(),
  costUsd: z.number().finite().nonnegative().optional(),
});

export type ModelInvokeCapabilityUse = {
  readonly capability: "model.invoke";
  readonly resource: string | null;
  readonly outcome: "allowed" | "denied";
};

export function modelInvokeForProcessor(opts: {
  readonly phase: ProcessorPhase;
  readonly processorId: string;
  readonly declared: ReadonlyArray<Capability>;
  readonly granted: ReadonlyArray<Capability>;
  readonly policy: ResolvedExecutionPolicy;
  readonly signal: AbortSignal;
  readonly provider?: ModelProvider;
  readonly stepProvider?: ModelStepProvider;
  readonly onCost?: (costUsd: number) => void;
  readonly onCapabilityUse?: (use: ModelInvokeCapabilityUse) => void;
  readonly spentUsdToday?: () => number;
}): ModelInvokeFn | undefined {
  if (opts.phase === "adoption") return undefined;
  const modelPolicy = effectiveModelPolicy(opts.declared, opts.granted);
  if (modelPolicy === null) return undefined;

  const invokeText = async (
    input: ModelInvokeTextInput,
  ): Promise<string> => {
    let request: Omit<ModelProviderRequest, "signal">;
    try {
      request = normalizeRequest(input, modelPolicy);
      enforceBudgetBeforeCall(modelPolicy, opts.spentUsdToday);
    } catch (error) {
      recordModelCapabilityUse(opts.onCapabilityUse, {
        resource: input.model ?? null,
        outcome: "denied",
      });
      throw error;
    }
    if (opts.provider === undefined) {
      recordModelCapabilityUse(opts.onCapabilityUse, {
        resource: request.model ?? null,
        outcome: "denied",
      });
      throw modelError(
        "model.invoke.denied",
        `${opts.processorId}: model.invoke is granted but no model provider is configured.`,
        false,
      );
    }

    const response = await callProviderWithRetry({
      provider: opts.provider,
      request,
      signal: opts.signal,
      timeoutMs: opts.policy.modelCallTimeoutMs ?? opts.policy.timeoutMs,
      onAttempt: () => {
        recordModelCapabilityUse(opts.onCapabilityUse, {
          resource: request.model ?? null,
          outcome: "allowed",
        });
      },
    });
    if (
      response.costUsd !== undefined &&
      Number.isFinite(response.costUsd) &&
      response.costUsd > 0
    ) {
      opts.onCost?.(response.costUsd);
      enforceBudgetAfterCall(modelPolicy, opts.spentUsdToday);
    }
    return response.text;
  };

  const fn = invokeText as ModelInvokeFn;
  Object.defineProperty(fn, "structured", {
    value: async <T>(
      input: ModelInvokeStructuredInput<T>,
    ): Promise<T> => invokeStructured(fn, input),
    enumerable: true,
  });

  if (opts.stepProvider !== undefined) {
    const stepProvider = opts.stepProvider;
    const invokeStep = async (
      input: ModelStepInput,
    ): Promise<ModelStepResult> => {
      let model: string | undefined;
      try {
        model = resolveStepModel(input.model, modelPolicy);
        enforceBudgetBeforeCall(modelPolicy, opts.spentUsdToday);
      } catch (error) {
        recordModelCapabilityUse(opts.onCapabilityUse, {
          resource: input.model ?? null,
          outcome: "denied",
        });
        throw error;
      }
      recordModelCapabilityUse(opts.onCapabilityUse, {
        resource: model ?? null,
        outcome: "allowed",
      });
      const response = await stepProvider({
        messages: input.messages,
        tools: input.tools,
        ...(model !== undefined ? { model } : {}),
        signal: opts.signal,
      });
      if (
        response.costUsd !== undefined &&
        Number.isFinite(response.costUsd) &&
        response.costUsd > 0
      ) {
        opts.onCost?.(response.costUsd);
        enforceBudgetAfterCall(modelPolicy, opts.spentUsdToday);
      }
      return Object.freeze({
        ...(response.toolCalls !== undefined
          ? { toolCalls: response.toolCalls }
          : {}),
        ...(response.text !== undefined ? { text: response.text } : {}),
      });
    };
    Object.defineProperty(fn, "step", { value: invokeStep, enumerable: true });
  }

  return Object.freeze(fn);
}

function recordModelCapabilityUse(
  callback: ((use: ModelInvokeCapabilityUse) => void) | undefined,
  use: Omit<ModelInvokeCapabilityUse, "capability">,
): void {
  callback?.({
    capability: "model.invoke",
    resource: use.resource,
    outcome: use.outcome,
  });
}

type EffectiveModelPolicy = {
  readonly allowlist: ReadonlyArray<string> | null;
  readonly maxDailyCostUsd: number | null;
};

function effectiveModelPolicy(
  declared: ReadonlyArray<Capability>,
  granted: ReadonlyArray<Capability>,
): EffectiveModelPolicy | null {
  const declaredModel = declared.find((cap) => cap.kind === "model.invoke");
  const grantedModel = granted.find((cap) => cap.kind === "model.invoke");
  if (declaredModel === undefined || grantedModel === undefined) {
    return null;
  }

  const allowlist = intersectAllDefined(
    declaredModel.modelAllowlist,
    grantedModel.modelAllowlist,
  );
  const maxDailyCostUsd = minAllDefined(
    declaredModel.maxDailyCostUsd,
    grantedModel.maxDailyCostUsd,
  );
  return Object.freeze({ allowlist, maxDailyCostUsd });
}

function normalizeRequest(
  input: ModelInvokeTextInput,
  policy: EffectiveModelPolicy,
): Omit<ModelProviderRequest, "signal"> {
  if (input.prompt.trim() === "") {
    throw modelError(
      "model.invoke.denied",
      "model.invoke prompt must be non-empty.",
      false,
    );
  }

  let model = input.model;
  if (policy.allowlist !== null) {
    if (policy.allowlist.length === 0) {
      throw modelError(
        "model.invoke.denied",
        "model.invoke has no model allowed by both declaration and grant.",
        false,
      );
    }
    const defaultModel = policy.allowlist[0];
    if (defaultModel === undefined) {
      throw modelError(
        "model.invoke.denied",
        "model.invoke has no model allowed by both declaration and grant.",
        false,
      );
    }
    model = model ?? defaultModel;
    if (!policy.allowlist.includes(model)) {
      throw modelError(
        "model.invoke.denied",
        `model.invoke denied model '${model}'; allowed models: ${policy.allowlist.join(", ")}`,
        false,
      );
    }
  }

  return Object.freeze({
    prompt: input.prompt,
    ...(model !== undefined ? { model } : {}),
    ...(input.temperature !== undefined
      ? { temperature: input.temperature }
      : {}),
  });
}

function resolveStepModel(
  requested: string | undefined,
  policy: EffectiveModelPolicy,
): string | undefined {
  if (policy.allowlist === null) return requested;
  if (policy.allowlist.length === 0) {
    throw modelError(
      "model.invoke.denied",
      "model.invoke has no model allowed by both declaration and grant.",
      false,
    );
  }
  const model = requested ?? policy.allowlist[0];
  if (model === undefined || !policy.allowlist.includes(model)) {
    throw modelError(
      "model.invoke.denied",
      `model.invoke denied model '${String(model)}'; allowed models: ${policy.allowlist.join(", ")}`,
      false,
    );
  }
  return model;
}

async function callProviderWithTimeout(opts: {
  readonly provider: ModelProvider;
  readonly request: Omit<ModelProviderRequest, "signal">;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}): Promise<ModelProviderResponse> {
  if (opts.signal.aborted) {
    throw modelAbortError("model.invoke was aborted before provider call started.");
  }

  const controller = new AbortController();
  let abort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    abort = () => {
      controller.abort();
      reject(modelAbortError("model.invoke was aborted before provider returned."));
    };
    opts.signal.addEventListener("abort", abort, { once: true });
  });

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(
        modelError(
          "model.invoke.timeout",
          `model.invoke exceeded per-call timeout of ${opts.timeoutMs}ms.`,
          true,
        ),
      );
    }, opts.timeoutMs);
  });

  try {
    const response = await Promise.race<unknown>([
      opts.provider({
        ...opts.request,
        signal: controller.signal,
      }),
      timeoutPromise,
      abortPromise,
    ]);
    return parseModelProviderResponse(response);
  } catch (e) {
    if (isModelExecutionError(e)) throw e;
    throw modelError(
      "model.invoke.provider-failed",
      `model provider failed: ${shortMessage(e)}`,
      true,
    );
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (abort !== undefined) {
      opts.signal.removeEventListener("abort", abort);
    }
  }
}

async function callProviderWithRetry(opts: {
  readonly provider: ModelProvider;
  readonly request: Omit<ModelProviderRequest, "signal">;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly onAttempt?: () => void;
}): Promise<ModelProviderResponse> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= PROVIDER_MAX_ATTEMPTS; attempt += 1) {
    opts.onAttempt?.();
    try {
      return await callProviderWithTimeout(opts);
    } catch (error) {
      lastError = error;
      if (!shouldRetryProviderFailure(error, attempt, opts.signal)) {
        throw error;
      }
    }
  }
  throw lastError;
}

function shouldRetryProviderFailure(
  error: unknown,
  attempt: number,
  signal: AbortSignal,
): boolean {
  return (
    attempt < PROVIDER_MAX_ATTEMPTS &&
    !signal.aborted &&
    isModelExecutionError(error) &&
    error.retryable &&
    error.code === "model.invoke.provider-failed"
  );
}

export function parseModelProviderResponse(
  response: unknown,
): ModelProviderResponse {
  const parsed = ModelProviderResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw invalidProviderResponse(modelProviderResponseError(parsed.error));
  }
  const value = parsed.data;
  return Object.freeze({
    text: value.text,
    ...(value.model !== undefined ? { model: value.model } : {}),
    ...(value.costUsd !== undefined ? { costUsd: value.costUsd } : {}),
  });
}

function modelProviderResponseError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return "response did not match provider schema.";
  const path =
    issue.path.length === 0 ? "response" : `response.${issue.path.join(".")}`;
  return `${path}: ${issue.message}.`;
}

function invalidProviderResponse(message: string): Error & {
  readonly code: ModelExecutionErrorCode;
  readonly retryable: boolean;
} {
  return modelError(
    "model.invoke.provider-failed",
    `model provider returned invalid response: ${message}`,
    true,
  );
}

function modelAbortError(message: string): Error & {
  readonly code: ModelExecutionErrorCode;
  readonly retryable: boolean;
} {
  return modelError("model.invoke.timeout", message, true);
}

async function invokeStructured<T>(
  invokeText: ModelInvokeFn,
  input: ModelInvokeStructuredInput<T>,
): Promise<T> {
  const attempts = attemptsFor(input.retries);
  let lastCode: "model.output.invalid-json" | "model.output.schema-mismatch" =
    "model.output.invalid-json";
  let lastMessage = "model output did not match the requested schema.";

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const text = await invokeText(input);
    let parsed: unknown;
    try {
      parsed = parseStructuredJsonText(text);
    } catch (e) {
      lastCode = "model.output.invalid-json";
      lastMessage = `model output for schema '${input.schemaName}' was not parseable JSON: ${shortMessage(e)}`;
      continue;
    }

    try {
      return input.parse(parsed);
    } catch (e) {
      lastCode = "model.output.schema-mismatch";
      lastMessage = `model output failed schema '${input.schemaName}': ${shortMessage(e)}`;
    }
  }

  throw modelError(lastCode, lastMessage, false);
}

function parseStructuredJsonText(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const fenced = singleJsonFenceBody(trimmed);
    if (fenced === null) throw error;
    return JSON.parse(fenced.trim());
  }
}

function singleJsonFenceBody(text: string): string | null {
  const match = /^```(?:json|JSON)?[ \t]*\r?\n([\s\S]*)\r?\n```$/.exec(text);
  if (match === null) return null;
  return match[1] ?? "";
}

function attemptsFor(retries: number | undefined): number {
  if (retries === undefined) return 1;
  if (!Number.isSafeInteger(retries) || retries < 0) {
    throw modelError(
      "model.invoke.denied",
      "model.invoke structured retries must be a non-negative integer.",
      false,
    );
  }
  return retries + 1;
}

function intersectAllDefined(
  a: ReadonlyArray<string> | undefined,
  b: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> | null {
  if (a === undefined && b === undefined) return null;
  if (a === undefined) return Object.freeze([...(b ?? [])]);
  if (b === undefined) return Object.freeze([...a]);
  const bSet = new Set(b);
  return Object.freeze(a.filter((model) => bSet.has(model)));
}

function minAllDefined(
  a: number | undefined,
  b: number | undefined,
): number | null {
  if (a === undefined && b === undefined) return null;
  if (a === undefined) return b ?? null;
  if (b === undefined) return a;
  return Math.min(a, b);
}

function enforceBudgetBeforeCall(
  policy: EffectiveModelPolicy,
  spentUsdToday: (() => number) | undefined,
): void {
  if (policy.maxDailyCostUsd === null || spentUsdToday === undefined) return;
  const spent = spentUsdToday();
  if (spent >= policy.maxDailyCostUsd) {
    throw budgetDenied(policy.maxDailyCostUsd, spent);
  }
}

function enforceBudgetAfterCall(
  policy: EffectiveModelPolicy,
  spentUsdToday: (() => number) | undefined,
): void {
  if (policy.maxDailyCostUsd === null || spentUsdToday === undefined) return;
  const spent = spentUsdToday();
  if (spent > policy.maxDailyCostUsd) {
    throw budgetDenied(policy.maxDailyCostUsd, spent);
  }
}

function budgetDenied(
  maxDailyCostUsd: number,
  spentUsdToday: number,
): ModelExecutionError {
  return modelError(
    "model.invoke.denied",
    `model.invoke daily cost budget exceeded: spent $${spentUsdToday.toFixed(4)} of $${maxDailyCostUsd.toFixed(4)}.`,
    false,
  );
}

function modelError(
  code: ModelExecutionErrorCode,
  message: string,
  retryable: boolean,
): ModelExecutionError {
  const error = new Error(message) as ModelExecutionError;
  Object.defineProperties(error, {
    code: { value: code, enumerable: true },
    retryable: { value: retryable, enumerable: true },
  });
  MODEL_EXECUTION_ERRORS.add(error);
  return Object.freeze(error);
}

export function isModelExecutionError(
  error: unknown,
): error is ModelExecutionError {
  return (
    typeof error === "object" &&
    error !== null &&
    MODEL_EXECUTION_ERRORS.has(error)
  );
}

function shortMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 240 ? `${message.slice(0, 237)}...` : message;
}
