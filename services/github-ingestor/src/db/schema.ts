import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

/**
 * Main repository configuration table
 */
export const providerRepositories = sqliteTable('provider_repositories', {
  id: text('id').primaryKey(),
  userId: text('userId').notNull(),
  provider: text('provider').notNull(),
  owner: text('owner').notNull(),
  repo: text('repo').notNull(),
  branch: text('branch').notNull().default('main'),
  lastSyncedAt: integer('lastSyncedAt'),
  lastCommitSha: text('lastCommitSha'),
  etag: text('etag'),
  rateLimitReset: integer('rateLimitReset'),
  retryCount: integer('retryCount').default(0),
  nextRetryAt: integer('nextRetryAt'),
  isPrivate: integer('isPrivate', { mode: 'boolean' }).notNull().default(false),
  includePatterns: text('includePatterns'),
  excludePatterns: text('excludePatterns'),
  createdAt: integer('createdAt').notNull(),
  updatedAt: integer('updatedAt').notNull(),
});

/**
 * Authentication credentials for providers
 */
export const providerCredentials = sqliteTable('provider_credentials', {
  id: text('id').primaryKey(),
  userId: text('userId').notNull(),
  provider: text('provider').notNull(),
  installationId: text('installationId'),
  accessToken: text('accessToken'),
  refreshToken: text('refreshToken'),
  tokenExpiry: integer('tokenExpiry'),
  createdAt: integer('createdAt').notNull(),
  updatedAt: integer('updatedAt').notNull(),
});

/**
 * Content blob deduplication table
 */
export const contentBlobs = sqliteTable('content_blobs', {
  sha: text('sha').primaryKey(),
  size: integer('size').notNull(),
  r2Key: text('r2Key').notNull().unique(),
  mimeType: text('mimeType').notNull(),
  createdAt: integer('createdAt').notNull(),
});

/**
 * Repository file metadata table
 * Tracks individual files within repositories
 */
export const repositoryFiles = sqliteTable('repository_files', {
  id: text('id').primaryKey(),
  repoId: text('repoId').notNull(),
  path: text('path').notNull(),
  sha: text('sha').notNull(),
  size: integer('size').notNull(),
  mimeType: text('mimeType').notNull(),
  lastModified: integer('lastModified').notNull(),
  createdAt: integer('createdAt').notNull(),
  updatedAt: integer('updatedAt').notNull(),
});

// Export all tables for use in migrations and queries
export const schema = {
  providerRepositories,
  providerCredentials,
  contentBlobs,
  repositoryFiles,
};
