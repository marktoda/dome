import { vi } from 'vitest';

// Enable garbage collection if running with --expose-gc flag
if (!global.gc) {
  global.gc = () => {
    // console.log('Garbage collection not available. Run with node --expose-gc');
  };
}

// --- Shared Mock Definitions ---
// const noop = () => {}; // noop is not needed if we use vi.fn() for logger methods
const sharedMockLogger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  silent: vi.fn(),
  child: () => sharedMockLogger, // This should also return a spy-based logger if child logs are checked
};

const sharedMockMetrics = {
  counter: vi.fn(), // Changed from increment to counter
  decrement: vi.fn(),
  gauge: vi.fn(),
  timing: vi.fn(),
  startTimer: vi.fn(() => ({ stop: vi.fn(() => 100) })), // Returns a timer object with a stop function
  trackOperation: vi.fn((operationName, success, tags) => {
    /* Mock implementation, can be empty or log */
  }), // Corrected signature
  getCounter: vi.fn(() => 0),
  getGauge: vi.fn(() => 0),
  reset: vi.fn(),
};

class MockHttpError extends Error {
  constructor(statusCode, message, details) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
    this.isOperational = true;
    this.name = this.constructor.name; // Set name for better error identification
  }
}

// --- Mocking Core Dependencies ---

// Mock pino
vi.mock('pino', () => {
  const pinoMock = vi.fn().mockReturnValue(sharedMockLogger);
  pinoMock.transport = vi.fn().mockReturnValue({}); // Simplified transport mock
  return { default: pinoMock, pino: pinoMock };
});

// Mock pino-pretty (basic mock, as pino.transport is already simplified)
vi.mock('pino-pretty', () => vi.fn(() => ({})));

// Mock @dome/common (explicitly mock all used exports)
vi.mock('@dome/common', () => {
  const mockErrorHandler = vi.fn(error => {
    const baseError = error instanceof Error ? error : new Error(String(error || 'Unknown error'));
    const errInstance = new Error(baseError.message); // Start with a fresh Error instance

    // Assign properties from baseError, then our mock-specific ones
    Object.assign(errInstance, {
      name: baseError.name,
      code:
        error &&
        typeof error === 'object' &&
        Object.prototype.hasOwnProperty.call(error, 'code') &&
        typeof error.code === 'string'
          ? error.code
          : 'UNKNOWN_MOCK_ERROR',
      details:
        error && typeof error === 'object' && Object.prototype.hasOwnProperty.call(error, 'details')
          ? error.details
          : undefined,
      statusCode:
        error &&
        typeof error === 'object' &&
        Object.prototype.hasOwnProperty.call(error, 'statusCode')
          ? error.statusCode
          : undefined,
      processedByCommonMock: true,
      commonError: true,
    });
    return errInstance;
  });
  return {
    // Logging
    getLogger: vi.fn().mockReturnValue(sharedMockLogger),
    logError: vi.fn((error, context, message) => {
      // console.error('Mocked @dome/common logError:', message, error, context);
    }),
    withContext: vi.fn((context, fn) => {
      // Basic mock: Call the function with the sharedMockLogger.
      // A more sophisticated mock could use the context to create/return a child logger.
      return fn(sharedMockLogger);
    }),

    // Error Handling
    createServiceErrorHandler: vi.fn(serviceName => mockErrorHandler),
    ensureError: vi.fn(err => (err instanceof Error ? err : new Error(String(err)))),
    isOperationalError: vi.fn(
      err => !!(err && typeof err === 'object' && 'isOperational' in err && err.isOperational),
    ),
    HttpError: MockHttpError,
    // Define common specific error classes if they are part of @dome/common API
    NotFoundError: class NotFoundError extends MockHttpError {
      constructor(m, d) {
        super(404, m || 'Not Found', d);
      }
    },
    BadRequestError: class BadRequestError extends MockHttpError {
      constructor(m, d) {
        super(400, m || 'Bad Request', d);
      }
    },
    ValidationError: class ValidationError extends MockHttpError {
      constructor(m, d) {
        super(400, m || 'Validation Error', d);
      }
    }, // Added ValidationError, using 400 status
    UnauthorizedError: class UnauthorizedError extends MockHttpError {
      constructor(m, d) {
        super(401, m || 'Unauthorized', d);
      }
    },
    ForbiddenError: class ForbiddenError extends MockHttpError {
      constructor(m, d) {
        super(403, m || 'Forbidden', d);
      }
    },
    InternalServerError: class InternalServerError extends MockHttpError {
      constructor(m, d) {
        super(500, m || 'Internal Server Error', d);
      }
    },

    // Metrics
    createServiceMetrics: vi.fn(serviceName => sharedMockMetrics), // Assumes it returns a metrics instance
    metrics: sharedMockMetrics, // If @dome/common exports a global metrics instance

    // Constants
    PUBLIC_USER_ID: 'test_public_user_id_from_common_mock',

    // Other utilities that might be used by constellation
    // Add them as needed based on import errors or usage patterns
    trackOperation: vi.fn(async (operationName, fnToTrack, context) => {
      // Basic mock: just execute the function.
      // More sophisticated mock could track calls or simulate errors.
      try {
        const result = await fnToTrack();
        // Optionally log success or interact with mock metrics if needed
        return result;
      } catch (error) {
        // Optionally log error or interact with mock metrics
        throw error;
      }
    }),
  };
});

// Mock @dome/logging (provides service-specific logging utilities)
vi.mock('@dome/logging', () => {
  return {
    getLogger: vi.fn().mockReturnValue(sharedMockLogger), // constellation might use this specific getLogger
    withLogger: vi.fn((logger, fn) => fn(logger || sharedMockLogger)), // Executes the function with the logger
    logError: vi.fn((error, context, message) => {
      // constellation might use this specific logError
      // console.error('Mocked @dome/logging logError:', message, error, context);
    }),
    logMetric: vi.fn(),
    metrics: sharedMockMetrics, // constellation might use this specific metrics object
    MetricsService: vi.fn(() => sharedMockMetrics), // If constellation instantiates MetricsService
    createServiceMetrics: vi.fn(serviceName => sharedMockMetrics), // constellation might use this
  };
});

// Mock cloudflare:workers with minimal implementation
vi.mock('cloudflare:workers', () => {
  return {
    // Empty object, or add specific bindings if needed by tests later
  };
});

// --- Global Mocks for Browser/Worker APIs ---
global.Response = class Response {
  constructor(body, init = {}) {
    this.body = body;
    this.status = init.status || 200;
    this.statusText = init.statusText || '';
    this.headers = new Map(Object.entries(init.headers || {}));
  }

  json() {
    return Promise.resolve(JSON.parse(this.body));
  }

  text() {
    return Promise.resolve(this.body);
  }
};

// Mock fetch
global.fetch = vi.fn();

// Mock Cloudflare Workers environment
global.caches = {
  default: {
    match: vi.fn(),
    put: vi.fn(),
  },
};

// Mock ExecutionContext
global.ExecutionContext = class ExecutionContext {
  waitUntil() {}
  passThroughOnException() {}
};
