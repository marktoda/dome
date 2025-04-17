import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

/**
 * Notes table schema
 */
export const notes = sqliteTable('notes', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  contentType: text('content_type').notNull(),
  r2Key: text('r2_key'),
  metadata: text('metadata'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  embeddingStatus: text('embedding_status').default('pending')
});

/**
 * Note pages table schema for large documents that need page-level embeddings
 */
export const notePages = sqliteTable('note_pages', {
  id: text('id').primaryKey(),
  noteId: text('note_id')
    .notNull()
    .references(() => notes.id, { onDelete: 'cascade' }),
  pageNum: integer('page_num').notNull(),
  content: text('content').notNull(),
  createdAt: integer('created_at').notNull()
});

/**
 * Tasks table schema
 */
export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  status: text('status').notNull().default('pending'),
  priority: text('priority').default('medium'),
  dueDate: integer('due_date'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  completedAt: integer('completed_at')
});

/**
 * Reminders table schema
 */
export const reminders = sqliteTable('reminders', {
  id: text('id').primaryKey(),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  remindAt: integer('remind_at').notNull(),
  delivered: integer('delivered', { mode: 'boolean' }).notNull().default(false),
  deliveryMethod: text('delivery_method').default('email'),
  createdAt: integer('created_at').notNull()
});

/**
 * Schema export for use with Drizzle
 */
export const schema = {
  notes,
  notePages,
  tasks,
  reminders
};