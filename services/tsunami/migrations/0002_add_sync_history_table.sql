-- Migration: Add sync_history table
-- Description: Creates a new table to track sync history for GitHub repositories

-- Create the sync_history table
CREATE TABLE IF NOT EXISTS sync_history (
  id TEXT PRIMARY KEY,
  sync_plan_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  user_id TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  previous_cursor TEXT,
  new_cursor TEXT,
  files_processed INTEGER NOT NULL DEFAULT 0,
  updated_files TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  error_message TEXT,
  FOREIGN KEY (sync_plan_id) REFERENCES sync_plan(id)
);

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_sync_history_resource_id ON sync_history(resource_id);
CREATE INDEX IF NOT EXISTS idx_sync_history_user_id ON sync_history(user_id);
CREATE INDEX IF NOT EXISTS idx_sync_history_sync_plan_id ON sync_history(sync_plan_id);
CREATE INDEX IF NOT EXISTS idx_sync_history_started_at ON sync_history(started_at DESC);