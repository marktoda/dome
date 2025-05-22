import { z } from 'zod';

export const SiloEnvSchema = z.object({
  LOG_LEVEL: z.string(),
  VERSION: z.string(),
  ENVIRONMENT: z.string(),
  BUCKET: z.any(),
  DB: z.any(),
  NEW_CONTENT_CONSTELLATION: z.any(),
  NEW_CONTENT_AI: z.any(),
  INGEST_DLQ: z.any().optional(),
  SILO_INGEST_QUEUE: z.any().optional(),
});

export type SiloEnv = z.infer<typeof SiloEnvSchema>;
