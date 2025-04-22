import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const contents = sqliteTable('contents', {
  id: text('id').primaryKey(),
  userId: text('user_id'),
  category: text('category').notNull(),
  mimeType: text('mime_type').notNull(),
  size: integer('size').notNull(),
  r2Key: text('r2_key').notNull().unique(),
  sha256: text('sha256'),
  createdAt: integer('created_at').notNull(),
  version: integer('version').default(1),
  title: text('title'),
  summary: text('summary'),
});

export const dlqMetadata = sqliteTable('dlq_metadata', {
  id: text('id').primaryKey(),
  originalMessageId: text('original_message_id').notNull(),
  queueName: text('queue_name').notNull(),
  errorMessage: text('error_message').notNull(),
  errorName: text('error_name').notNull(),
  failedAt: integer('failed_at').notNull(),
  retryCount: integer('retry_count').notNull(),
  reprocessed: integer('reprocessed', { mode: 'boolean' }).default(false),
  reprocessedAt: integer('reprocessed_at'),
  recoveryResult: text('recovery_result'),
  originalMessageType: text('original_message_type').notNull(),
  originalMessageJson: text('original_message_json').notNull(),
});

export const schema = {
  contents,
  dlqMetadata,
};
