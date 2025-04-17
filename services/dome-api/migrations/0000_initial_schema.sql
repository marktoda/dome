-- Migration: 0000_initial_schema.sql
-- Description: Initial schema for dome project
-- Creates tables for notes, tasks, and reminders

-- Notes table to store user notes and documents
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  content_type TEXT NOT NULL,
  r2_key TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  embedding_status TEXT DEFAULT 'pending'
);

-- Create index on user_id for faster queries
CREATE INDEX IF NOT EXISTS idx_notes_user_id ON notes(user_id);
CREATE INDEX IF NOT EXISTS idx_notes_created_at ON notes(created_at);

-- Note pages table for large documents that need page-level embeddings
CREATE TABLE IF NOT EXISTS note_pages (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL,
  page_num INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_note_pages_note_id ON note_pages(note_id);

-- Tasks table to store user tasks
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  priority TEXT DEFAULT 'medium',
  due_date INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);

-- Create indexes for tasks
CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);

-- Reminders table to store task reminders
CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  remind_at INTEGER NOT NULL,
  delivered BOOLEAN NOT NULL DEFAULT 0,
  delivery_method TEXT DEFAULT 'email',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

-- Create indexes for reminders
CREATE INDEX IF NOT EXISTS idx_reminders_task_id ON reminders(task_id);
CREATE INDEX IF NOT EXISTS idx_reminders_remind_at ON reminders(remind_at);
CREATE INDEX IF NOT EXISTS idx_reminders_delivered ON reminders(delivered);