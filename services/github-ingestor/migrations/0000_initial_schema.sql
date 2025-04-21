-- Migration: 0000_initial_schema
-- Description: Initial schema for GitHub Ingestor

-- Main repository configuration table
CREATE TABLE provider_repositories (
  id TEXT PRIMARY KEY,                -- ulid/uuid
  userId TEXT NOT NULL,               -- User who added this repository (NULL for system repos)
  provider TEXT NOT NULL,             -- 'github', 'linear', 'notion'
  owner TEXT NOT NULL,                -- Repository owner/organization
  repo TEXT NOT NULL,                 -- Repository name
  branch TEXT NOT NULL DEFAULT 'main',-- Branch to monitor (GitHub only)
  lastSyncedAt INTEGER,               -- Last successful sync timestamp (epoch seconds)
  lastCommitSha TEXT,                 -- Last processed commit SHA (GitHub only)
  etag TEXT,                          -- ETag for conditional requests
  rateLimitReset INTEGER,             -- When rate limit resets (epoch seconds)
  retryCount INTEGER DEFAULT 0,       -- Number of failed attempts
  nextRetryAt INTEGER,                -- When to retry after failure (epoch seconds)
  isPrivate BOOLEAN NOT NULL DEFAULT false, -- Whether the repo is private
  includePatterns TEXT,               -- JSON array of glob patterns to include (null = all)
  excludePatterns TEXT,               -- JSON array of glob patterns to exclude
  createdAt INTEGER NOT NULL,         -- When this config was created (epoch seconds)
  updatedAt INTEGER NOT NULL,         -- When this config was last updated (epoch seconds)
  UNIQUE (userId, provider, owner, repo) -- Prevent duplicates per user
);

-- Authentication credentials for providers
CREATE TABLE provider_credentials (
  id TEXT PRIMARY KEY,                -- ulid/uuid
  userId TEXT NOT NULL,               -- User who owns these credentials
  provider TEXT NOT NULL,             -- 'github', 'linear', 'notion'
  installationId TEXT,                -- GitHub App installation ID
  accessToken TEXT,                   -- User access token (encrypted)
  refreshToken TEXT,                  -- Refresh token (encrypted)
  tokenExpiry INTEGER,                -- When the token expires (epoch seconds)
  createdAt INTEGER NOT NULL,         -- When these credentials were created (epoch seconds)
  updatedAt INTEGER NOT NULL,         -- When these credentials were last updated (epoch seconds)
  UNIQUE (userId, provider)           -- One credential set per user per provider
);

-- Content blob deduplication table
CREATE TABLE content_blobs (
  sha TEXT PRIMARY KEY,               -- Content SHA-1 hash
  size INTEGER NOT NULL,              -- Content size in bytes
  r2Key TEXT NOT NULL UNIQUE,         -- R2 storage key
  mimeType TEXT NOT NULL,             -- Content MIME type
  createdAt INTEGER NOT NULL          -- When this blob was created (epoch seconds)
);

-- Repository file metadata table
CREATE TABLE repository_files (
  id TEXT PRIMARY KEY,                -- ulid/uuid
  repoId TEXT NOT NULL,               -- Reference to provider_repositories.id
  path TEXT NOT NULL,                 -- File path within repository
  sha TEXT NOT NULL,                  -- File content SHA-1 hash
  size INTEGER NOT NULL,              -- File size in bytes
  mimeType TEXT NOT NULL,             -- File MIME type
  lastModified INTEGER NOT NULL,      -- When file was last modified (epoch seconds)
  createdAt INTEGER NOT NULL,         -- When this record was created (epoch seconds)
  updatedAt INTEGER NOT NULL,         -- When this record was last updated (epoch seconds)
  FOREIGN KEY (repoId) REFERENCES provider_repositories(id) ON DELETE CASCADE,
  FOREIGN KEY (sha) REFERENCES content_blobs(sha) ON DELETE CASCADE,
  UNIQUE (repoId, path)               -- Prevent duplicates per repository
);

-- Create indexes for common query patterns
CREATE INDEX idx_provider_repositories_userId ON provider_repositories(userId);
CREATE INDEX idx_provider_repositories_provider ON provider_repositories(provider);
CREATE INDEX idx_provider_repositories_owner_repo ON provider_repositories(owner, repo);
CREATE INDEX idx_provider_repositories_lastSyncedAt ON provider_repositories(lastSyncedAt);
CREATE INDEX idx_provider_repositories_nextRetryAt ON provider_repositories(nextRetryAt);

CREATE INDEX idx_provider_credentials_userId ON provider_credentials(userId);
CREATE INDEX idx_provider_credentials_provider ON provider_credentials(provider);

CREATE INDEX idx_repository_files_repoId ON repository_files(repoId);
CREATE INDEX idx_repository_files_sha ON repository_files(sha);
CREATE INDEX idx_repository_files_path ON repository_files(path);