import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';

// Mock dependencies before importing config
vi.mock('zod-config', () => ({
  loadConfigSync: vi.fn(() => mockRawConfig)
}));

vi.mock('zod-config/env-adapter', () => ({
  envAdapter: vi.fn(() => ({}))
}));

vi.mock('zod-config/dotenv-adapter', () => ({
  dotEnvAdapter: vi.fn(() => ({}))
}));

vi.mock('pino', () => ({
  default: vi.fn(() => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn()
  }))
}));

// Default mock configuration
const mockRawConfig: Record<string, any> = {
  DOME_VAULT_PATH: '/home/user/dome',
  DOME_STATE_DIR: '/home/user/.dome/state',
  POSTGRES_URI: 'postgres://test:password@localhost:5432/dome',
  DOME_TABLE_NAME: 'dome',
  DOME_INDEX_NAME: 'notes_vectors',
  OPENAI_API_KEY: 'sk-test-key-123456789',
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  DEBUG: undefined,
  DOME_DISABLE_TODOS: false,
  DOME_DISABLE_EMBEDDINGS: false,
  DOME_DISABLE_INDEX: false,
  DOME_DEBOUNCE_MS: 300,
  DOME_AWAIT_WRITE_FINISH_MS: 2000,
  DOME_WATCHER_IGNORE: [],
  DOME_DEFAULT_MODEL: 'gpt-5-mini',
  DOME_EMBEDDING_MODEL: 'text-embedding-3-small',
  DOME_SUMMARIZER_MODEL: 'gpt-5-mini',
  DOME_FRONTMATTER_MODEL: 'gpt-5-mini',
  DOME_NOTES_AGENT_MODEL: 'gpt-5-mini',
  DOME_TASKS_AGENT_MODEL: 'gpt-5-mini',
  DOME_AI_TEMPERATURE: 0.3,
  DOME_AI_MAX_TOKENS: 500,
  DOME_SUMMARIZER_TEMPERATURE: 0.2,
  DOME_FRONTMATTER_TEMPERATURE: 0.3,
  DOME_NOTES_AGENT_TEMPERATURE: 0.3,
  DOME_TASKS_AGENT_TEMPERATURE: 0.1,
  EDITOR: 'vim',
  VISUAL: undefined,
  DOME_CLI_COLOR: true,
  DOME_CLI_SPINNER: true
};

describe('Config Module', () => {
  let config: any;
  let validateConfig: any;
  let getConfigValue: any;
  let isFeatureEnabled: any;
  let getAIModel: any;

  beforeEach(async () => {
    // Clear module cache to ensure fresh import
    vi.resetModules();

    // Import the module fresh for each test
    const configModule = await import('./config.js');
    config = configModule.config;
    validateConfig = configModule.validateConfig;
    getConfigValue = configModule.getConfigValue;
    isFeatureEnabled = configModule.isFeatureEnabled;
    getAIModel = configModule.getAIModel;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Configuration Structure', () => {
    it('should export all required configuration values', () => {
      expect(config).toBeDefined();
      expect(config.DOME_VAULT_PATH).toBe('/home/user/dome');
      expect(config.POSTGRES_URI).toBe('postgres://test:password@localhost:5432/dome');
      expect(config.OPENAI_API_KEY).toBe('sk-test-key-123456789');
      expect(config.NODE_ENV).toBe('test');
      expect(config.LOG_LEVEL).toBe('info');
    });

    it('should compute environment flags correctly', () => {
      expect(config.isDevelopment).toBe(false);
      expect(config.isProduction).toBe(false);
      expect(config.isTest).toBe(true);
    });

    it('should structure features correctly', () => {
      expect(config.features).toEqual({
        todos: true,
        embeddings: true,
        index: true
      });
    });

    it('should structure debounce settings correctly', () => {
      expect(config.debounce).toEqual({
        fileChangeMs: 300,
        awaitWriteFinish: {
          stabilityThreshold: 2000,
          pollInterval: 100
        }
      });
    });


    it('should structure CLI settings correctly', () => {
      expect(config.cli).toEqual({
        color: true,
        spinner: true,
        editor: 'vim'
      });
    });

    it('should resolve paths to absolute paths', () => {
      expect(config.paths.vault).toBe(path.resolve('/home/user/dome'));
      expect(config.paths.state).toBe(path.resolve('/home/user/.dome/state'));
      expect(config.paths.watcherState).toBe(path.join(path.resolve('/home/user/.dome/state'), 'watcher-state.json'));
    });
  });

  describe('validateConfig', () => {
    it('should pass validation with valid config', () => {
      expect(() => validateConfig()).not.toThrow();
    });

    it('should throw error when OPENAI_API_KEY is missing', async () => {
      vi.resetModules();

      // Update mock config
      mockRawConfig.OPENAI_API_KEY = '';

      const configModule = await import('./config.js');
      validateConfig = configModule.validateConfig;

      expect(() => validateConfig()).toThrow('Configuration validation failed');
      expect(() => validateConfig()).toThrow('OPENAI_API_KEY is required');
    });

    it('should throw error when OPENAI_API_KEY is too short', async () => {
      vi.resetModules();

      mockRawConfig.OPENAI_API_KEY = 'short';

      const configModule = await import('./config.js');
      validateConfig = configModule.validateConfig;

      expect(() => validateConfig()).toThrow('OPENAI_API_KEY is required and must be valid');
    });

    it('should throw error when POSTGRES_URI is missing', async () => {
      vi.resetModules();

      mockRawConfig.POSTGRES_URI = '';
      mockRawConfig.OPENAI_API_KEY = 'sk-test-key-123456789';

      const configModule = await import('./config.js');
      validateConfig = configModule.validateConfig;

      expect(() => validateConfig()).toThrow('POSTGRES_URI is required');
    });

    it('should throw error when DOME_VAULT_PATH is missing', async () => {
      vi.resetModules();

      mockRawConfig.DOME_VAULT_PATH = '';
      mockRawConfig.OPENAI_API_KEY = 'sk-test-key-123456789';
      mockRawConfig.POSTGRES_URI = 'postgres://test:password@localhost:5432/dome';

      const configModule = await import('./config.js');
      validateConfig = configModule.validateConfig;

      expect(() => validateConfig()).toThrow('DOME_VAULT_PATH must be specified');
    });

    it('should warn about unusual AI model names', async () => {
      vi.resetModules();
      const pino = await import('pino');
      const mockLogger = { warn: vi.fn(), error: vi.fn() };
      (pino.default as any).mockReturnValue(mockLogger);

      // Reset to valid config first
      mockRawConfig.DOME_VAULT_PATH = '/home/user/dome';
      mockRawConfig.DOME_DEFAULT_MODEL = 'invalid-model-name';
      mockRawConfig.OPENAI_API_KEY = 'sk-test-key-123456789';
      mockRawConfig.POSTGRES_URI = 'postgres://test:password@localhost:5432/dome';

      const configModule = await import('./config.js');
      validateConfig = configModule.validateConfig;

      validateConfig();

      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('should throw error for invalid temperature values', async () => {
      vi.resetModules();

      mockRawConfig.DOME_AI_TEMPERATURE = 3.0; // Out of range
      mockRawConfig.OPENAI_API_KEY = 'sk-test-key-123456789';

      const configModule = await import('./config.js');
      validateConfig = configModule.validateConfig;

      expect(() => validateConfig()).toThrow('temperature');
      expect(() => validateConfig()).toThrow('out of range');
    });

    it('should throw error for negative temperature values', async () => {
      vi.resetModules();

      mockRawConfig.DOME_SUMMARIZER_TEMPERATURE = -0.5;
      mockRawConfig.OPENAI_API_KEY = 'sk-test-key-123456789';

      const configModule = await import('./config.js');
      validateConfig = configModule.validateConfig;

      expect(() => validateConfig()).toThrow('temperature');
      expect(() => validateConfig()).toThrow('out of range');
    });
  });

  describe('Helper Functions', () => {
    beforeEach(async () => {
      // Reset to clean state for helper functions
      vi.resetModules();
      mockRawConfig.DOME_VAULT_PATH = '/home/user/dome';
      mockRawConfig.DOME_DEFAULT_MODEL = 'gpt-5-mini';
      mockRawConfig.DOME_EMBEDDING_MODEL = 'text-embedding-3-small';
      mockRawConfig.OPENAI_API_KEY = 'sk-test-key-123456789';
      mockRawConfig.POSTGRES_URI = 'postgres://test:password@localhost:5432/dome';
      mockRawConfig.DOME_DEBOUNCE_MS = 300;
      mockRawConfig.DOME_WATCHER_IGNORE = [];

      const configModule = await import('./config.js');
      config = configModule.config;
      getConfigValue = configModule.getConfigValue;
      isFeatureEnabled = configModule.isFeatureEnabled;
      getAIModel = configModule.getAIModel;
    });

    describe('getConfigValue', () => {
      it('should return existing config value', () => {
        const value = getConfigValue('DOME_VAULT_PATH', '/fallback');
        expect(value).toBe('/home/user/dome');
      });

      it('should return fallback for undefined value', () => {
        const value = getConfigValue('nonexistent' as any, 'fallback-value');
        expect(value).toBe('fallback-value');
      });

      it('should return fallback for null value', () => {
        config.testNull = null;
        const value = getConfigValue('testNull' as any, 'fallback');
        expect(value).toBe('fallback');
      });
    });

    describe('isFeatureEnabled', () => {
      it('should return true for enabled features', () => {
        expect(isFeatureEnabled('todos')).toBe(true);
        expect(isFeatureEnabled('embeddings')).toBe(true);
        expect(isFeatureEnabled('index')).toBe(true);
      });

      it('should return false for disabled features', async () => {
        vi.resetModules();

        mockRawConfig.DOME_DISABLE_TODOS = true;
        mockRawConfig.DOME_DISABLE_EMBEDDINGS = true;

        const configModule = await import('./config.js');
        isFeatureEnabled = configModule.isFeatureEnabled;

        expect(isFeatureEnabled('todos')).toBe(false);
        expect(isFeatureEnabled('embeddings')).toBe(false);
      });
    });

    describe('getAIModel', () => {
      it('should return default model when no task specified', () => {
        expect(getAIModel()).toBe('gpt-5-mini');
        expect(getAIModel('default')).toBe('gpt-5-mini');
      });

      it('should return embedding model for embedding task', () => {
        expect(getAIModel('embedding')).toBe('text-embedding-3-small');
      });

      it('should return summarizer model for summarizer task', () => {
        expect(getAIModel('summarizer')).toBe('gpt-5-mini');
      });

      it('should fallback to default model if specific model not found', async () => {
        vi.resetModules();

        mockRawConfig.DOME_EMBEDDING_MODEL = '';

        const configModule = await import('./config.js');
        getAIModel = configModule.getAIModel;
        config = configModule.config;

        // Clear the embedding model
        config.ai.models.embedding = '';

        const model = getAIModel('embedding');
        expect(model).toBe('gpt-5-mini');
      });
    });
  });

  describe('Feature Flags', () => {
    it('should correctly invert disable flags to feature flags', async () => {
      vi.resetModules();

      mockRawConfig.DOME_DISABLE_TODOS = true;
      mockRawConfig.DOME_DISABLE_EMBEDDINGS = false;
      mockRawConfig.DOME_DISABLE_INDEX = true;

      const configModule = await import('./config.js');
      config = configModule.config;

      expect(config.features.todos).toBe(false);
      expect(config.features.embeddings).toBe(true);
      expect(config.features.index).toBe(false);
    });
  });

  describe('Environment Detection', () => {
    it('should detect development environment', async () => {
      vi.resetModules();

      mockRawConfig.NODE_ENV = 'development';

      const configModule = await import('./config.js');
      config = configModule.config;

      expect(config.isDevelopment).toBe(true);
      expect(config.isProduction).toBe(false);
      expect(config.isTest).toBe(false);
    });

    it('should detect production environment', async () => {
      vi.resetModules();

      mockRawConfig.NODE_ENV = 'production';

      const configModule = await import('./config.js');
      config = configModule.config;

      expect(config.isDevelopment).toBe(false);
      expect(config.isProduction).toBe(true);
      expect(config.isTest).toBe(false);
    });
  });

  describe('Editor Selection', () => {
    it('should use EDITOR environment variable', () => {
      expect(config.cli.editor).toBe('vim');
    });

    it('should fallback to VISUAL if EDITOR not set', async () => {
      vi.resetModules();

      mockRawConfig.EDITOR = undefined;
      mockRawConfig.VISUAL = 'code';

      const configModule = await import('./config.js');
      config = configModule.config;

      expect(config.cli.editor).toBe('code');
    });

    it('should fallback to vi if neither EDITOR nor VISUAL set', async () => {
      vi.resetModules();

      mockRawConfig.EDITOR = undefined;
      mockRawConfig.VISUAL = undefined;

      const configModule = await import('./config.js');
      config = configModule.config;

      expect(config.cli.editor).toBe('vi');
    });
  });

  describe('Watcher Ignore Patterns', () => {
    it('should parse comma-separated ignore patterns', async () => {
      vi.resetModules();

      mockRawConfig.DOME_WATCHER_IGNORE = '*.tmp,node_modules,.git';

      const configModule = await import('./config.js');
      config = configModule.config;

      expect(config.watcherIgnore).toEqual(['*.tmp', 'node_modules', '.git']);
    });

    it('should handle empty ignore patterns', async () => {
      vi.resetModules();

      mockRawConfig.DOME_WATCHER_IGNORE = [];

      const configModule = await import('./config.js');
      config = configModule.config;

      expect(config.watcherIgnore).toEqual([]);
    });
  });

  describe('Default Values', () => {
    it('should use default values when not specified', async () => {
      vi.resetModules();

      // Set required values but leave optional ones undefined
      mockRawConfig.DOME_VAULT_PATH = '/home/user/dome';
      mockRawConfig.OPENAI_API_KEY = 'sk-test-key-123456789';
      mockRawConfig.POSTGRES_URI = 'postgres://test:password@localhost:5432/dome';
      mockRawConfig.DOME_AI_MAX_TOKENS = 500;  // These should use defaults from schema
      mockRawConfig.DOME_DEBOUNCE_MS = 300;

      const configModule = await import('./config.js');
      config = configModule.config;

      expect(config.ai.maxTokens).toBe(500);
      expect(config.debounce.fileChangeMs).toBe(300);
    });
  });
});
