import { z } from 'zod';
import type { SiloBinding } from '@dome/silo/client';

export const TsunamiEnvSchema = z.object({
  VERSION: z.string(),
  ENVIRONMENT: z.string(),
  LOG_LEVEL: z.string(),
  GITHUB_TOKEN: z.string(),
  TOKEN_ENCRYPTION_KEY: z.string(),
  NOTION_CLIENT_ID: z.string().optional(),
  NOTION_CLIENT_SECRET: z.string().optional(),
  NOTION_REDIRECT_URI: z.string().optional(),
  RESOURCE_OBJECT: z.any(),
  SYNC_PLAN: z.any(),
  SILO: z.any(),
  SILO_INGEST_QUEUE: z.any(),
});

export type ServiceEnv = z.infer<typeof TsunamiEnvSchema> & { SILO: SiloBinding };
