// Adapt Dome's provider-neutral, command-friendly ModelStepProvider to the
// Vercel AI SDK model interface used by the interactive assistant loop. The
// command provider returns one complete step, so doStream emits one bounded
// text delta (or tool calls) while preserving the AI SDK's tool execution and
// multi-step orchestration.

import type { LanguageModel } from "ai";

import type {
  ModelMessage,
  ModelToolSchema,
} from "../core/processor";
import type {
  ModelStepProvider,
  ModelStepResponse,
} from "../engine/core/model-invoke";

type LanguageModelV3 = Extract<
  LanguageModel,
  { readonly specificationVersion: "v3" }
>;
type CallOptions = Parameters<LanguageModelV3["doStream"]>[0];
type GenerateResult = Awaited<ReturnType<LanguageModelV3["doGenerate"]>>;
type StreamResult = Awaited<ReturnType<LanguageModelV3["doStream"]>>;
type GeneratedContent = GenerateResult["content"];
type StreamPart = StreamResult["stream"] extends ReadableStream<infer T> ? T : never;

const UNKNOWN_USAGE = Object.freeze({
  inputTokens: Object.freeze({
    total: undefined,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  }),
  outputTokens: Object.freeze({
    total: undefined,
    text: undefined,
    reasoning: undefined,
  }),
});

/**
 * Present an injected Dome step provider as an AI SDK language model.
 *
 * This is the single seam between Product Host's credential-backed command
 * provider and the existing assistant loop. It intentionally does not load an
 * API key or instantiate a vendor SDK.
 */
export function languageModelForStepProvider(
  provider: ModelStepProvider,
  modelId: string,
): LanguageModelV3 {
  const invoke = async (options: CallOptions): Promise<ModelStepResponse> =>
    provider({
      messages: modelMessages(options),
      tools: modelTools(options),
      model: modelId,
      signal: options.abortSignal ?? new AbortController().signal,
    });

  return Object.freeze({
    specificationVersion: "v3" as const,
    provider: "dome.model-step",
    modelId,
    supportedUrls: Object.freeze({}),
    async doGenerate(options): Promise<GenerateResult> {
      const response = await invoke(options);
      return {
        content: generatedContent(response),
        finishReason: finishReason(response),
        usage: UNKNOWN_USAGE,
        warnings: [],
        ...(response.model !== undefined
          ? { response: { modelId: response.model } }
          : {}),
      };
    },
    async doStream(options): Promise<StreamResult> {
      const response = await invoke(options);
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of streamParts(response)) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  });
}

function modelMessages(options: CallOptions): ReadonlyArray<ModelMessage> {
  return options.prompt.flatMap((message): ReadonlyArray<ModelMessage> => {
    if (message.role === "system") {
      return [{ role: "system", content: message.content }];
    }
    if (message.role === "user") {
      return [{
        role: "user",
        content: message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(""),
      }];
    }
    if (message.role === "assistant") {
      const content = message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      const toolCalls = message.content
        .filter((part) => part.type === "tool-call")
        .map((part) => ({
          id: part.toolCallId,
          name: part.toolName,
          input: part.input,
        }));
      return [{
        role: "assistant",
        content,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      }];
    }
    return message.content
      .filter((part) => part.type === "tool-result")
      .map((part) => ({
        role: "tool" as const,
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        content: toolResultText(part.output),
      }));
  });
}

function modelTools(options: CallOptions): ReadonlyArray<ModelToolSchema> {
  return (options.tools ?? [])
    .filter((candidate) => candidate.type === "function")
    .map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema as Readonly<Record<string, unknown>>,
    }));
}

function toolResultText(output: unknown): string {
  const value = output as {
    readonly type: string;
    readonly value?: unknown;
    readonly reason?: string;
  };
  if (value.type === "text" || value.type === "error-text") {
    return String(value.value ?? "");
  }
  if (value.type === "execution-denied") return value.reason ?? "execution denied";
  if (value.type === "content") return JSON.stringify(value.value ?? []);
  return JSON.stringify(value.value ?? null);
}

function generatedContent(response: ModelStepResponse): GeneratedContent {
  const content: GeneratedContent = [];
  if (response.text !== undefined && response.text.length > 0) {
    content.push({ type: "text", text: response.text });
  }
  for (const call of response.toolCalls ?? []) {
    content.push({
      type: "tool-call",
      toolCallId: call.id,
      toolName: call.name,
      input: JSON.stringify(call.input) ?? "null",
    });
  }
  return content;
}

function streamParts(response: ModelStepResponse): StreamPart[] {
  const parts: StreamPart[] = [];
  if (response.text !== undefined && response.text.length > 0) {
    parts.push(
      { type: "text-start", id: "text-0" },
      { type: "text-delta", id: "text-0", delta: response.text },
      { type: "text-end", id: "text-0" },
    );
  }
  for (const call of response.toolCalls ?? []) {
    parts.push({
      type: "tool-call",
      toolCallId: call.id,
      toolName: call.name,
      input: JSON.stringify(call.input) ?? "null",
    });
  }
  parts.push({
    type: "finish",
    usage: UNKNOWN_USAGE,
    finishReason: finishReason(response),
  });
  return parts;
}

function finishReason(response: ModelStepResponse): {
  readonly unified: "stop" | "tool-calls";
  readonly raw: string;
} {
  return (response.toolCalls?.length ?? 0) > 0
    ? { unified: "tool-calls", raw: "tool-calls" }
    : { unified: "stop", raw: "stop" };
}
