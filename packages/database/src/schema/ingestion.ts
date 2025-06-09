import { relations } from 'drizzle-orm';
import { pgTable, text, timestamp, uuid, jsonb, integer } from 'drizzle-orm/pg-core';

import { organizations } from './organizations.js';

export const ingestionJobs = pgTable('ingestion_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id')
    .references(() => organizations.id)
    .notNull(),
  sourceType: text('source_type', {
    enum: ['github', 'notion', 'slack', 'linear'],
  }).notNull(),
  sourceId: text('source_id').notNull(),
  status: text('status', {
    enum: ['pending', 'processing', 'completed', 'failed', 'cancelled'],
  }).default('pending'),
  progress: integer('progress').default(0), // 0-100
  totalItems: integer('total_items'),
  processedItems: integer('processed_items').default(0),
  failedItems: integer('failed_items').default(0),
  metadata: jsonb('metadata').default({}),
  errorMessage: text('error_message'),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const ingestionJobsRelations = relations(ingestionJobs, ({ one }) => ({
  organization: one(organizations, {
    fields: [ingestionJobs.organizationId],
    references: [organizations.id],
  }),
}));

export type IngestionJob = typeof ingestionJobs.$inferSelect;
export type NewIngestionJob = typeof ingestionJobs.$inferInsert;
