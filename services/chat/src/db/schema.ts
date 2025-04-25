import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

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
 * Export the complete schema
 */
export const schema = {
  checkpoints,
};
