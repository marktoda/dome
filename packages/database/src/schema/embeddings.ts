import { relations } from 'drizzle-orm';
import { pgTable, text, timestamp, uuid, jsonb, integer, real } from 'drizzle-orm/pg-core';

import { documents } from './documents.js';
import { organizations } from './organizations.js';

export const embeddings = pgTable('embeddings', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id')
    .references(() => organizations.id)
    .notNull(),
  documentId: uuid('document_id')
    .references(() => documents.id)
    .notNull(),
  chunkIndex: integer('chunk_index').notNull(),
  chunkText: text('chunk_text').notNull(),
  vectorId: text('vector_id').notNull(), // ID in vector database
  embeddingModel: text('embedding_model').default('text-embedding-3-small'),
  dimensions: integer('dimensions').default(1536),
  metadata: jsonb('metadata').default({}),
  confidence: real('confidence'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const embeddingsRelations = relations(embeddings, ({ one }) => ({
  organization: one(organizations, {
    fields: [embeddings.organizationId],
    references: [organizations.id],
  }),
  document: one(documents, {
    fields: [embeddings.documentId],
    references: [documents.id],
  }),
}));

export type Embedding = typeof embeddings.$inferSelect;
export type NewEmbedding = typeof embeddings.$inferInsert;
