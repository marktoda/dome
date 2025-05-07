import {
  getLogger,
  metrics,
  withContext,
  getModelConfig,
  calculateContextLimits,
} from '@dome/common';
import { toDomeError, ValidationError } from '../utils/errors';
import { IterableReadableStream } from '@langchain/core/utils/stream';
import {
  chatRequestSchema,
  resumeChatRequestSchema,
  ChatRequest,
  ResumeChatRequest,
  AgentState,
  MessagePair,
} from '../types';
import { Services } from '../services';
import { V2Chat } from '../graphs';
import { secureMessages } from '../utils/securePromptHandler';
import { validateInitialState } from '../utils/inputValidator';

export class ChatController {
  private logger = getLogger().child({ component: 'ChatController' });

  constructor(
    private readonly env: Env,
    private readonly services: Services,
    private readonly ctx: ExecutionContext,
  ) {}

  /* ---------------------------------------------------------------------- */
  /*  Public API                                                            */
  /* ---------------------------------------------------------------------- */

  /** Generate a full (non‑streaming) answer */
  async generateChatMessage(req: ChatRequest): Promise<Response> {
    const state = await this.buildInitialState(req);
    return this.runGraphNonStreaming(state, crypto.randomUUID());
  }

  /** Start a new chat session in streaming mode */
  async startChatSession(req: ChatRequest): Promise<ReadableStream<Uint8Array>> {
    const state = await this.buildInitialState(req);
    return this.runGraphStreaming(state, crypto.randomUUID());
  }

  /** Resume an existing chat run in streaming mode */
  async resumeChatSession(req: ResumeChatRequest): Promise<IterableReadableStream<unknown>> {
    const { runId, newMessage } = resumeChatRequestSchema.parse(req);

    return withContext(
      { service: 'chat-orchestrator', operation: 'resumeChatSession', runId },
      async () => {
        const state = await this.buildResumeState(runId, newMessage);
        return this.runGraphStreaming(state, runId) as Promise<IterableReadableStream<unknown>>;
      },
    );
  }

  /* ---------------------------------------------------------------------- */
  /*  State builders                                                        */
  /* ---------------------------------------------------------------------- */

  private async buildInitialState(req: ChatRequest): Promise<AgentState> {
    getLogger().info({ req }, 'ChatController buildInitialState');
    // Input validation & basic sanitation
    const parsed = chatRequestSchema.parse(req);
    getLogger().info({ parsed }, 'ChatController buildInitialState - parsed');
    const validated = validateInitialState(parsed);

    // Data‑retention bookkeeping
    await this.services.dataRetention.initialize();
    const runId = parsed.runId ?? crypto.randomUUID();
    await this.services.dataRetention.registerDataRecord(runId, validated.userId, 'chatHistory');

    // Secure user messages before passing to the model
    return this.createBaseState({
      ...validated,
      messages: secureMessages(validated.messages),
      runId,
    });
  }

  private async buildResumeState(
    runId: string,
    newMessage?: AgentState['messages'][number],
  ): Promise<AgentState> {
    // Data‑retention bookkeeping (runId doubles as userId here)
    await this.services.dataRetention.initialize();
    await this.services.dataRetention.registerDataRecord(runId, runId, 'chatHistory');

    return this.createBaseState({
      userId: runId,
      messages: newMessage ? secureMessages([newMessage]) : [],
      options: {
        enhanceWithContext: true,
        maxContextItems: 5,
        includeSourceInfo: true,
        maxTokens: this.getModelLimits().maxResponseTokens,
      },
      runId,
    });
  }

  private createBaseState({
    userId,
    messages,
    options,
    taskIds = [],
    taskEntities = {},
    docs = [],
    generatedText = '',
    metadata = {},
    runId,
  }: Partial<AgentState> & {
    userId: string;
    messages: AgentState['messages'];
    options?: AgentState['options'];
    runId: string;
  }): AgentState {
    // Build chat history from messages array
    const chatHistory: MessagePair[] = [];

    // Process messages to create user-assistant pairs
    for (let i = 0; i < messages.length - 1; i++) {
      const current = messages[i];
      const next = messages[i + 1];

      // If we have a user message followed by an assistant message, create a pair
      if (current.role === 'user' && next.role === 'assistant') {
        chatHistory.push({
          user: current,
          assistant: next,
          timestamp: next.timestamp || current.timestamp || Date.now(),
          tokenCount: undefined, // We could calculate this if needed
        });
        // Skip the next message since we've already used it in this pair
        i++;
      }
    }

    return {
      userId,
      messages,
      chatHistory,
      options,
      taskIds,
      taskEntities,
      docs,
      generatedText,
      metadata: { ...metadata, startTime: performance.now(), runId },
    } as AgentState;
  }

  /**
   * Get model-specific context limits
   *
   * @param modelId Optional model ID
   * @returns Object with token limits for different components
   */
  private getModelLimits(modelId?: string): {
    maxContextTokens: number;
    maxResponseTokens: number;
    maxDocumentsTokens: number;
  } {
    // Get model configuration from modelId or use default
    const modelConfig = getModelConfig(modelId);

    // Calculate context limits
    const contextLimits = calculateContextLimits(modelConfig);

    // Provide fallback for optional properties
    const maxDocumentsTokens =
      contextLimits.maxDocumentsTokens || Math.floor(contextLimits.maxContextTokens * 0.4); // Default to 40% if not specified

    return {
      maxContextTokens: contextLimits.maxContextTokens,
      maxResponseTokens: contextLimits.maxResponseTokens,
      maxDocumentsTokens,
    };
  }

  /* ---------------------------------------------------------------------- */
  /*  Graph execution                                                       */
  /* ---------------------------------------------------------------------- */
  private async runGraphStreaming(
    state: AgentState,
    runId: string,
  ): Promise<ReadableStream<Uint8Array>> {
    await this.services.checkpointer.initialize();
    const graph = await V2Chat.build(this.env, this.services.checkpointer);

    const thread_id = crypto.randomUUID();
    this.logger.info({ thread_id, runId }, 'Starting graph stream');

    metrics.increment('chat_orchestrator.chat.generated', 1, { streaming: 'true' });

    const iterator = graph.stream(state, {
      configurable: { thread_id, runId },
      streamMode: ['messages', 'updates'],
    });

    const enc = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      async start(ctrl) {
        try {
          for await (const chunk of await iterator) {
            ctrl.enqueue(enc.encode(JSON.stringify(chunk) + '\n'));
          }
        } finally {
          ctrl.close();
        }
      },
    });
  }

  private async runGraphNonStreaming(state: AgentState, runId: string): Promise<Response> {
    await this.services.checkpointer.initialize();
    const graph = await V2Chat.build(this.env, this.services.checkpointer);

    const thread_id = crypto.randomUUID();
    this.logger.info({ thread_id, runId }, 'Starting graph invocation');

    const result = await graph.invoke(state, { configurable: { thread_id, runId } });
    metrics.increment('chat_orchestrator.chat.generated', 1, { streaming: 'false' });

    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/** Factory helper (keeps original export) */
export function createChatController(
  env: Env,
  services: Services,
  ctx: ExecutionContext,
): ChatController {
  return new ChatController(env, services, ctx);
}
