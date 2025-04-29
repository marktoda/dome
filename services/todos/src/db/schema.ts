import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

/**
 * Drizzle ORM schema for the todos table
 */
export const todos = sqliteTable('todos', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  
  title: text('title').notNull(),
  description: text('description'),
  
  status: text('status').notNull(),
  priority: text('priority').notNull(),
  
  category: text('category'),
  tags: text('tags'),
  
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  dueDate: integer('due_date'),
  completedAt: integer('completed_at'),
  
  sourceNoteId: text('source_note_id'),
  sourceText: text('source_text'),
  
  aiGenerated: integer('ai_generated', { mode: 'boolean' }).notNull(),
  confidence: real('confidence'),
  
  estimatedEffort: text('estimated_effort'),
  actionableSteps: text('actionable_steps'),
  context: text('context')
});

/**
 * Export the schema for use with drizzle-kit
 */
export const schema = {
  todos
};