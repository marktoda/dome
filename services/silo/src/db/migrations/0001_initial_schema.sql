-- Migration: Initial Schema
-- Description: Creates the contents table for storing content metadata

CREATE TABLE contents (
  id          TEXT PRIMARY KEY,      -- ulid / uuid
  userId      TEXT,                  -- NULL for public objects
  contentType TEXT NOT NULL,         -- 'note'|'code'|'article'…
  size        INTEGER NOT NULL,
  r2Key       TEXT NOT NULL UNIQUE,
  sha256      TEXT,                  -- optional integrity / de‑dup
  createdAt   INTEGER NOT NULL,      -- epoch s
  version     INTEGER DEFAULT 1
);

-- Indexes for efficient querying
CREATE INDEX idx_contents_userId        ON contents(userId);
CREATE INDEX idx_contents_contentType   ON contents(contentType);
CREATE INDEX idx_contents_createdAt     ON contents(createdAt);