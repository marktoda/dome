/**
 * @file Defines the User type for the authentication service, derived from the database schema.
 */
import type * as schema from '../db/schema';

/**
 * Represents a user in the system, inferred from the Drizzle schema.
 * This type includes all fields from the 'users' table.
 */
export type User = typeof schema.users.$inferSelect;

/**
 * Represents the data required to insert a new user, inferred from the Drizzle schema.
 */
export type NewUser = typeof schema.users.$inferInsert;

// You can also define related types if needed, for example, for user authentication providers:
export type UserAuthProvider = typeof schema.userAuthProviders.$inferSelect;
export type NewUserAuthProvider = typeof schema.userAuthProviders.$inferInsert;