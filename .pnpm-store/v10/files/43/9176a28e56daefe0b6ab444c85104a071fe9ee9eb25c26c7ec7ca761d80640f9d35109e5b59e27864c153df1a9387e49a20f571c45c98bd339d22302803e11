import { MemoryProcessor } from '@mastra/core/memory';
import { Tiktoken } from 'js-tiktoken/lite';
import o200k_base from 'js-tiktoken/ranks/o200k_base';
import { MemoryProcessor as MemoryProcessor$1 } from '@mastra/core';

// src/processors/token-limiter.ts
var TokenLimiter = class extends MemoryProcessor {
  encoder;
  maxTokens;
  // Token overheads per OpenAI's documentation
  // See: https://cookbook.openai.com/examples/how_to_count_tokens_with_tiktoken#6-counting-tokens-for-chat-completions-api-calls
  // Every message follows <|start|>{role/name}\n{content}<|end|>
  TOKENS_PER_MESSAGE = 3.8;
  // tokens added for each message (start & end tokens)
  TOKENS_PER_CONVERSATION = 24;
  // fixed overhead for the conversation
  /**
   * Create a token limiter for messages.
   * @param options Either a number (token limit) or a configuration object
   */
  constructor(options) {
    super({
      name: "TokenLimiter"
    });
    if (typeof options === "number") {
      this.maxTokens = options;
      this.encoder = new Tiktoken(o200k_base);
    } else {
      this.maxTokens = options.limit;
      this.encoder = new Tiktoken(options.encoding || o200k_base);
    }
  }
  process(messages, { systemMessage, memorySystemMessage, newMessages } = {}) {
    let totalTokens = 0;
    totalTokens += this.TOKENS_PER_CONVERSATION;
    if (systemMessage) {
      totalTokens += this.countTokens(systemMessage);
      totalTokens += this.TOKENS_PER_MESSAGE;
    }
    if (memorySystemMessage) {
      totalTokens += this.countTokens(memorySystemMessage);
      totalTokens += this.TOKENS_PER_MESSAGE;
    }
    const allMessages = [...messages, ...newMessages || []];
    const result = [];
    for (let i = allMessages.length - 1; i >= 0; i--) {
      const message = allMessages[i];
      if (!message) continue;
      const messageTokens = this.countTokens(message);
      if (totalTokens + messageTokens <= this.maxTokens) {
        if (i < messages.length) {
          result.unshift(message);
        }
        totalTokens += messageTokens;
      } else {
        this.logger.info(
          `filtering ${allMessages.length - result.length}/${allMessages.length} messages, token limit of ${this.maxTokens} exceeded`
        );
        break;
      }
    }
    return result;
  }
  countTokens(message) {
    if (typeof message === `string`) {
      return this.encoder.encode(message).length;
    }
    let tokenString = message.role;
    let overhead = 0;
    if (typeof message.content === "string" && message.content) {
      tokenString += message.content;
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === "text") {
          tokenString += part.text;
        } else if (part.type === "tool-call" || part.type === `tool-result`) {
          if (`args` in part && part.args && part.type === `tool-call`) {
            tokenString += part.toolName;
            if (typeof part.args === "string") {
              tokenString += part.args;
            } else {
              tokenString += JSON.stringify(part.args);
              overhead -= 12;
            }
          }
          if (`result` in part && part.result !== void 0 && part.type === `tool-result`) {
            if (typeof part.result === "string") {
              tokenString += part.result;
            } else {
              tokenString += JSON.stringify(part.result);
              overhead -= 12;
            }
          }
        } else {
          tokenString += JSON.stringify(part);
        }
      }
    }
    if (typeof message.content === `string` || // if the message included non-tool parts, add our message overhead
    message.content.some((p) => p.type !== `tool-call` && p.type !== `tool-result`)) {
      overhead += this.TOKENS_PER_MESSAGE;
    }
    return this.encoder.encode(tokenString).length + overhead;
  }
};
var ToolCallFilter = class extends MemoryProcessor$1 {
  exclude;
  /**
   * Create a filter for tool calls and results.
   * @param options Configuration options
   * @param options.exclude List of specific tool names to exclude. If not provided, all tool calls are excluded.
   */
  constructor(options = {}) {
    super({ name: "ToolCallFilter" });
    if (!options || !options.exclude) {
      this.exclude = "all";
    } else {
      this.exclude = Array.isArray(options.exclude) ? options.exclude : [];
    }
  }
  process(messages) {
    if (this.exclude === "all") {
      return messages.filter((message) => {
        if (Array.isArray(message.content)) {
          return !message.content.some((part) => part.type === "tool-call" || part.type === "tool-result");
        }
        return true;
      });
    }
    if (this.exclude.length > 0) {
      const excludedToolCallIds = /* @__PURE__ */ new Set();
      return messages.filter((message) => {
        if (!Array.isArray(message.content)) return true;
        if (message.role === "assistant") {
          let shouldExclude = false;
          for (const part of message.content) {
            if (part.type === "tool-call" && this.exclude.includes(part.toolName)) {
              excludedToolCallIds.add(part.toolCallId);
              shouldExclude = true;
            }
          }
          return !shouldExclude;
        }
        if (message.role === "tool") {
          const shouldExclude = message.content.some(
            (part) => part.type === "tool-result" && excludedToolCallIds.has(part.toolCallId)
          );
          return !shouldExclude;
        }
        return true;
      });
    }
    return messages;
  }
};

export { TokenLimiter, ToolCallFilter };
