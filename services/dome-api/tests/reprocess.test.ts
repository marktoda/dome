import { describe, it, expect, vi, beforeEach } from 'vitest';
import app from '../src/index';
import { Hono } from 'hono';

// Mock the AiProcessorClient
vi.mock('@dome/ai-processor/client', () => ({
  AiProcessorClient: vi.fn().mockImplementation(() => ({
    reprocess: vi.fn(),
  })),
}));

// Mock the services
const mockAiProcessor = {
  reprocess: vi.fn(),
};

// Mock the environment
const mockEnv = {
  AI_PROCESSOR: mockAiProcessor,
  SILO: {
    batchGet: vi.fn(),
    delete: vi.fn(),
    stats: vi.fn(),
    findContentWithFailedSummary: vi.fn(),
    getMetadataById: vi.fn(),
  },
  SILO_INGEST_QUEUE: {
    send: vi.fn(),
  },
};

// Mock @dome/common (consolidated)
vi.mock('@dome/common', () => ({
  // From first mock
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
  logError: vi.fn(),
  withLogger: vi.fn().mockImplementation((_, fn) => fn()), // Assuming this is a function that takes a context and a function
  metrics: {
    // This was under @dome/common mock, ensure it's correct or move if it belongs to metricsMiddleware mock
    increment: vi.fn(),
    timing: vi.fn(),
    startTimer: () => ({
      stop: () => 100,
    }),
    trackHealthCheck: vi.fn(),
    getCounter: vi.fn().mockReturnValue(0),
    counter: vi.fn(),
  },
  initLogging: vi.fn(),
  // From second mock
  createRequestContextMiddleware: vi.fn().mockImplementation(() => (c: any, next: any) => next()),
  createErrorMiddleware: vi.fn().mockImplementation(() => (c: any, next: any) => next()),
  responseHandlerMiddleware: vi.fn().mockImplementation((c: any, next: any) => next()),
  createSimpleAuthMiddleware: vi.fn().mockImplementation(() => (c: any, next: any) => next()),
  formatZodError: vi.fn(),
  createDetailedLoggerMiddleware: vi.fn().mockImplementation(() => (c: any, next: any) => next()),
  // Ensure ServiceError is also included if it was part of the original @dome/common and is used
  ServiceError: class ServiceError extends Error {
    code: string;
    status: number;
    constructor(message: string, opts?: { code?: string; status?: number }) {
      super(message);
      this.code = opts?.code || 'UNKNOWN_ERROR';
      this.status = opts?.status || 500;
    }
  },
}));

// The following vi.mock('@dome/common', ...) block is redundant and has been removed.
// Its functionality is covered by the consolidated mock for '@dome/common' above (lines 32-77).

// Mock the metrics middleware
vi.mock('../src/middleware/metricsMiddleware', () => ({
  metricsMiddleware: () => (c: any, next: any) => next(),
  initMetrics: vi.fn(),
  metrics: {
    increment: vi.fn(),
    timing: vi.fn(),
    startTimer: () => ({
      stop: () => 100,
    }),
    trackHealthCheck: vi.fn(),
    getCounter: vi.fn().mockReturnValue(0),
    counter: vi.fn(),
  },
}));

// Mock the user ID middleware
vi.mock('../src/middleware/userIdMiddleware', () => ({
  userIdMiddleware: (c: any, next: any) => {
    c.set('userId', 'test-user');
    return next();
  },
}));

describe('Reprocess Endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock implementations
    mockAiProcessor.reprocess.mockResolvedValue({
      success: true,
      reprocessed: {
        id: 'test-id',
        success: true,
      },
    });
  });

  it('should reprocess content by ID successfully', async () => {
    const req = new Request('http://localhost/ai/reprocess', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ id: 'test-id' }),
    });

    const res = await app.fetch(req, mockEnv as any);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      success: boolean;
      result: {
        reprocessed: {
          id: string;
          success: boolean;
        };
      };
    };
    expect(body).toHaveProperty('success', true);
    expect(body).toHaveProperty('result');
    expect(body.result).toHaveProperty('reprocessed');
    expect(body.result.reprocessed).toHaveProperty('id', 'test-id');

    // Verify that the AI processor was called with the correct parameters
    expect(mockAiProcessor.reprocess).toHaveBeenCalledWith({ id: 'test-id' });
  });

  it('should reprocess all failed content when no ID is provided', async () => {
    const req = new Request('http://localhost/ai/reprocess', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    mockAiProcessor.reprocess.mockResolvedValue({
      success: true,
      reprocessed: {
        total: 2,
        successful: 2,
      },
    });

    const res = await app.fetch(req, mockEnv as any);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      success: boolean;
      result: {
        reprocessed: {
          total: number;
          successful: number;
        };
      };
    };
    expect(body).toHaveProperty('success', true);
    expect(body).toHaveProperty('result');
    expect(body.result).toHaveProperty('reprocessed');
    expect(body.result.reprocessed).toHaveProperty('total', 2);
    expect(body.result.reprocessed).toHaveProperty('successful', 2);

    // Verify that the AI processor was called with the correct parameters
    expect(mockAiProcessor.reprocess).toHaveBeenCalledWith({});
  });

  it('should handle errors from the AI processor', async () => {
    const req = new Request('http://localhost/ai/reprocess', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ id: 'test-id' }),
    });

    mockAiProcessor.reprocess.mockRejectedValue(new Error('Failed to reprocess content'));

    const res = await app.fetch(req, mockEnv as any);
    expect(res.status).toBe(500);

    const body = (await res.json()) as {
      success: boolean;
      error: {
        code: string;
        message: string;
        details: string;
      };
    };
    expect(body).toHaveProperty('success', false);
    expect(body).toHaveProperty('error');
    expect(body.error).toHaveProperty('code', 'REPROCESS_ERROR');
    expect(body.error).toHaveProperty('details', 'Failed to reprocess content');
  });

  it('should handle validation errors', async () => {
    const req = new Request('http://localhost/ai/reprocess', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ id: 123 }), // ID should be a string
    });

    const res = await app.fetch(req, mockEnv as any);
    expect(res.status).toBe(400);

    const body = (await res.json()) as {
      success: boolean;
      error: {
        code: string;
        message: string;
        details?: any;
      };
    };
    expect(body).toHaveProperty('success', false);
    expect(body).toHaveProperty('error');
    expect(body.error).toHaveProperty('code', 'VALIDATION_ERROR');
  });
});
