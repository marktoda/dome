/**
 * Eval model-step providers.
 *
 * - `scriptedRecordingStep` — deterministic scripted provider for hermetic evals.
 * - `hermeticEvalEnv` — wraps scripted provider into an EvalEnv.
 * - `liveEvalEnv` — builds a real Anthropic step provider; throws if no key.
 */

import type {
  ModelStepProvider,
  ModelStepResponse,
} from "../engine/core/model-invoke";
import type { EvalEnv, ToolCallTrace } from "./types";

// ---------------------------------------------------------------------------
// ToolCallTrace
// ---------------------------------------------------------------------------

// `ToolCallTrace` now lives in `./types` (alongside `EvalEnv`, which carries
// the trajectory array) to avoid an import cycle. Re-exported here so existing
// consumers (`assertions.ts`, the provider tests) keep importing it from
// `./provider`.
export type { ToolCallTrace } from "./types";

// ---------------------------------------------------------------------------
// Terminal default response (returned once the script is exhausted)
// ---------------------------------------------------------------------------

const TERMINAL_RESPONSE: ModelStepResponse = Object.freeze({ text: "done" });

// ---------------------------------------------------------------------------
// scriptedRecordingStep
// ---------------------------------------------------------------------------

/**
 * Returns a `ModelStepProvider` that plays back `script` in order, recording
 * a `ToolCallTrace` entry for each scripted response. Once the script is
 * exhausted the provider returns `{ text: "done" }` (not recorded).
 */
export function scriptedRecordingStep(
  script: ReadonlyArray<ModelStepResponse>,
): { provider: ModelStepProvider; trajectory: ToolCallTrace[] } {
  let index = 0;
  const trajectory: ToolCallTrace[] = [];

  const provider: ModelStepProvider = async (_request) => {
    if (index >= script.length) {
      return TERMINAL_RESPONSE;
    }
    const response = script[index]!;
    trajectory.push({
      step: index,
      toolCalls: (response.toolCalls ?? []).map((c) => ({ name: c.name })),
      text: response.text ?? null,
    });
    index += 1;
    return response;
  };

  return { provider, trajectory };
}

// ---------------------------------------------------------------------------
// hermeticEvalEnv
// ---------------------------------------------------------------------------

/**
 * Wraps `scriptedRecordingStep` into an `EvalEnv` with `mode: "hermetic"`.
 *
 * The scripted provider already records each call into `trajectory`; the same
 * array is attached to `env.trajectory` so the case reads the realized
 * trajectory back via `env` after the engine drives the run. The returned
 * `trajectory` is the identical array reference for callers that prefer it
 * directly.
 */
export function hermeticEvalEnv(
  script: ReadonlyArray<ModelStepResponse>,
): { env: EvalEnv; trajectory: ToolCallTrace[] } {
  const { provider, trajectory } = scriptedRecordingStep(script);
  const env: EvalEnv = {
    modelStepProvider: provider,
    mode: "hermetic",
    trajectory,
  };
  return { env, trajectory };
}

/**
 * Wrap a `ModelStepProvider` in a recording layer that appends one
 * `ToolCallTrace` per call into `trajectory`. Used for the live provider so
 * `--live` trajectories are captured the same way the hermetic scripted
 * provider records them — this is what makes `trajectoryReadsBeforeWrites`
 * meaningful for live runs too.
 */
function recordingStepProvider(
  provider: ModelStepProvider,
): { provider: ModelStepProvider; trajectory: ToolCallTrace[] } {
  let index = 0;
  const trajectory: ToolCallTrace[] = [];
  const recording: ModelStepProvider = async (request) => {
    const response = await provider(request);
    trajectory.push({
      step: index,
      toolCalls: (response.toolCalls ?? []).map((c) => ({ name: c.name })),
      text: response.text ?? null,
    });
    index += 1;
    return response;
  };
  return { provider: recording, trajectory };
}

// ---------------------------------------------------------------------------
// liveEvalEnv
// ---------------------------------------------------------------------------

/**
 * Builds a real Anthropic step provider using the `@ai-sdk/anthropic` +
 * Vercel AI SDK `generateText` path — the same SDK the agent loop uses.
 * Throws loudly if `ANTHROPIC_API_KEY` is unset.
 */
export function liveEvalEnv(): { env: EvalEnv; trajectory: ToolCallTrace[] } {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (apiKey === undefined || apiKey === "") {
    throw new Error(
      "liveEvalEnv: ANTHROPIC_API_KEY is not set. " +
        "Export a valid key before running live evals.",
    );
  }

  const provider: ModelStepProvider = async (request) => {
    // Lazy import so that the module loads even without the AI SDK present in
    // hermetic test runs (the import will only execute when liveEvalEnv is
    // actually called with a real key).
    const { generateText } = await import("ai");
    const { anthropic } = await import("@ai-sdk/anthropic");

    // Map engine ModelMessage[] → AI SDK CoreMessage[]
    const messages = request.messages.map((msg) => {
      if (msg.role === "system") {
        return { role: "system" as const, content: msg.content };
      }
      if (msg.role === "user") {
        return { role: "user" as const, content: msg.content };
      }
      if (msg.role === "assistant") {
        return { role: "assistant" as const, content: msg.content };
      }
      // role === "tool"
      return {
        role: "tool" as const,
        content: [
          {
            type: "tool-result" as const,
            toolCallId: msg.toolCallId,
            toolName: msg.toolName,
            content: msg.content,
          },
        ],
      };
    });

    // Map engine ModelToolSchema[] → AI SDK tools record
    const tools: Record<
      string,
      { description: string; parameters: Record<string, unknown> }
    > = {};
    for (const tool of request.tools) {
      tools[tool.name] = {
        description: tool.description,
        parameters: tool.inputSchema as Record<string, unknown>,
      };
    }

    const result = await generateText({
      model: anthropic(request.model ?? "claude-sonnet-4-5"),
      messages,
      tools: Object.keys(tools).length > 0 ? (tools as never) : undefined,
      maxSteps: 1,
      abortSignal: request.signal,
    });

    // Map AI SDK result → engine ModelStepResponse
    const firstStep = result.steps[0];
    const aiToolCalls = firstStep?.toolCalls ?? [];

    return Object.freeze({
      ...(aiToolCalls.length > 0
        ? {
            toolCalls: Object.freeze(
              aiToolCalls.map((tc) =>
                Object.freeze({
                  id: tc.toolCallId,
                  name: tc.toolName,
                  input: tc.input,
                }),
              ),
            ),
          }
        : {}),
      ...(result.text ? { text: result.text } : {}),
    });
  };

  const { provider: recording, trajectory } = recordingStepProvider(provider);
  const env: EvalEnv = {
    modelStepProvider: recording,
    mode: "live",
    trajectory,
  };
  return { env, trajectory };
}
