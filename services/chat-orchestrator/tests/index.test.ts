import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildChatGraph } from '../src/graph';
import { AgentState } from '../src/types';

// Mock the D1 database
const mockD1 = {
  exec: vi.fn().mockResolvedValue({}),
  prepare: vi.fn().mockReturnValue({
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(null),
    run: vi.fn().mockResolvedValue({ meta: { changes: 0 } }),
  }),
};

// Mock environment
const mockEnv = {
  D1: mockD1,
  VERSION: '0.1.0',
  LOG_LEVEL: 'debug',
  ENVIRONMENT: 'test',
};

// Mock logger
vi.mock('@dome/logging', () => ({
  getLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));

describe('Chat Orchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should build the graph successfully', async () => {
    const graph = await buildChatGraph(mockEnv as any);
    expect(graph).toBeDefined();
    expect(mockD1.exec).toHaveBeenCalled();
  });

  it('should process a simple message through the graph', async () => {
    const graph = await buildChatGraph(mockEnv as any);
    
    const initialState: AgentState = {
      userId: 'test-user',
      messages: [
        {
          role: 'user',
          content: 'Hello, world!',
          timestamp: Date.now(),
        },
      ],
      options: {
        enhanceWithContext: true,
        maxContextItems: 5,
        includeSourceInfo: true,
        maxTokens: 4000,
      },
      metadata: {
        startTime: Date.now(),
        nodeTimings: {},
        tokenCounts: {},
      },
    };
    
    const result = await graph.invoke({
      configurable: {
        state: initialState,
        config: {
          runId: 'test-index-1',
          configurable: { env: mockEnv }
        }
      }
    });
    
    // Verify the result contains expected fields
    expect(result).toBeDefined();
    expect(result.generatedText).toBeDefined();
    expect(result.metadata?.nodeTimings).toBeDefined();
    
    // Verify all nodes were executed
    const nodeTimings = result.metadata?.nodeTimings || {};
    expect(Object.keys(nodeTimings)).toContain('splitRewrite');
    expect(Object.keys(nodeTimings)).toContain('retrieve');
    expect(Object.keys(nodeTimings)).toContain('generateAnswer');
  });
});