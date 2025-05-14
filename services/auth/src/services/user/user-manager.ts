import { drizzle } from 'drizzle-orm/d1';
import { eq, and } from 'drizzle-orm'; // Import and
import * as schema from '../../db/schema';
// Use the Drizzle-inferred type directly for DbUser
type DbUser = typeof schema.users.$inferSelect;

// Define AuthContext with D1Database type for db
export interface AuthContext {
  env: {
    PRIVY_APP_ID?: string;
    MOCK_USER?: boolean;
    [key: string]: any;
  };
  db: D1Database; // Use D1Database type
  waitUntil?: (promise: Promise<any>) => void;
}

// Using DbUser which should be equivalent to typeof schema.users.$inferSelect
export interface IUserManager {
  createUser(
    userData: Partial<DbUser>,
    context: AuthContext,
    providerInfo?: { providerId: string; providerUserId: string; providerDetails?: any },
  ): Promise<DbUser>;
  findUserById(userId: string, context: AuthContext): Promise<DbUser | null>;
  findUserByEmail(email: string, context: AuthContext): Promise<DbUser | null>;
  findUserByProvider(
    providerId: string,
    providerUserId: string,
    context: AuthContext,
  ): Promise<DbUser | null>;
  updateUser(
    userId: string,
    updates: Partial<DbUser>,
    context: AuthContext,
  ): Promise<DbUser | null>;
  deleteUser(userId: string, context: AuthContext): Promise<boolean>;
  linkProviderToUser(
    userId: string,
    providerId: string,
    providerUserId: string,
    providerDetails: any,
    context: AuthContext,
  ): Promise<DbUser | null>;
  unlinkProviderFromUser(
    userId: string,
    providerId: string,
    context: AuthContext,
  ): Promise<DbUser | null>;
}

export class UserManager implements IUserManager {
  constructor() {
    // No specific dependencies needed in constructor if db connection is passed via context
  }

  private getDb(context: AuthContext) {
    return drizzle(context.db, { schema });
  }

  async createUser(
    userData: Partial<DbUser>, // Use DbUser (schema inferred)
    context: AuthContext,
    providerInfo?: { providerId: string; providerUserId: string; providerDetails?: any },
  ): Promise<DbUser> {
    const db = this.getDb(context);
    const newId = crypto.randomUUID();
    const now = new Date();

    const userToInsert: typeof schema.users.$inferInsert = {
      id: newId,
      email: userData.email!, // Assuming email is always provided for new users
      password: userData.password, // Will be hashed by the provider
      name: userData.name,
      role: userData.role || 'user',
      emailVerified: userData.emailVerified || false,
      isActive: userData.isActive !== undefined ? userData.isActive : true,
      authProvider: providerInfo?.providerId,
      providerAccountId: providerInfo?.providerUserId,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: userData.lastLoginAt,
    };

    const result = await db.insert(schema.users).values(userToInsert).returning().get();

    if (!result) {
      throw new Error('Failed to create user in database.');
    }

    // If providerInfo is present, also create an entry in userAuthProviders
    if (providerInfo) {
      await db
        .insert(schema.userAuthProviders)
        .values({
          id: crypto.randomUUID(),
          userId: newId,
          provider: providerInfo.providerId,
          providerUserId: providerInfo.providerUserId,
          email: userData.email, // Store email if available
          linkedAt: now,
        })
        .execute();
    }

    // Ensure the returned object matches DbUser (which should be typeof schema.users.$inferSelect)
    // The 'result' from .get() should already be of the correct select type.
    return result as DbUser;
  }

  async findUserById(userId: string, context: AuthContext): Promise<DbUser | null> {
    const db = this.getDb(context);
    const user = await db.query.users.findFirst({
      where: eq(schema.users.id, userId),
    });
    return user || null;
  }

  async findUserByEmail(email: string, context: AuthContext): Promise<DbUser | null> {
    const db = this.getDb(context);
    const user = await db.query.users.findFirst({
      where: eq(schema.users.email, email),
    });
    return user || null;
  }

  async findUserByProvider(
    providerId: string,
    providerUserId: string,
    context: AuthContext,
  ): Promise<DbUser | null> {
    const db = this.getDb(context);
    // First, find the link in userAuthProviders
    const authProviderLink = await db.query.userAuthProviders.findFirst({
      where: (fields, { and }) =>
        and(eq(fields.provider, providerId), eq(fields.providerUserId, providerUserId)),
    });

    if (authProviderLink && authProviderLink.userId) {
      // Then, fetch the user using the userId from the link
      return this.findUserById(authProviderLink.userId, context);
    }

    // Fallback: Check the primary authProvider fields on the users table directly
    // This is useful if 'local' provider details are stored directly on the users table
    // and not necessarily in userAuthProviders.
    const user = await db.query.users.findFirst({
      where: (fields, { and }) =>
        and(eq(fields.authProvider, providerId), eq(fields.providerAccountId, providerUserId)),
    });
    return user || null;
  }

  async updateUser(
    userId: string,
    updates: Partial<DbUser>,
    context: AuthContext,
  ): Promise<DbUser | null> {
    const db = this.getDb(context);
    const currentTimestamp = new Date();

    const updateData: Partial<typeof schema.users.$inferInsert> = {
      ...updates,
      updatedAt: currentTimestamp,
    };
    // Remove id from updates if present, as it shouldn't be changed
    if ('id' in updateData) delete updateData.id;

    const result = await db
      .update(schema.users)
      .set(updateData)
      .where(eq(schema.users.id, userId))
      .returning()
      .get();
    return result || null;
  }

  async deleteUser(userId: string, context: AuthContext): Promise<boolean> {
    const db = this.getDb(context);
    // Consider transaction if deleting from multiple tables (e.g., userAuthProviders)
    // D1 .run() returns D1Result, check meta.changes for affected rows
    const userAuthProvidersDeleteResult = await db
      .delete(schema.userAuthProviders)
      .where(eq(schema.userAuthProviders.userId, userId))
      .run();
    const usersDeleteResult = await db
      .delete(schema.users)
      .where(eq(schema.users.id, userId))
      .run();

    // Return true if any rows were deleted from the users table
    return (usersDeleteResult.meta.changes ?? 0) > 0;
  }

  async linkProviderToUser(
    userId: string,
    providerId: string,
    providerUserId: string,
    providerDetails: any = {},
    context: AuthContext,
  ): Promise<DbUser | null> {
    const db = this.getDb(context);
    const user = await this.findUserById(userId, context);
    if (!user) {
      throw new Error(`User with ID ${userId} not found.`);
    }

    // Check if this provider link already exists for the user
    const existingLink = await db.query.userAuthProviders.findFirst({
      where: (fields, { and }) =>
        and(
          eq(fields.userId, userId),
          eq(fields.provider, providerId),
          eq(fields.providerUserId, providerUserId),
        ),
    });

    if (existingLink) {
      // Link already exists, return the user
      return user;
    }

    // Create new link
    await db
      .insert(schema.userAuthProviders)
      .values({
        id: crypto.randomUUID(),
        userId: userId,
        provider: providerId,
        providerUserId: providerUserId,
        email: user.email, // Or providerDetails.email if available and preferred
        linkedAt: new Date(),
      })
      .execute();

    // If this is the first external provider, or if logic dictates updating user's primary authProvider fields:
    if (!user.authProvider) {
      return this.updateUser(
        userId,
        { authProvider: providerId, providerAccountId: providerUserId },
        context,
      );
    }

    return user; // Return the original user object, now linked
  }

  async unlinkProviderFromUser(
    userId: string,
    providerId: string,
    context: AuthContext,
  ): Promise<DbUser | null> {
    const db = this.getDb(context);
    const user = await this.findUserById(userId, context);
    if (!user) {
      throw new Error(`User with ID ${userId} not found.`);
    }

    // Delete from userAuthProviders table
    await db
      .delete(schema.userAuthProviders)
      .where(
        and(
          // Use and() operator
          eq(schema.userAuthProviders.userId, userId),
          eq(schema.userAuthProviders.provider, providerId),
        ),
      )
      .run(); // Use .run() for delete if not returning

    // If the unlinked provider was the primary one on the user record, clear those fields
    if (user.authProvider === providerId) {
      return this.updateUser(userId, { authProvider: null, providerAccountId: null }, context);
    }

    return user; // Return the user, possibly with primary fields unchanged if they were for a different provider
  }
}
