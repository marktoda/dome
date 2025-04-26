import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';

/**
 * Checkpoints table schema
 * Stores LangGraph state checkpoints for conversation persistence
 */
export const checkpoints = sqliteTable('checkpoints', {
  // Unique identifier for the conversation
  runId: text('run_id').primaryKey(),

  // Current step in the graph
  step: text('step').notNull(),

  // Serialized state data
  stateJson: text('state_json').notNull(),

  // Timestamp when the checkpoint was created
  createdAt: integer('created_at').notNull(),

  // Timestamp when the checkpoint was last updated
  updatedAt: integer('updated_at').notNull(),

  // User ID for secure checkpointer (optional)
  userId: text('user_id'),
});

/**
 * Data retention consents table schema
 * Stores user consents for data retention
 */
export const dataRetentionConsents = sqliteTable(
  'data_retention_consents',
  {
    // User ID
    userId: text('user_id').notNull(),

    // Data category (e.g., 'chatHistory', 'userProfile')
    dataCategory: text('data_category').notNull(),

    // Timestamp when consent was given
    consentedAt: integer('consented_at').notNull(),

    // Timestamp when consent expires (optional)
    expiresAt: integer('expires_at'),
  },
  table => ({
    // Composite primary key of userId and dataCategory
    pk: primaryKey({ columns: [table.userId, table.dataCategory] }),
  }),
);

/**
 * Data retention records table schema
 * Stores records of data that is subject to retention policies
 */
export const dataRetentionRecords = sqliteTable('data_retention_records', {
  // Unique identifier for the record
  recordId: text('record_id').primaryKey(),

  // User ID
  userId: text('user_id').notNull(),

  // Data category (e.g., 'chatHistory', 'userProfile')
  dataCategory: text('data_category').notNull(),

  // Timestamp when the record was created
  createdAt: integer('created_at').notNull(),

  // Timestamp when the record expires
  expiresAt: integer('expires_at').notNull(),

  // Whether the record has been anonymized
  anonymized: integer('anonymized', { mode: 'boolean' }).default(false),
});

/**
 * Export the complete schema
 */
export const schema = {
  checkpoints,
  dataRetentionConsents,
  dataRetentionRecords,
};
