import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

/**
 * Users table schema
 */
export const users = sqliteTable('users', {
  id: text('id').primaryKey().notNull(),
  email: text('email').notNull().unique(),
  password: text('password'), // Made nullable
  name: text('name'),
  role: text('role', { enum: ['user', 'admin'] })
    .default('user')
    .notNull(),
  emailVerified: integer('email_verified', { mode: 'boolean' })
    .default(false)
    .notNull(),
  lastLoginAt: integer('last_login_at', { mode: 'timestamp' }),
  isActive: integer('is_active', { mode: 'boolean' }).default(true).notNull(),
  authProvider: text('auth_provider'), // e.g., 'email', 'google', 'github'
  providerAccountId: text('provider_account_id'), // User's ID from the external provider
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

/**
 * User authentication providers table schema
 * Links users to their authentication methods (local or external providers like Privy)
 */
export const userAuthProviders = sqliteTable('user_auth_providers', {
  id: text('id').primaryKey().notNull(),                 // UUID
  userId: text('user_id')
    .notNull()
    .references(() => users.id),                         // Reference to users table
  provider: text('provider').notNull(),                  // e.g., SupportedAuthProvider.PRIVY or SupportedAuthProvider.LOCAL
  providerUserId: text('provider_user_id').notNull(),    // JWT sub for Privy or user's email for local
  email: text('email'),                                  // May be null for some providers
  linkedAt: integer('linked_at', { mode: 'timestamp' }).notNull(),
});
