import { vi } from 'vitest';

// Mock pino logger to prevent transport errors
vi.mock('pino', () => {
  return {
    default: vi.fn().mockReturnValue({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnValue({
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }),
    }),
  };
});

// Mock @dome/logging
vi.mock('@dome/logging', () => {
  const mockLogger = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnValue({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnThis(),
    })
  };
  
  // Make sure child also returns the same structure
  mockLogger.child.mockReturnValue(mockLogger);
  
  return {
    getLogger: vi.fn().mockReturnValue(mockLogger),
    withLogger: vi.fn((_, fn) => fn()),
  };
});

// Mock bcryptjs
vi.mock('bcryptjs', () => {
  return {
    hash: vi.fn().mockResolvedValue('hashed_password'),
    compare: vi.fn().mockResolvedValue(true),
  };
});

// Mock jose
vi.mock('jose', () => {
  return {
    SignJWT: vi.fn().mockReturnValue({
      setProtectedHeader: vi.fn().mockReturnThis(),
      sign: vi.fn().mockResolvedValue('mock_token'),
    }),
    jwtVerify: vi.fn().mockResolvedValue({
      payload: {
        userId: 'user_123',
        email: 'test@example.com',
        role: 'user',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
      }
    }),
  };
});

// Mock uuid
vi.mock('uuid', () => {
  return {
    v4: vi.fn().mockReturnValue('mock_uuid'),
  };
});

// Mock cloudflare:workers
vi.mock('cloudflare:workers', () => {
  return {};
});

// Mock drizzle-orm
vi.mock('drizzle-orm/d1', () => {
  const mockDb = {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue({}),
    }),
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    get: vi.fn().mockResolvedValue(null),
  };

  return {
    drizzle: vi.fn().mockReturnValue(mockDb),
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
    return Promise.resolve(typeof this.body === 'string' ? JSON.parse(this.body) : this.body);
  }

  text() {
    return Promise.resolve(typeof this.body === 'string' ? this.body : JSON.stringify(this.body));
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

// Mock KVNamespace
global.KVNamespace = class KVNamespace {
  constructor() {
    this.store = new Map();
  }

  async get(key) {
    return this.store.get(key) || null;
  }

  async put(key, value) {
    this.store.set(key, value);
    return value;
  }

  async delete(key) {
    return this.store.delete(key);
  }
};

// Mock D1Database
global.D1Database = class D1Database {
  constructor() {}

  prepare() {
    return {
      bind: () => ({
        run: vi.fn().mockResolvedValue({ success: true }),
        first: vi.fn().mockResolvedValue(null),
        all: vi.fn().mockResolvedValue({ results: [] }),
      }),
    };
  }

  batch() {
    return Promise.resolve([]);
  }
};