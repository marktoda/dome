import { resolve } from 'path';

import dotenv from 'dotenv';
import { z } from 'zod';

// Load environment variables
dotenv.config({ path: resolve(process.cwd(), '.env') });
dotenv.config({ path: resolve(process.cwd(), '.env.local') });

// Environment schema
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug', 'verbose']).default('info'),

  // Kafka configuration
  KAFKA_BROKERS: z.string().default('localhost:9092'),
  KAFKA_CLIENT_ID: z.string().default('dome2-client'),
  KAFKA_GROUP_ID: z.string().default('dome2-group'),

  // Database configuration
  DATABASE_URL: z.string().optional(),

  // Vector store configuration
  VECTOR_STORE_TYPE: z.enum(['weaviate', 'chroma', 'qdrant']).default('chroma'),
  WEAVIATE_URL: z.string().optional(),
  WEAVIATE_API_KEY: z.string().optional(),
  CHROMA_URL: z.string().default('http://localhost:8000'),
  QDRANT_URL: z.string().optional(),
  QDRANT_API_KEY: z.string().optional(),

  // OpenAI configuration
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  OPENAI_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),

  // Source connector secrets
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_PRIVATE_KEY: z.string().optional(),

  NOTION_TOKEN: z.string().optional(),

  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_APP_TOKEN: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),

  LINEAR_API_KEY: z.string().optional(),
  LINEAR_WEBHOOK_SECRET: z.string().optional(),

  // API configuration
  API_PORT: z.coerce.number().default(3000),
  API_HOST: z.string().default('0.0.0.0'),

  // LangSmith configuration
  LANGCHAIN_TRACING_V2: z.string().optional(),
  LANGCHAIN_API_KEY: z.string().optional(),
  LANGCHAIN_PROJECT: z.string().optional(),
});

// Parse and validate environment variables
const parseEnv = () => {
  try {
    return envSchema.parse(process.env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('❌ Invalid environment variables:');
      console.error(error.flatten().fieldErrors);
      process.exit(1);
    }
    throw error;
  }
};

export const config = parseEnv();

// Export specific configuration groups
export const kafkaConfig = {
  brokers: config.KAFKA_BROKERS.split(','),
  clientId: config.KAFKA_CLIENT_ID,
  groupId: config.KAFKA_GROUP_ID,
};

export const vectorStoreConfig = {
  type: config.VECTOR_STORE_TYPE,
  weaviate: {
    url: config.WEAVIATE_URL,
    apiKey: config.WEAVIATE_API_KEY,
  },
  chroma: {
    url: config.CHROMA_URL,
  },
  qdrant: {
    url: config.QDRANT_URL,
    apiKey: config.QDRANT_API_KEY,
  },
};

export const openAIConfig = {
  apiKey: config.OPENAI_API_KEY,
  model: config.OPENAI_MODEL,
  embeddingModel: config.OPENAI_EMBEDDING_MODEL,
};

export const apiConfig = {
  port: config.API_PORT,
  host: config.API_HOST,
};

// Type exports
export type Config = z.infer<typeof envSchema>;
export type VectorStoreType = Config['VECTOR_STORE_TYPE'];
export type LogLevel = Config['LOG_LEVEL'];
export type Environment = Config['NODE_ENV'];
