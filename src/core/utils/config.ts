/**
 * Centralized configuration management for the Dome application.
 * All environment variables and configuration settings should be accessed through this module.
 */

import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadConfigSync } from 'zod-config';
import { envAdapter } from 'zod-config/env-adapter';
import { dotEnvAdapter } from 'zod-config/dotenv-adapter';
import pino from 'pino';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Schema Definitions
// ============================================================================

/**
 * Core application configuration schema
 */
const coreSchema = z.object({
  // Paths
  DOME_VAULT_PATH: z.string().describe('Path to the note vault directory'),
  DOME_STATE_DIR: z.string().describe('Directory for persistent state files'),

  // Database
  POSTGRES_URI: z.string().describe('PostgreSQL connection string'),
  DOME_TABLE_NAME: z.string().default('dome').describe('Main database table name'),
  DOME_INDEX_NAME: z.string().default('notes_vectors').describe('Vector index name'),

  // API Keys
  OPENAI_API_KEY: z.string().min(1).describe('OpenAI API key for AI features'),

  // Application Settings
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DEBUG: z.string().optional().transform(val => val === 'true' || val === '1'),
});

/**
 * Watcher service configuration schema
 */
const watcherSchema = z.object({
  // Feature Flags
  DOME_DISABLE_TODOS: z.string().optional().transform(val => val === 'true').default('false'),
  DOME_DISABLE_EMBEDDINGS: z.string().optional().transform(val => val === 'true').default('false'),
  DOME_DISABLE_INDEX: z.string().optional().transform(val => val === 'true').default('false'),

  // Timing
  DOME_DEBOUNCE_MS: z.coerce.number().default(300).describe('File change debounce in milliseconds'),
  DOME_AWAIT_WRITE_FINISH_MS: z.coerce.number().default(2000).describe('Wait for write to finish in milliseconds'),

  // File Patterns
  DOME_WATCHER_IGNORE: z.string().optional().transform(val =>
    val ? val.split(',').map(s => s.trim()) : []
  ).default('').describe('Comma-separated list of patterns to ignore'),
});

/**
 * AI model configuration schema
 */
const aiSchema = z.object({
  // Model Selection - Using gpt-5-mini as the consistent default
  DOME_DEFAULT_MODEL: z.string().default('gpt-5-mini').describe('Default AI model for generation'),
  DOME_EMBEDDING_MODEL: z.string().default('text-embedding-3-small').describe('Model for embeddings'),
  DOME_SUMMARIZER_MODEL: z.string().default('gpt-5-mini').describe('Model for summarization'),
  DOME_FRONTMATTER_MODEL: z.string().default('gpt-5-mini').describe('Model for frontmatter extraction'),
  DOME_NOTES_AGENT_MODEL: z.string().default('gpt-5-mini').describe('Model for notes agent'),
  DOME_TASKS_AGENT_MODEL: z.string().default('gpt-5-mini').describe('Model for tasks agent'),

  // Model Parameters
  DOME_AI_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.3).describe('Default AI temperature'),
  DOME_AI_MAX_TOKENS: z.coerce.number().default(500).describe('Default max tokens for AI responses'),

  // Agent-specific temperatures
  DOME_SUMMARIZER_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2).describe('Temperature for summarization'),
  DOME_FRONTMATTER_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.3).describe('Temperature for frontmatter'),
  DOME_NOTES_AGENT_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.3).describe('Temperature for notes agent'),
  DOME_TASKS_AGENT_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.1).describe('Temperature for tasks agent'),
});

/**
 * CLI configuration schema
 */
const cliSchema = z.object({
  // Editor
  EDITOR: z.string().optional().describe('Preferred text editor'),
  VISUAL: z.string().optional().describe('Preferred visual editor'),

  // Display
  DOME_CLI_COLOR: z.string().optional().transform(val => val !== 'false').default('true'),
  DOME_CLI_SPINNER: z.string().optional().transform(val => val !== 'false').default('true'),
});

/**
 * Complete configuration schema
 */
const configSchema = z.object({
  ...coreSchema.shape,
  ...watcherSchema.shape,
  ...aiSchema.shape,
  ...cliSchema.shape,
});

// ============================================================================
// Configuration Loading
// ============================================================================

/**
 * Determine the home directory path based on platform
 */
function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || process.cwd();
}

/**
 * Load and validate configuration from environment
 */
const rawConfig = loadConfigSync({
  schema: configSchema,
  adapters: [
    // Load from .env files in order of precedence
    dotEnvAdapter({ path: path.join(process.cwd(), '.env.local'), silent: true }),
    dotEnvAdapter({ path: path.join(process.cwd(), '.env'), silent: true }),

    // Load from environment variables with defaults
    envAdapter({
      customEnv: {
        // Default paths
        DOME_VAULT_PATH: path.join(getHomeDir(), 'dome'),
        DOME_STATE_DIR: path.join(getHomeDir(), '.dome', 'state'),

        // Default database settings
        DOME_TABLE_NAME: 'dome',
        DOME_INDEX_NAME: 'notes_vectors',
        POSTGRES_URI: process.env.POSTGRES_URI || 'postgres://postgres:password@localhost:5432/dome',

        // Default API key (will fail validation if not provided elsewhere)
        OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',

        // Environment
        NODE_ENV: process.env.NODE_ENV || 'development',
        LOG_LEVEL: process.env.LOG_LEVEL || (process.env.DEBUG ? 'debug' : 'info'),
      },
    }),

    // Load from actual environment variables (highest priority)
    envAdapter({ silent: false }),
  ],
});

// ============================================================================
// Configuration Export
// ============================================================================

/**
 * Main configuration object with computed properties
 */
export const config = {
  ...rawConfig,

  // Computed properties
  isDevelopment: rawConfig.NODE_ENV === 'development',
  isProduction: rawConfig.NODE_ENV === 'production',
  isTest: rawConfig.NODE_ENV === 'test',

  // Watcher feature flags (inverted for easier use)
  features: {
    todos: !rawConfig.DOME_DISABLE_TODOS,
    embeddings: !rawConfig.DOME_DISABLE_EMBEDDINGS,
    index: !rawConfig.DOME_DISABLE_INDEX,
  },

  // Debounce settings
  debounce: {
    fileChangeMs: rawConfig.DOME_DEBOUNCE_MS,
    awaitWriteFinish: {
      stabilityThreshold: rawConfig.DOME_AWAIT_WRITE_FINISH_MS,
      pollInterval: 100,
    },
  },

  // AI settings
  ai: {
    models: {
      default: rawConfig.DOME_DEFAULT_MODEL || 'gpt-5-mini',
      embedding: rawConfig.DOME_EMBEDDING_MODEL || 'text-embedding-3-small',
      summarizer: rawConfig.DOME_SUMMARIZER_MODEL || 'gpt-5-mini',
      frontmatter: rawConfig.DOME_FRONTMATTER_MODEL || 'gpt-5-mini',
      notesAgent: rawConfig.DOME_NOTES_AGENT_MODEL || 'gpt-5-mini',
      tasksAgent: rawConfig.DOME_TASKS_AGENT_MODEL || 'gpt-5-mini',
    },
    temperature: {
      default: rawConfig.DOME_AI_TEMPERATURE || 0.3,
      summarizer: rawConfig.DOME_SUMMARIZER_TEMPERATURE || 0.2,
      frontmatter: rawConfig.DOME_FRONTMATTER_TEMPERATURE || 0.3,
      notesAgent: rawConfig.DOME_NOTES_AGENT_TEMPERATURE || 0.3,
      tasksAgent: rawConfig.DOME_TASKS_AGENT_TEMPERATURE || 0.1,
    },
    maxTokens: rawConfig.DOME_AI_MAX_TOKENS || 500,
  },

  // CLI settings
  cli: {
    color: rawConfig.DOME_CLI_COLOR,
    spinner: rawConfig.DOME_CLI_SPINNER,
    editor: rawConfig.EDITOR || rawConfig.VISUAL || 'vi',
  },

  // Paths (ensure they're absolute)
  paths: {
    vault: path.resolve(rawConfig.DOME_VAULT_PATH),
    state: path.resolve(rawConfig.DOME_STATE_DIR),
    watcherState: path.join(path.resolve(rawConfig.DOME_STATE_DIR), 'watcher-state.json'),
  },

  // Watcher ignore patterns
  watcherIgnore: rawConfig.DOME_WATCHER_IGNORE || [],
} as const;

// ============================================================================
// Configuration Validation
// ============================================================================

/**
 * Validate critical configuration at startup
 */
export function validateConfig(): void {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Critical: Check required API keys
  if (!config.OPENAI_API_KEY || config.OPENAI_API_KEY.length < 10) {
    errors.push('OPENAI_API_KEY is required and must be valid for AI features');
  }

  // Critical: Check database connection
  if (!config.POSTGRES_URI) {
    errors.push('POSTGRES_URI is required for database features');
  }

  // Critical: Check vault path exists or can be created
  if (!config.DOME_VAULT_PATH) {
    errors.push('DOME_VAULT_PATH must be specified');
  }

  // Validate AI model names follow OpenAI conventions
  const validModelPattern = /^(gpt-|text-embedding-|dall-e-)/;
  Object.entries(config.ai.models).forEach(([key, model]) => {
    if (model && !validModelPattern.test(model)) {
      warnings.push(`AI model '${key}' has unusual name: ${model}`);
    }
  });

  // Validate temperature ranges
  Object.entries(config.ai.temperature).forEach(([key, temp]) => {
    if (typeof temp === 'number' && (temp < 0 || temp > 2)) {
      errors.push(`AI temperature '${key}' out of range (0-2): ${temp}`);
    }
  });

  // Log warnings
  if (warnings.length > 0) {
    const logger = pino({ level: 'warn' });
    warnings.forEach(warning => logger.warn(warning));
  }

  // Handle errors
  if (errors.length > 0) {
    const logger = pino({ level: 'error' });
    const errorMessage = `Configuration validation failed:\n${errors.join('\n')}`;
    logger.error(errorMessage);

    // Always throw on critical errors
    throw new Error(errorMessage);
  }
}

// ============================================================================
// Type Exports
// ============================================================================

export type Config = typeof config;
export type CoreConfig = z.infer<typeof coreSchema>;
export type WatcherConfig = z.infer<typeof watcherSchema>;
export type AIConfig = z.infer<typeof aiSchema>;
export type CLIConfig = z.infer<typeof cliSchema>;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get a configuration value with a fallback
 */
export function getConfigValue<T>(key: keyof Config, fallback: T): T {
  return (config[key] as T) ?? fallback;
}

/**
 * Check if a feature is enabled
 */
export function isFeatureEnabled(feature: keyof typeof config.features): boolean {
  return config.features[feature];
}

/**
 * Get the appropriate AI model for a task
 */
export function getAIModel(task: 'default' | 'embedding' | 'summarizer' = 'default'): string {
  return config.ai.models[task] || config.DOME_DEFAULT_MODEL || 'gpt-5-mini';
}

// Export default for backward compatibility
export default config;
