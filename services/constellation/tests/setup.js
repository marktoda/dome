import { vi } from 'vitest';

// Enable garbage collection if running with --expose-gc flag
if (!global.gc) {
  global.gc = () => {
    console.log('Garbage collection not available. Run with node --expose-gc');
  };
}

// Mock pino logger to prevent transport errors with lightweight mocks
vi.mock('pino', () => {
  const noop = () => {};
  const mockLogger = {
    info: noop,
    debug: noop,
    warn: noop,
    error: noop,
    child: () => mockLogger,
  };

  return {
    default: vi.fn().mockReturnValue(mockLogger),
  };
});

// Mock @dome/logging with lightweight functions
vi.mock('@dome/logging', () => {
  const noop = () => {};
  const mockLogger = {
    info: noop,
    debug: noop,
    warn: noop,
    error: noop,
    child: () => mockLogger,
  };

  // Create proper mock implementations for metrics
  const counters = new Map();
  const gauges = new Map();

  const mockMetricsService = {
    increment: vi.fn((name, value = 1, tags = {}) => {
      const current = counters.get(name) || 0;
      counters.set(name, current + value);
      return current + value;
    }),
    decrement: vi.fn((name, value = 1, tags = {}) => {
      const current = counters.get(name) || 0;
      const newValue = Math.max(0, current - value);
      counters.set(name, newValue);
      return newValue;
    }),
    gauge: vi.fn((name, value, tags = {}) => {
      gauges.set(name, value);
      return value;
    }),
    timing: vi.fn(),
    startTimer: vi.fn(() => ({ stop: vi.fn(() => 100) })),
    trackOperation: vi.fn(),
    getCounter: vi.fn(name => counters.get(name) || 0),
    getGauge: vi.fn(name => gauges.get(name) || 0),
    reset: vi.fn(() => {
      counters.clear();
      gauges.clear();
    }),
  };

  return {
    getLogger: vi.fn().mockReturnValue(mockLogger),
    withLogger: vi.fn((_, fn) => fn()),
    logError: vi.fn(),
    logMetric: vi.fn(),
    metrics: mockMetricsService,
    MetricsService: vi.fn(() => mockMetricsService),
    // Add missing createServiceMetrics function
    createServiceMetrics: vi.fn(serviceName => ({
      increment: vi.fn(),
      decrement: vi.fn(),
      gauge: vi.fn(),
      timing: vi.fn(),
      startTimer: vi.fn(() => ({ stop: vi.fn(() => 100) })),
      trackOperation: vi.fn(),
      getCounter: vi.fn(() => 0),
      getGauge: vi.fn(() => 0),
      reset: vi.fn(),
    })),
  };
});

// Mock cloudflare:workers with minimal implementation
vi.mock('cloudflare:workers', () => {
  return {
    // Empty object
  };
});

// Mock global objects for testing
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
