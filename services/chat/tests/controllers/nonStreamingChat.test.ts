import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ChatController } from '../../src/controllers/chatController';
import { Services } from '../../src/services';
import { buildChatGraph } from '../../src/graph';

// Mock dependencies
vi.mock('../../src/services', () => ({
  Services: vi.fn().mockImplementation(() => ({
    checkpointer: {
      initialize: vi.fn().mockResolvedValue(undefined),
    },
    dataRetention: {
      initialize: vi.fn().mockResolvedValue(undefined),
      registerDataRecord: vi.fn().mockResolvedValue(undefined),
    },
    toolRegistry: {},
  })),
}));

vi.mock('../../src/graph', () => ({
  buildChatGraph: vi.fn().mockImplementation(() => ({
    stream: vi.fn().mockImplementation(() => {
      // Return a mock async iterable to simulate the graph output
      return {
        [Symbol.asyncIterator]: async function* () {
          // Simulate a token streaming event
          yield {
            event: 'on_chat_model_stream',
            data: {
              chunk: {
                content: 'Hello, ',
              },
            },
          };
          
          // Simulate another token chunk
          yield {
            event: 'on_chat_model_stream',
            data: {
              chunk: {
                content: 'world!',
              },
            },
          };
          
          // Simulate a node event with document sources
          yield {
            event: 'on_chain_stream',
            metadata: {
              langgraph_node: 'retrieve',
            },
            data: {
              state: {
                docs: [
                  {
                    id: 'doc1',
                    title: 'Test Document',
                    metadata: {
                      source: 'test',
                      url: 'https://test.com',
                      relevanceScore: 0.95,
                    },
                  },
                ],
              },
            },
          };
          
          // Simulate completion event
          yield {
            event: 'on_chain_end',
            name: 'LangGraph',
          };
        },
      };
    }),
  })),
}));

describe('Non-streaming chat implementation', () => {
  let chatController: ChatController;
  let env: Env;
  let services: Services;
  
  beforeEach(() => {
    env = {
      OPENAI_API_KEY: 'test-key',
    } as unknown as Env;
    services = new Services();
    chatController = new ChatController(env, services);
  });
  
  afterEach(() => {
    vi.clearAllMocks();
  });
  
  it('should aggregate streamed content and return a single response', async () => {
    const request = {
      userId: 'test-user',
      messages: [
        {
          role: 'user',
          content: 'Hello',
        },
      ],
      options: {
        enhanceWithContext: true,
        maxContextItems: 5,
      },
      runId: 'test-run-id',
    };
    
    // Test the non-streaming chat function
    const response = await chatController.generateChatMessage(request);
    
    // Verify it's a valid response
    expect(response.status).toBe(200);
    
    // Parse the response
    const responseData = await response.json();
    
    // Verify it contains the expected data
    expect(responseData.text).toBe('Hello, world!');
    expect(responseData.sources).toHaveLength(1);
    expect(responseData.sources[0].id).toBe('doc1');
    expect(responseData.metadata.executionTimeMs).toBeGreaterThan(0);
  });
  
  it('should return a different response format compared to streaming', async () => {
    const request = {
      userId: 'test-user',
      messages: [
        {
          role: 'user',
          content: 'Hello',
        },
      ],
      options: {
        enhanceWithContext: true,
        maxContextItems: 5,
      },
      runId: 'test-run-id',
    };
    
    // Test the streaming chat function
    const streamingResponse = await chatController.generateChatResponse(request);
    
    // Verify it's a streaming response
    expect(streamingResponse.headers.get('Content-Type')).toBe('text/event-stream');
    
    // Test the non-streaming chat function
    const nonStreamingResponse = await chatController.generateChatMessage(request);
    
    // Verify it's a JSON response
    expect(nonStreamingResponse.headers.get('Content-Type')).toBe('application/json');
  });
});