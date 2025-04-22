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
import { ulid } from 'ulid'; // Using ulid instead of cuid2 since it's already a dependency

/**
 * Sync Plans Table
 *
 * Stores information about external content sources that need to be synced.
 * Each row represents a single sync plan for a specific resource (e.g., GitHub repository).
 */
export const syncPlans = sqliteTable('sync_plan', {
  /** Unique identifier for the sync plan (ULID) */
  id: text('id').primaryKey(),
  
  /** User ID who owns this sync plan */
  userId: text('user_id').notNull(),
  
  /** Provider type (github, notion, etc.) */
  provider: text('provider').notNull(),
  
  /** Resource identifier (repo name, page id, etc.) */
  resourceId: text('resource_id').notNull(),
  
  /** Sync frequency in seconds */
  cadenceSecs: integer('cadence_secs').default(3600),
  
  /** Last successful sync timestamp */
  lastSyncedAt: integer('last_synced_at'),
  
  /** Last cursor value (e.g., commit SHA) */
  lastCursor: text('last_cursor'),
  
  /** Created at timestamp */
  createdAt: integer('created_at').default(sql`(unixepoch())`),
  
  /** Updated at timestamp */
  updatedAt: integer('updated_at').default(sql`(unixepoch())`),
});

/**
 * Sync History Table
 *
 * Stores the history of sync operations for each sync plan.
 * Useful for tracking sync performance and troubleshooting.
 */
export const syncHistory = sqliteTable('sync_history', {
  /** Unique identifier for the sync history entry */
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  
  /** Reference to the sync plan */
  syncPlanId: text('sync_plan_id').notNull().references(() => syncPlans.id),
  
  /** Status of the sync operation (success, error) */
  status: text('status').notNull(),
  
  /** Number of items synced */
  itemCount: integer('item_count').default(0),
  
  /** Error message if the sync failed */
  errorMessage: text('error_message'),
  
  /** Start timestamp */
  startedAt: integer('started_at').notNull().default(sql`(unixepoch())`),
  
  /** End timestamp */
  completedAt: integer('completed_at'),
});

/**
 * Schema export for Drizzle ORM
 */
export const schema = {
  syncPlans,
  syncHistory,
};
