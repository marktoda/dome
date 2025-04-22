/**
 * Database Schema Module
 *
 * This module defines the database schema for the Tsunami service using Drizzle ORM.
 * It includes tables for tracking sync plans and their state.
 *
 * @module db/schema
 */

import { sql } from 'drizzle-orm';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
 * Schema export for Drizzle ORM
 */
export const schema = {
  syncPlans,
};
