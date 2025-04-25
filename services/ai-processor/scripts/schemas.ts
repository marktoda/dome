import { z } from 'zod';

// Define the schema for reprocess requests
export const ReprocessRequestSchema = z.object({
  id: z.string().optional(),
  userId: z.string(),
});

// Define the schema for reprocess responses
export const ReprocessResponseSchema = z.object({
  success: z.boolean(),
  reprocessed: z.union([
    z.object({
      id: z.string(),
      success: z.boolean(),
    }),
    z.object({
      total: z.number(),
      successful: z.number(),
    }),
  ]),
});
