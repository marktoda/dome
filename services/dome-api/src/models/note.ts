import { z } from 'zod';

/**
 * Embedding status enum
 */
export enum EmbeddingStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed'
}

/**
 * Note interface
 */
export interface Note {
  id: string;
  userId: string;
  title: string;
  body: string;
  contentType: string;
  r2Key?: string;
  metadata?: string;
  createdAt: number;
  updatedAt: number;
  embeddingStatus: EmbeddingStatus;
}

/**
 * Note page interface
 */
export interface NotePage {
  id: string;
  noteId: string;
  pageNum: number;
  content: string;
  createdAt: number;
}

/**
 * Zod schema for validating note creation
 */
export const createNoteSchema = z.object({
  userId: z.string().min(1, 'User ID is required'),
  title: z.string().min(1, 'Title is required'),
  body: z.string().min(1, 'Body is required'),
  contentType: z.string().min(1, 'Content type is required'),
  r2Key: z.string().optional(),
  metadata: z.string().optional()
});

/**
 * Type for note creation data
 */
export type CreateNoteData = z.infer<typeof createNoteSchema>;

/**
 * Zod schema for validating note updates
 */
export const updateNoteSchema = z.object({
  title: z.string().min(1, 'Title is required').optional(),
  body: z.string().min(1, 'Body is required').optional(),
  contentType: z.string().min(1, 'Content type is required').optional(),
  r2Key: z.string().optional(),
  metadata: z.string().optional(),
  embeddingStatus: z.enum([
    EmbeddingStatus.PENDING,
    EmbeddingStatus.PROCESSING,
    EmbeddingStatus.COMPLETED,
    EmbeddingStatus.FAILED
  ]).optional()
});

/**
 * Type for note update data
 */
export type UpdateNoteData = z.infer<typeof updateNoteSchema>;

/**
 * Zod schema for validating note page creation
 */
export const createNotePageSchema = z.object({
  noteId: z.string().min(1, 'Note ID is required'),
  pageNum: z.number().int().min(1, 'Page number must be a positive integer'),
  content: z.string().min(1, 'Content is required')
});

/**
 * Type for note page creation data
 */
export type CreateNotePageData = z.infer<typeof createNotePageSchema>;