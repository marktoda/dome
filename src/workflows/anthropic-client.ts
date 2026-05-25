import Anthropic from "@anthropic-ai/sdk";
import type { LlmClient, LlmTurn } from "./agent-loop";

const DEFAULT_MODEL = "claude-opus-4-7";

export interface AnthropicLlmOpts {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
}

export class AnthropicLlmClient implements LlmClient {
  private client: Anthropic;
  private model: string;
  private maxTokens: number;
  private history: Anthropic.Messages.MessageParam[] = [];

  constructor(opts: AnthropicLlmOpts = {}) {
    const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.client = new Anthropic(apiKey !== undefined ? { apiKey } : {});
    this.model = opts.model ?? DEFAULT_MODEL;
    this.maxTokens = opts.maxTokens ?? 4096;
  }

  async next(input: {
    systemPrompt: string;
    toolNames: ReadonlyArray<string>;
    userMessage?: string;
  }): Promise<LlmTurn> {
    if (input.userMessage !== undefined && this.history.length === 0) {
      this.history.push({ role: "user", content: input.userMessage });
    }
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: input.systemPrompt,
      messages: this.history,
      // Tool integration: real tool wiring lands when the SDK adapter exposes Tool metadata.
      // tools: input.toolNames.map(name => ({ name, description: "...", input_schema: {} })),
    });
    this.history.push({ role: "assistant", content: response.content });
    if (response.stop_reason === "end_turn" || response.stop_reason === "max_tokens") {
      return { kind: "stop", reason: response.stop_reason };
    }
    return { kind: "continue" };
  }

  reset(): void {
    this.history = [];
  }
}
