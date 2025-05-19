import { Hono } from 'hono';
// import { ChatController, createChatController } from '../../src/controllers/chatController'; // Commented out
import { Env, Services } from '../../src/types';
// ... existing code ...
// Define ErrorCode for the mock AppError
type ErrorCode = string;

vi.mock('@dome/common', async () => {
  const originalModule = await vi.importActual('@dome/common');
  // Mock the logger and metrics from @dome/common
  const mockLogger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };

  const mockMetrics = {
    increment: vi.fn(),
    gauge: vi.fn(),
    histogram: vi.fn(),
    flush: vi.fn(),
  };
  return {
    ...originalModule,
    getLogger: () => mockLogger,
    metrics: mockMetrics,
    // Add other commonly used mocks here if needed for chatController tests
    countTokens: vi.fn().mockImplementation((text: string, modelId?: string) => {
      // Simple mock: 1 token per 4 chars, or 10 for empty/short text
      if (!text) return 0;
      return Math.max(1, Math.ceil(text.length / 4));
    }),
    getDefaultModel: vi
      .fn()
      .mockReturnValue({ modelId: 'mock-model', contextWindow: 8000, knowledgeCutoff: '' }),
    AppError: class MockAppError extends Error {
      errorCode: ErrorCode;
      constructor(message: string, errorCode: ErrorCode) {
        super(message);
        this.name = 'AppError';
        this.errorCode = errorCode;
      }
    },
    ErrorCode: {
      BAD_REQUEST: 'BAD_REQUEST',
      UNAUTHORIZED: 'UNAUTHORIZED',
      FORBIDDEN: 'FORBIDDEN',
      NOT_FOUND: 'NOT_FOUND',
      INTERNAL_SERVER_ERROR: 'INTERNAL_SERVER_ERROR',
      SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
      // Add other error codes as needed
    },
    ContentCategoryEnum: {
      enum: { document: 'document', community: 'community', ticket: 'ticket' },
    },
    DEFAULT_CONTEXT_ALLOCATION: {
      maxPerDocumentPercentage: 0.1,
      documentsPercentage: 0.6,
      queryPercentage: 0.1,
      historyPercentage: 0.2,
      systemMessagePercentage: 0.1,
    },
    // Mock MetricsService if it's directly imported and used
    MetricsService: vi.fn().mockImplementation(() => mockMetrics),
  };
});

// Dynamically import ChatController AFTER the mock setup
let ChatController: typeof import('../../src/controllers/chatController').ChatController;
let createChatController: typeof import('../../src/controllers/chatController').createChatController;

beforeAll(async () => {
  const controllerModule = await import('../../src/controllers/chatController');
  ChatController = controllerModule.ChatController;
  createChatController = controllerModule.createChatController;
});

// Remove or comment out the static import of ChatController at the top of the file
// import { ChatController, createChatController } from '../../src/controllers/chatController';
// ... existing code ...
