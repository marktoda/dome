/**
 * Database Schema Module
 *
 * This module defines the database schema for the Tsunami service using Drizzle ORM.
 * It includes tables for tracking sync plans and their state.
 *
 * @module db/schema
 */

import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

/**
 * Sync Plans Table
 *
 * Stores information about external content sources that need to be synced.
 * Each row represents a single sync plan for a specific resource (e.g., GitHub repository).
 */
export const syncPlans = sqliteTable('sync_plan', {
  /** Unique identifier for the sync plan (ULID) */
  id: text('id').primaryKey(),

  /** User IDs who have access to this sync plan (stored as JSON array) */
  userIds: text('user_ids')
    .notNull()
    .$defaultFn(() => JSON.stringify([])),

  /** Provider type (github, notion, etc.) */
  provider: text('provider').notNull(),

  /** Resource identifier (repo name, page id, etc.) */
  resourceId: text('resource_id').notNull().unique(),
});

/**
 * Sync History Table
 *
 * Tracks each sync run, including timestamps, repository information, and which files were updated.
 * Each row represents a single sync operation for a specific resource.
 */
export const syncHistory = sqliteTable('sync_history', {
  /** Unique identifier for the sync history entry (ULID) */
  id: text('id').primaryKey(),

  /** Reference to the sync plan ID */
  syncPlanId: text('sync_plan_id')
    .notNull()
    .references(() => syncPlans.id),

  /** Resource identifier (repo name, page id, etc.) */
  resourceId: text('resource_id').notNull(),

  /** Provider type (github, notion, etc.) */
  provider: text('provider').notNull(),

  /** User ID who triggered the sync (if applicable) */
  userId: text('user_id'),

  /** Start timestamp of the sync (Unix timestamp) */
  startedAt: integer('started_at').notNull(),

  /** End timestamp of the sync (Unix timestamp) */
  completedAt: integer('completed_at').notNull(),

  /** Previous cursor value */
  previousCursor: text('previous_cursor'),

  /** New cursor value after sync */
  newCursor: text('new_cursor'),

  /** Number of files processed */
  filesProcessed: integer('files_processed').notNull().default(0),

  /** List of file paths that were updated (stored as JSON array) */
  updatedFiles: text('updated_files')
    .notNull()
    .$defaultFn(() => JSON.stringify([])),

  /** Status of the sync (success, error) */
  status: text('status').notNull(),

  /** Error message if the sync failed */
  errorMessage: text('error_message'),
});

/**
 * Schema export for Drizzle ORM
 */
export const schema = {
  syncPlans,
  syncHistory,
};
