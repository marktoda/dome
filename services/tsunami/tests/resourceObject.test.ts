import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResourceObject, Config } from '../src/resourceObject';
import { ProviderType } from '../src/providers';

// Define mock types
type MockContext = {
  blockConcurrencyWhile: (fn: () => Promise<any>) => Promise<any>;
  storage: {
    get: (key: string) => Promise<any>;
    put: (key: string, value: any) => Promise<void>;
    setAlarm: (timestamp: number) => Promise<void>;
  };
};

// Mock dependencies
vi.mock('cloudflare:workers', () => {
  return {
    DurableObject: class MockDurableObject {
      constructor() {}
    }
  };
});

vi.mock('@dome/logging', () => {
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  
  return {
    getLogger: () => mockLogger,
    logError: vi.fn(),
    metrics: {
      increment: vi.fn(),
      timing: vi.fn(),
    }
  };
});

vi.mock('@dome/silo/client', () => {
  const mockUpload = vi.fn().mockResolvedValue(['id1', 'id2']);
  
  return {
    SiloClient: class {
      constructor() {}
      upload = mockUpload;
    }
  };
});

vi.mock('../src/providers', () => {
  return {
    ProviderType: {
      GITHUB: 'github',
      NOTION: 'notion',
      WEBSITE: 'website'
    },
    GithubProvider: class {
      constructor() {}
      pull = vi.fn().mockResolvedValue({ contents: [], newCursor: null });
    },
    NotionProvider: class {
      constructor() {}
      pull = vi.fn().mockResolvedValue({ contents: [], newCursor: null });
    },
    WebsiteProvider: class {
      constructor() {}
      pull = vi.fn().mockResolvedValue({ contents: [], newCursor: null });
    },
    Provider: class {}
  };
});

vi.mock('../src/db/client', () => {
  return {
    syncHistoryOperations: {
      create: vi.fn().mockResolvedValue(true)
    },
    syncPlanOperations: {
      findByResourceId: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(true)
    }
  };
});

vi.mock('ulid', () => {
  return {
    ulid: () => 'test-ulid'
  };
});

describe('ResourceObject', () => {
  let mockCtx: MockContext;
  let mockEnv: any;
  let resourceObject: any;

  beforeEach(() => {
    mockCtx = {
      blockConcurrencyWhile: vi.fn((fn) => fn()),
      storage: {
        get: vi.fn(),
        put: vi.fn(),
        setAlarm: vi.fn()
      }
    };
    
    mockEnv = {
      VERSION: '1.0.0',
      ENVIRONMENT: 'test',
      LOG_LEVEL: 'info',
      GITHUB_TOKEN: 'test-token',
      NOTION_API_KEY: 'test-api-key',
      RESOURCE_OBJECT: {},
      SILO: {},
      SILO_INGEST_QUEUE: {},
      SYNC_PLAN: {}
    };
    
    vi.clearAllMocks();
    resourceObject = new ResourceObject(mockCtx, mockEnv);
  });

  describe('validate method', () => {
    it('should validate GitHub resource IDs', async () => {
      const validConfig: Partial<Config> = {
        providerType: ProviderType.GITHUB,
        resourceId: 'owner/repo'
      };

      // Should not throw
      await resourceObject.initialize(validConfig);
      expect(mockCtx.storage.put).toHaveBeenCalled();
    });

    it('should reject invalid GitHub resource IDs', async () => {
      const invalidConfig: Partial<Config> = {
        providerType: ProviderType.GITHUB,
        resourceId: 'invalid-format'
      };

      await expect(resourceObject.initialize(invalidConfig)).rejects.toThrow('Invalid resourceId');
    });

    it('should validate Notion resource IDs', async () => {
      const validConfig: Partial<Config> = {
        providerType: ProviderType.NOTION,
        resourceId: '12345678-1234-1234-1234-123456789abc' // Valid UUID format
      };

      // Should not throw
      await resourceObject.initialize(validConfig);
      expect(mockCtx.storage.put).toHaveBeenCalled();
    });

    it('should reject invalid Notion resource IDs', async () => {
      const invalidConfig: Partial<Config> = {
        providerType: ProviderType.NOTION,
        resourceId: 'invalid-uuid-format'
      };

      await expect(resourceObject.initialize(invalidConfig)).rejects.toThrow('Invalid Notion resourceId');
    });

    it('should validate Website resource IDs', async () => {
      const validConfig: Partial<Config> = {
        providerType: ProviderType.WEBSITE,
        resourceId: JSON.stringify({ url: 'https://example.com' })
      };

      // Should not throw
      await resourceObject.initialize(validConfig);
      expect(mockCtx.storage.put).toHaveBeenCalled();
    });

    it('should reject invalid Website resource IDs', async () => {
      const invalidConfig: Partial<Config> = {
        providerType: ProviderType.WEBSITE,
        resourceId: '{"invalid": "json"}'
      };

      await expect(resourceObject.initialize(invalidConfig)).rejects.toThrow('Website configuration must include a URL property');
    });
  });
});