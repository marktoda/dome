#!/usr/bin/env bun
//
// Dome command model provider for the Anthropic Messages API.
//
// This file is the SDK-shipped first-party provider template
// (`<SDK>/assets/model-providers/anthropic.ts`). Explicit model setup may copy
// it into a vault as `.dome/model-provider.ts` and wire `.dome/config.yaml`:
//
//   model_provider:
//     kind: command
//     command: ["bun", ".dome/model-provider.ts"]
//
// It is shipped data, not SDK code: no `src/` module imports it, and it
// uses plain `fetch` — no @anthropic-ai/sdk, no new dependency
// (ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY stays intact).
//
// Dome invokes this script with one JSON envelope on stdin and reads one
// JSON object from stdout:
//
//   { "schema": "dome.model-provider.request/v1", "prompt": "...", ... }
//     -> { "text": "...", "model": "...", "costUsd"?: number }
//
//   { "schema": "dome.model-provider.step/v1", "messages": [...], "tools": [...] }
//     -> { "toolCalls"?: [...], "text"?: "...", "model": "...", "costUsd"?: number }
//
//   { "schema": "dome.model-provider.probe/v1" }
//     -> { "schema": "dome.model-provider.probe/v1", "ok": true,
//          "provider": "anthropic", "keyPresent": boolean, "defaultModel": "..." }
//
// The probe answer is computed locally — no network call, no API spend —
// and succeeds even when ANTHROPIC_API_KEY is unset, so `dome doctor` can
// report key-presence separately from reachability.
//
// Required environment (for request/step, not probe):
// - ANTHROPIC_API_KEY
//
// Optional environment:
// - ANTHROPIC_MODEL              (default: claude-sonnet-4-6)
// - ANTHROPIC_MAX_TOKENS         (default: 8192)
// - ANTHROPIC_BASE_URL           (default: https://api.anthropic.com)
// - ANTHROPIC_INPUT_COST_PER_MTOK / ANTHROPIC_OUTPUT_COST_PER_MTOK
//   Override the built-in per-MTok price table. Reporting costUsd is what
//   makes Dome's maxDailyCostUsd capability caps effective.
// - DOME_DISABLE_PROMPT_CACHE=1  Escape hatch: drop the cache_control
//   breakpoints below and send the legacy uncached wire shape.
//
// Prompt caching (step envelope only): each `step` request marks the stable
// prefix — the system charter block and the LAST tools[] entry — with
// `cache_control: {type: "ephemeral"}` (5-minute TTL). The agent loop resends
// the full history every step with a constant charter and tool set, so steps
// 2..N read the prefix from cache at ~0.1x the input rate instead of
// reprocessing it. One-shot `request` envelopes have no reusable prefix and
// stay uncached. Mechanics verified 2026-06: cache_control is GA on the
// Messages API under `anthropic-version: 2023-06-01` — no beta header and no
// version bump needed (response parsing unaffected). Prefixes below the
// model's minimum cacheable length silently don't cache (usage just reports
// zero cache tokens); cost math handles both shapes.
//
// Abort semantics: Dome kills this process when the calling processor's
// signal aborts; no in-script handling is needed.

type ProviderRequest = {
  readonly schema: "dome.model-provider.request/v1";
  readonly prompt: string;
  readonly model?: string;
  readonly temperature?: number;
};

type StepMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly toolCalls?: ReadonlyArray<StepToolCall>;
    }
  | {
      readonly role: "tool";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly content: string;
    };

type StepToolCall = {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
};

type StepRequest = {
  readonly schema: "dome.model-provider.step/v1";
  readonly messages: ReadonlyArray<StepMessage>;
  readonly tools: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Record<string, unknown>;
  }>;
  readonly model?: string;
};

type AnthropicContentBlock = {
  readonly type: string;
  readonly text?: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: unknown;
};

type AnthropicResponse = {
  readonly content?: ReadonlyArray<AnthropicContentBlock>;
  readonly model?: string;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    // Present when the request carried cache_control breakpoints. Cached
    // tokens are EXCLUDED from input_tokens: total prompt size is
    // input + cache_creation + cache_read.
    readonly cache_creation_input_tokens?: number;
    readonly cache_read_input_tokens?: number;
  };
};

const API_KEY = process.env.ANTHROPIC_API_KEY;
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
const MAX_TOKENS = positiveIntegerEnv("ANTHROPIC_MAX_TOKENS", 8192);
const BASE_URL = (process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com")
  .replace(/\/+$/, "");
const PROMPT_CACHE_ENABLED = process.env.DOME_DISABLE_PROMPT_CACHE !== "1";

// Anthropic prompt-cache pricing, relative to the model's input rate:
// writing a prefix to the cache bills at 1.25x (5-minute ephemeral TTL),
// reading it back at 0.1x. Output tokens are unaffected.
const CACHE_WRITE_INPUT_MULTIPLIER = 1.25;
const CACHE_READ_INPUT_MULTIPLIER = 0.1;

// Built-in per-MTok USD prices for known model families (longest prefix
// wins). Every prefix is explicit — no family catch-all, because pricing
// differs within a family (opus 4.0/4.1 cost 3x opus 4.5+). Env overrides
// take precedence; unknown models without env prices honestly omit costUsd
// rather than guessing.
const PRICE_TABLE: ReadonlyArray<{
  readonly prefix: string;
  readonly inputPerMtok: number;
  readonly outputPerMtok: number;
}> = [
  { prefix: "claude-fable-5", inputPerMtok: 10, outputPerMtok: 50 },
  { prefix: "claude-sonnet-4-6", inputPerMtok: 3, outputPerMtok: 15 },
  { prefix: "claude-sonnet-4-5", inputPerMtok: 3, outputPerMtok: 15 },
  { prefix: "claude-haiku-4-5", inputPerMtok: 1, outputPerMtok: 5 },
  { prefix: "claude-opus-4-8", inputPerMtok: 5, outputPerMtok: 25 },
  { prefix: "claude-opus-4-7", inputPerMtok: 5, outputPerMtok: 25 },
  { prefix: "claude-opus-4-6", inputPerMtok: 5, outputPerMtok: 25 },
  { prefix: "claude-opus-4-5", inputPerMtok: 5, outputPerMtok: 25 },
  { prefix: "claude-opus-4-1", inputPerMtok: 15, outputPerMtok: 75 },
  { prefix: "claude-opus-4-0", inputPerMtok: 15, outputPerMtok: 75 },
];

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

async function main(): Promise<void> {
  const raw: unknown = JSON.parse(await Bun.stdin.text());
  const schema = schemaOf(raw);

  if (schema === "dome.model-provider.probe/v1") {
    // Local-only liveness answer; intentionally no key requirement and no
    // network call. `dome doctor` uses this to report key-presence
    // separately from reachability.
    process.stdout.write(
      JSON.stringify({
        schema: "dome.model-provider.probe/v1",
        ok: true,
        provider: "anthropic",
        keyPresent: keyPresent(),
        defaultModel: DEFAULT_MODEL,
      }),
    );
    return;
  }

  requireKey();
  if (schema === "dome.model-provider.step/v1") {
    process.stdout.write(JSON.stringify(await runStep(parseStepRequest(raw))));
    return;
  }
  if (schema === "dome.model-provider.request/v1") {
    process.stdout.write(JSON.stringify(await runText(parseRequest(raw))));
    return;
  }
  throw new Error(
    `unsupported Dome model provider request schema: ${String(schema)}`,
  );
}

// ----- one-shot text (dome.model-provider.request/v1) -----------------------

async function runText(
  request: ProviderRequest,
): Promise<{ text: string; model: string; costUsd?: number }> {
  const model = request.model ?? DEFAULT_MODEL;
  // `temperature` is sent only when the envelope supplied one: some models
  // reject sampling parameters outright, so defaulting one in would break
  // them. Absent means "the API's default", not 0.
  const parsed = await callMessages({
    model,
    max_tokens: MAX_TOKENS,
    ...(request.temperature !== undefined
      ? { temperature: request.temperature }
      : {}),
    messages: [{ role: "user", content: request.prompt }],
  });

  const text = textFrom(parsed);
  if (text.length === 0) {
    throw new Error("Anthropic response did not include a text block");
  }

  const costUsd = costFromUsage(parsed.model ?? model, parsed.usage);
  return {
    text,
    model: parsed.model ?? model,
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

// ----- tool-use step (dome.model-provider.step/v1) ---------------------------

async function runStep(request: StepRequest): Promise<{
  toolCalls?: Array<StepToolCall>;
  text?: string;
  model: string;
  costUsd?: number;
}> {
  const model = request.model ?? DEFAULT_MODEL;
  const system = request.messages
    .filter((m): m is Extract<StepMessage, { role: "system" }> =>
      m.role === "system",
    )
    .map((m) => m.content)
    .join("\n\n");

  // Cache breakpoints on the step envelope's stable prefix: tools render
  // before system in the cache key, so a breakpoint on the LAST tool plus one
  // on the system block covers the whole constant prefix; the per-step
  // message history stays after the last breakpoint. See the header comment
  // for mechanics + the DOME_DISABLE_PROMPT_CACHE escape hatch.
  const body: Record<string, unknown> = {
    model,
    max_tokens: MAX_TOKENS,
    messages: request.messages
      .filter((m) => m.role !== "system")
      .map(toAnthropicMessage),
    tools: request.tools.map((t, index) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
      ...(PROMPT_CACHE_ENABLED && index === request.tools.length - 1
        ? { cache_control: { type: "ephemeral" } }
        : {}),
    })),
  };
  if (system.length > 0) {
    body.system = PROMPT_CACHE_ENABLED
      ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]
      : system;
  }

  const parsed = await callMessages(body);
  const blocks = parsed.content ?? [];
  const toolCalls = blocks
    .filter((b) => b.type === "tool_use")
    .map((b): StepToolCall => ({
      id: String(b.id),
      name: String(b.name),
      input: b.input,
    }));
  const text = blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n")
    .trim();
  const costUsd = costFromUsage(parsed.model ?? model, parsed.usage);
  return {
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(text.length > 0 ? { text } : {}),
    model: parsed.model ?? model,
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

/** Map a provider-neutral Dome step message onto the Anthropic wire shape.
 * Assistant tool calls become `tool_use` blocks; tool results become
 * `tool_result` blocks inside a user message (the Messages API shape). */
function toAnthropicMessage(m: StepMessage): unknown {
  if (m.role === "assistant") {
    const content: unknown[] = [];
    if (m.content.length > 0) content.push({ type: "text", text: m.content });
    for (const call of m.toolCalls ?? []) {
      content.push({
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: call.input,
      });
    }
    return { role: "assistant", content };
  }
  if (m.role === "tool") {
    return {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: m.toolCallId,
          content: m.content,
        },
      ],
    };
  }
  return { role: "user", content: m.content };
}

// ----- Anthropic Messages API call -------------------------------------------

async function callMessages(
  body: Record<string, unknown>,
): Promise<AnthropicResponse> {
  const response = await fetch(`${BASE_URL}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY ?? "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(
      `Anthropic request failed ${response.status}: ${errBody.slice(0, 1000)}`,
    );
  }
  return (await response.json()) as AnthropicResponse;
}

// ----- envelope parsing -------------------------------------------------------

function schemaOf(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Dome model provider request must be a JSON object");
  }
  return (raw as { schema?: unknown }).schema;
}

function parseRequest(raw: unknown): ProviderRequest {
  const parsed = raw as Partial<ProviderRequest>;
  if (typeof parsed.prompt !== "string" || parsed.prompt.trim().length === 0) {
    throw new Error("request.prompt must be a non-empty string");
  }
  if (parsed.model !== undefined && typeof parsed.model !== "string") {
    throw new Error("request.model must be a string when present");
  }
  if (
    parsed.temperature !== undefined &&
    (typeof parsed.temperature !== "number" ||
      !Number.isFinite(parsed.temperature))
  ) {
    throw new Error("request.temperature must be a finite number when present");
  }
  return {
    schema: "dome.model-provider.request/v1",
    prompt: parsed.prompt,
    ...(parsed.model !== undefined ? { model: parsed.model } : {}),
    ...(parsed.temperature !== undefined
      ? { temperature: parsed.temperature }
      : {}),
  };
}

function parseStepRequest(raw: unknown): StepRequest {
  const parsed = raw as Partial<StepRequest>;
  if (!Array.isArray(parsed.messages)) {
    throw new Error("step request.messages must be an array");
  }
  if (!Array.isArray(parsed.tools)) {
    throw new Error("step request.tools must be an array");
  }
  if (parsed.model !== undefined && typeof parsed.model !== "string") {
    throw new Error("step request.model must be a string when present");
  }
  return {
    schema: "dome.model-provider.step/v1",
    messages: parsed.messages,
    tools: parsed.tools,
    ...(parsed.model !== undefined ? { model: parsed.model } : {}),
  };
}

// ----- helpers ----------------------------------------------------------------

function keyPresent(): boolean {
  return API_KEY !== undefined && API_KEY.trim().length > 0;
}

function requireKey(): void {
  if (!keyPresent()) {
    throw new Error("ANTHROPIC_API_KEY is required");
  }
}

function textFrom(response: AnthropicResponse): string {
  return (response.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
}

function costFromUsage(
  model: string,
  usage: AnthropicResponse["usage"],
): number | undefined {
  if (
    usage === undefined ||
    usage.input_tokens === undefined ||
    usage.output_tokens === undefined
  ) {
    return undefined;
  }
  const prices = pricesFor(model);
  if (prices === undefined) return undefined;
  // Cache fields are absent on uncached responses (and on older API shapes)
  // — treat absent as zero so the legacy math is unchanged. input_tokens
  // excludes cached tokens, so the three input tiers are additive.
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  return (
    (usage.input_tokens / 1_000_000) * prices.inputPerMtok +
    (cacheCreation / 1_000_000) *
      prices.inputPerMtok *
      CACHE_WRITE_INPUT_MULTIPLIER +
    (cacheRead / 1_000_000) * prices.inputPerMtok * CACHE_READ_INPUT_MULTIPLIER +
    (usage.output_tokens / 1_000_000) * prices.outputPerMtok
  );
}

function pricesFor(
  model: string,
): { inputPerMtok: number; outputPerMtok: number } | undefined {
  const envInput = numberEnv("ANTHROPIC_INPUT_COST_PER_MTOK");
  const envOutput = numberEnv("ANTHROPIC_OUTPUT_COST_PER_MTOK");
  if (envInput !== undefined && envOutput !== undefined) {
    return { inputPerMtok: envInput, outputPerMtok: envOutput };
  }
  const match = [...PRICE_TABLE]
    .sort((a, b) => b.prefix.length - a.prefix.length)
    .find((row) => model.startsWith(row.prefix));
  if (match === undefined) return undefined;
  return { inputPerMtok: match.inputPerMtok, outputPerMtok: match.outputPerMtok };
}

function numberEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return parsed;
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}
