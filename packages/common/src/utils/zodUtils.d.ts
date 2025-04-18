import { ZodError } from 'zod';
/**
 * Format Zod validation errors into a more user-friendly format
 *
 * @param error The Zod error to format
 * @returns A formatted error object
 */
export declare function formatZodError(error: ZodError): Record<string, any>;
