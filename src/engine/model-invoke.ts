import type {
  Capability,
  ModelInvokeFn,
  ModelInvokeStructuredInput,
  ModelInvokeTextInput,
  ProcessorPhase,
} from "../core/processor";
import type { ResolvedExecutionPolicy } from "../processors/execution-policy";
import type { ProcessorExecutionErrorCode } from "./runner-contract";

const MODEL_EXECUTION_ERRORS = new WeakSet<object>();

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

export function modelInvokeForProcessor(opts: {
  readonly phase: ProcessorPhase;
  readonly processorId: string;
  readonly declared: ReadonlyArray<Capability>;
  readonly granted: ReadonlyArray<Capability>;
  readonly policy: ResolvedExecutionPolicy;
  readonly signal: AbortSignal;
  readonly provider?: ModelProvider;
  readonly onCost?: (costUsd: number) => void;
}): ModelInvokeFn | undefined {
  if (opts.phase === "adoption") return undefined;
  const modelPolicy = effectiveModelPolicy(opts.declared, opts.granted);
  if (modelPolicy === null) return undefined;

  const invokeText = async (
    input: ModelInvokeTextInput,
  ): Promise<string> => {
    const request = normalizeRequest(input, modelPolicy);
    if (opts.provider === undefined) {
      throw modelError(
        "model.invoke.denied",
        `${opts.processorId}: model.invoke is granted but no model provider is configured.`,
        false,
      );
    }

    const response = await callProviderWithTimeout({
      provider: opts.provider,
      request,
      signal: opts.signal,
      timeoutMs: opts.policy.modelCallTimeoutMs ?? opts.policy.timeoutMs,
    });
    if (
      response.costUsd !== undefined &&
      Number.isFinite(response.costUsd) &&
      response.costUsd > 0
    ) {
      opts.onCost?.(response.costUsd);
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
  return Object.freeze(fn);
}

type EffectiveModelPolicy = {
  readonly allowlist: ReadonlyArray<string> | null;
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
  return Object.freeze({ allowlist });
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
    return validateProviderResponse(response);
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

function validateProviderResponse(response: unknown): ModelProviderResponse {
  if (typeof response !== "object" || response === null) {
    throw invalidProviderResponse("expected an object response.");
  }
  const text = (response as { readonly text?: unknown }).text;
  if (typeof text !== "string") {
    throw invalidProviderResponse("expected response.text to be a string.");
  }

  const costUsd = (response as { readonly costUsd?: unknown }).costUsd;
  if (costUsd !== undefined) {
    if (typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0) {
      throw invalidProviderResponse(
        "expected response.costUsd to be a finite non-negative number.",
      );
    }
  }

  return Object.freeze({
    text,
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...copyOptionalString(response, "model"),
  });
}

function copyOptionalString(
  response: object,
  key: "model",
): { readonly model?: string } {
  const value = (response as { readonly model?: unknown })[key];
  if (value === undefined) return Object.freeze({});
  if (typeof value !== "string") {
    throw invalidProviderResponse(`expected response.${key} to be a string.`);
  }
  return Object.freeze({ [key]: value });
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
      parsed = JSON.parse(text);
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
