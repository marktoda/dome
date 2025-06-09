import { relations } from 'drizzle-orm';
import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { embeddings } from './embeddings.js';
import { organizations } from './organizations.js';

export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id')
    .references(() => organizations.id)
    .notNull(),
  sourceType: text('source_type', {
    enum: ['github', 'notion', 'slack', 'linear'],
  }).notNull(),
  sourceId: text('source_id').notNull(),
  sourceUrl: text('source_url'),
  title: text('title').notNull(),
  content: text('content'),
  metadata: jsonb('metadata').default({}),
  permissions: jsonb('permissions').default({}),
  version: integer('version').default(1),
  isActive: boolean('is_active').default(true),
  lastSyncAt: timestamp('last_sync_at'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const documentsRelations = relations(documents, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [documents.organizationId],
    references: [organizations.id],
  }),
  embeddings: many(embeddings),
}));

export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
