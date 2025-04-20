import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const contents = sqliteTable('contents', {
  id: text('id').primaryKey(),
  userId: text('user_id'),
  contentType: text('content_type').notNull(),
  size: integer('size').notNull(),
  r2Key: text('r2_key').notNull().unique(),
  sha256: text('sha256'),
  createdAt: integer('created_at').notNull(),
  version: integer('version').default(1),
});

export const schema = {
  contents,
};
