import { z } from 'zod';

/**
 * Example request schema - replace with actual service schemas
 */
export const exampleRequestSchema = z.object({
  input: z.string().min(1, 'Input is required'),
  options: z.object({
    timeout: z.number().positive().optional(),
    retries: z.number().int().min(0).max(5).optional(),
  }).optional(),
});

export type ExampleRequest = z.infer<typeof exampleRequestSchema>;

/**
 * Example response schema
 */
export const exampleResponseSchema = z.object({
  result: z.string(),
  timestamp: z.string(),
  metadata: z.record(z.any()).optional(),
});

export type ExampleResponse = z.infer<typeof exampleResponseSchema>;

/**
 * Health check schema
 */
export const healthCheckSchema = z.object({
  status: z.enum(['healthy', 'unhealthy']),
  service: z.string(),
  timestamp: z.string(),
  checks: z.record(z.boolean()).optional(),
});

export type HealthCheck = z.infer<typeof healthCheckSchema>;

/**
 * Error response schema
 */
export const errorResponseSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
  details: z.record(z.any()).optional(),
  timestamp: z.string().optional(),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;