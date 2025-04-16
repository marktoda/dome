import { z } from 'zod';

/**
 * Zod schema for a single Telegram message
 */
export const telegramMessageSchema = z
  .object({
    id: z.string({
      required_error: 'Message ID is required',
      invalid_type_error: 'Message ID must be a string',
    }),
    timestamp: z.string({
      required_error: 'Timestamp is required',
      invalid_type_error: 'Timestamp must be a string',
    }),
    platform: z.literal('telegram', {
      required_error: 'Platform is required',
      invalid_type_error: 'Platform must be "telegram"',
    }),
    content: z.string({
      required_error: 'Message body cannot be undefined',
      invalid_type_error: 'Content must be a string',
    }),
    chatId: z.string({
      required_error: 'Chat ID is required in metadata',
      invalid_type_error: 'Chat ID must be a string',
    }),
    messageId: z.string({
      required_error: 'Message ID is required in metadata',
      invalid_type_error: 'Message ID must be a string',
    }),
    fromUserId: z.string().optional(),
    fromUsername: z.string().optional(),
    mediaType: z.string().optional(),
    mediaUrl: z.string().optional(),
  })
  .strict();

/**
 * Zod schema for a batch of Telegram messages
 */
export const telegramMessageBatchSchema = z
  .object({
    messages: z.array(telegramMessageSchema, {
      required_error: 'Messages array is required',
      invalid_type_error: 'Messages must be an array',
    }),
  })
  .strict();

/**
 * Type for validation errors
 */
export type ValidationError = {
  code: string;
  message: string;
  path?: (string | number)[];
  details?: Record<string, any>;
};

/**
 * Format Zod errors into a standardized format
 */
export function formatZodError(error: z.ZodError): ValidationError[] {
  return error.errors.map(err => ({
    code: 'VALIDATION_ERROR',
    message: err.message,
    path: err.path,
  }));
}

/**
 * Format validation errors for a batch of messages
 */
export function formatBatchErrors(errors: { index: number; errors: ValidationError[] }[]): string {
  const invalidIndexes = errors.map(e => e.index).join(', ');
  const errorMessages = errors
    .map(e => `Message at index ${e.index}: ${e.errors.map(err => err.message).join(', ')}`)
    .join(', ');

  return `Invalid messages at indexes: ${invalidIndexes}, ${errorMessages}`;
}
