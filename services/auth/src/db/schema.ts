import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

/**
 * Users table schema
 */
export const users = sqliteTable('users', {
  id: text('id').primaryKey().notNull(),
  email: text('email').notNull().unique(),
  password: text('password').notNull(),
  name: text('name'),
  role: text('role', { enum: ['user', 'admin'] })
    .default('user')
    .notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

/**
 * Token blacklist table schema (for tracking revoked tokens)
 * Note: Using KV for active tokens, but D1 for blacklisted tokens that need to persist
 */
export const tokenBlacklist = sqliteTable('token_blacklist', {
  token: text('token').primaryKey().notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  revokedAt: integer('revoked_at', { mode: 'timestamp' }).notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
});
