import { z } from 'zod';
import { formatZodError } from '../utils/zodUtils.js';

/**
 * Validate and load a service's environment variables.
 *
 * @param schema Zod schema describing the expected environment shape
 * @param env Raw environment object
 * @returns Parsed environment of type T
 * @throws Error when validation fails
 */
export function loadEnv<T>(schema: z.ZodTypeAny, env: unknown): T {
  const result = schema.safeParse(env);
  if (!result.success) {
    const formatted = formatZodError(result.error);
    throw new Error(`Invalid environment: ${JSON.stringify(formatted)}`);
  }
  return result.data;
}
