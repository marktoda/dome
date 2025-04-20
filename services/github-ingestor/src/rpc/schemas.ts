import { z } from 'zod';

/**
 * Common schema for repository identification
 */
export const repositoryIdentifierSchema = z.object({
  id: z.string().min(1, 'Repository ID is required')
});

/**
 * Schema for creating a new repository configuration
 */
export const createRepositorySchema = z.object({
  userId: z.string().min(1, 'User ID is required'),
  provider: z.string().min(1, 'Provider is required'),
  owner: z.string().min(1, 'Repository owner is required'),
  repo: z.string().min(1, 'Repository name is required'),
  branch: z.string().optional().default('main'),
  isPrivate: z.boolean().optional().default(false),
  includePatterns: z.array(z.string()).optional(),
  excludePatterns: z.array(z.string()).optional()
});

/**
 * Schema for updating a repository configuration
 */
export const updateRepositorySchema = z.object({
  id: z.string().min(1, 'Repository ID is required'),
  branch: z.string().optional(),
  isPrivate: z.boolean().optional(),
  includePatterns: z.array(z.string()).optional(),
  excludePatterns: z.array(z.string()).optional()
});

/**
 * Schema for listing repositories
 */
export const listRepositoriesSchema = z.object({
  userId: z.string().min(1, 'User ID is required'),
  provider: z.string().optional()
});

/**
 * Schema for triggering a repository sync
 */
export const syncRepositorySchema = z.object({
  id: z.string().min(1, 'Repository ID is required'),
  force: z.boolean().optional().default(false)
});

/**
 * Schema for getting repository sync status
 */
export const getRepositoryStatusSchema = z.object({
  id: z.string().min(1, 'Repository ID is required')
});

/**
 * Schema for GitHub App installation
 */
export const installationSchema = z.object({
  userId: z.string().min(1, 'User ID is required'),
  installationId: z.string().min(1, 'Installation ID is required')
});

/**
 * Schema for listing GitHub App installations
 */
export const listInstallationsSchema = z.object({
  userId: z.string().min(1, 'User ID is required')
});

/**
 * Schema for getting ingestion statistics
 */
export const getStatisticsSchema = z.object({
  userId: z.string().optional(),
  provider: z.string().optional(),
  timeRange: z.enum(['day', 'week', 'month']).optional().default('day')
});

/**
 * Response schemas
 */

export const repositoryResponseSchema = z.object({
  id: z.string(),
  userId: z.string(),
  provider: z.string(),
  owner: z.string(),
  repo: z.string(),
  branch: z.string(),
  isPrivate: z.boolean(),
  includePatterns: z.array(z.string()).optional(),
  excludePatterns: z.array(z.string()).optional(),
  lastSyncedAt: z.number().optional(),
  lastCommitSha: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number()
});

export const repositoryStatusResponseSchema = z.object({
  id: z.string(),
  lastSyncedAt: z.number().optional(),
  lastCommitSha: z.string().optional(),
  retryCount: z.number(),
  nextRetryAt: z.number().optional(),
  rateLimitReset: z.number().optional(),
  status: z.enum(['idle', 'syncing', 'failed', 'rate_limited']),
  error: z.string().optional()
});

export const installationResponseSchema = z.object({
  id: z.string(),
  userId: z.string(),
  provider: z.string(),
  installationId: z.string(),
  account: z.string(),
  createdAt: z.number(),
  updatedAt: z.number()
});

export const statisticsResponseSchema = z.object({
  totalRepositories: z.number(),
  totalFiles: z.number(),
  totalSizeBytes: z.number(),
  syncedRepositories: z.number(),
  failedRepositories: z.number(),
  lastSyncTime: z.number().optional()
});

/**
 * Type definitions for schemas
 */
export type CreateRepositoryRequest = z.infer<typeof createRepositorySchema>;
export type UpdateRepositoryRequest = z.infer<typeof updateRepositorySchema>;
export type ListRepositoriesRequest = z.infer<typeof listRepositoriesSchema>;
export type SyncRepositoryRequest = z.infer<typeof syncRepositorySchema>;
export type GetRepositoryStatusRequest = z.infer<typeof getRepositoryStatusSchema>;
export type InstallationRequest = z.infer<typeof installationSchema>;
export type ListInstallationsRequest = z.infer<typeof listInstallationsSchema>;
export type GetStatisticsRequest = z.infer<typeof getStatisticsSchema>;

export type RepositoryResponse = z.infer<typeof repositoryResponseSchema>;
export type RepositoryStatusResponse = z.infer<typeof repositoryStatusResponseSchema>;
export type InstallationResponse = z.infer<typeof installationResponseSchema>;
export type StatisticsResponse = z.infer<typeof statisticsResponseSchema>;