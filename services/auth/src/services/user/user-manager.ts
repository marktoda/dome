import { User } from '../../interfaces/auth-provider.interface'; // Use the schema-inferred User type

// Placeholder for AuthContext, should be defined in a shared location or passed appropriately
export interface AuthContext {
  env: {
    PRIVY_APP_ID?: string;
    MOCK_USER?: boolean;
    [key: string]: any;
  };
  db: any; // Database client
  waitUntil?: (promise: Promise<any>) => void;
}

// BaseAuthProvider might also be imported from a shared location if used here directly,
// or this UserManager might not need direct knowledge of it.
// For now, keeping a simplified local version if it's only for type context within this file.
// If UserManager interacts with BaseAuthProvider instances, it should import the proper one.
abstract class PlaceholderBaseAuthProvider<TConfig = any, TCredentials = any, TAuthResult = User> {
  readonly providerId: string;
  protected config: TConfig;

  constructor(providerId: string, config: TConfig) {
    this.providerId = providerId;
    this.config = config;
  }

  abstract authenticate(credentials: TCredentials, context: AuthContext): Promise<TAuthResult | null>;
  abstract createUser?(credentials: TCredentials, context: AuthContext): Promise<TAuthResult | null>;
  abstract findUserById(userId: string, context: AuthContext): Promise<User | null>; // Now returns schema User
}


export interface IUserManager {
  createUser(userData: Partial<User>, context: AuthContext, providerInfo?: { providerId: string; providerUserId: string; providerDetails?: any }): Promise<User>;
  findUserById(userId: string, context: AuthContext): Promise<User | null>; // Returns schema User
  findUserByEmail(email: string, context: AuthContext): Promise<User | null>; // Returns schema User
  findUserByProvider(providerId: string, providerUserId: string, context: AuthContext): Promise<User | null>; // Returns schema User
  updateUser(userId: string, updates: Partial<User>, context: AuthContext): Promise<User | null>; // Returns schema User
  deleteUser(userId: string, context: AuthContext): Promise<boolean>;
  linkProviderToUser(userId: string, providerId: string, providerUserId: string, providerDetails: any, context: AuthContext): Promise<User | null>; // Returns schema User
  unlinkProviderFromUser(userId: string, providerId: string, context: AuthContext): Promise<User | null>; // Returns schema User
}

export class UserManager implements IUserManager {
  constructor() {
    // Dependencies like a specific DB schema accessor could be injected here
  }

  async createUser(
    userData: Partial<User>,
    context: AuthContext,
    providerInfo?: { providerId: string; providerUserId: string; providerDetails?: any }
  ): Promise<User> {
    const newId = `user-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`; // Placeholder ID
    const now = new Date();

    // Note: The placeholder User type defined earlier in this file is now removed.
    // All User type annotations will refer to the imported schema-inferred User.
    // The createUser method needs to construct an object that satisfies the schema User type.
    // const now = new Date(); // Redundant declaration
    // const newId = `user-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`; // Redundant declaration

    // Construct the user object ensuring all non-nullable fields from the schema are present.
    // Fields like 'password', 'name', 'authProvider', 'providerAccountId' can be null/undefined
    // based on the schema, so they are optional in Partial<User>.
    // Required fields like 'id', 'email', 'role', 'emailVerified', 'isActive', 'createdAt', 'updatedAt'
    // must be provided.
    const userToCreate: User = {
      id: newId,
      email: userData.email || `generated-${newId}@example.com`, // Ensure email is present
      role: userData.role || 'user', // Default role
      emailVerified: userData.emailVerified || false, // Default
      isActive: userData.isActive !== undefined ? userData.isActive : true, // Default
      createdAt: userData.createdAt || now,
      updatedAt: userData.updatedAt || now,
      // Nullable fields from schema, can be part of userData or undefined
      password: userData.password || null,
      name: userData.name || null,
      lastLoginAt: userData.lastLoginAt || null,
      authProvider: null, // Will be set if providerInfo is present
      providerAccountId: null, // Will be set if providerInfo is present
      ...userData, // Apply other initial data, overriding defaults if present in userData
    };
    
    // The 'providers' property is not directly in the 'users' table schema.
    // It was part of the local placeholder User. If this concept is still needed,
    // it should be handled differently, perhaps via a related table or by adjusting
    // the User type if it's meant to be a composite object.
    // For now, assuming `userToCreate` directly maps to `users` table.
    // If `providerInfo` is used to set `authProvider` and `providerAccountId`:
    if (providerInfo) {
        userToCreate.authProvider = providerInfo.providerId;
        userToCreate.providerAccountId = providerInfo.providerUserId;
        // If 'privyDid' was a concept tied to the old placeholder 'providers' array,
        // and it maps to 'providerAccountId' for 'privy' provider:
        if (providerInfo.providerId === 'privy') {
            // userToCreate.privyDid = providerInfo.providerUserId; // 'privyDid' is not in schema User
        }
    }

    console.log(`Placeholder: Creating user in DB:`, userToCreate);
    context.db._users = context.db._users || {};
    context.db._users[newId] = userToCreate;
    return userToCreate;
  }

  async findUserById(userId: string, context: AuthContext): Promise<User | null> {
    console.log(`Placeholder: Searching for user by ID: ${userId} in DB`);
    return context.db._users?.[userId] || null;
  }

  async findUserByEmail(email: string, context: AuthContext): Promise<User | null> {
    console.log(`Placeholder: Searching for user by email: ${email} in DB`);
    if (!context.db._users) return null;
    // Ensure the object being iterated is compatible with User type
    return Object.values(context.db._users as Record<string, User>).find(u => u.email === email) || null;
  }

  async findUserByProvider(providerId: string, providerUserId: string, context: AuthContext): Promise<User | null> {
    console.log(`Placeholder: Searching for user by provider: ${providerId} - ${providerUserId} in DB`);
    if (!context.db._users) return null;
    // This relies on authProvider and providerAccountId fields in the User (schema) object
    return Object.values(context.db._users as Record<string, User>).find(u =>
      u.authProvider === providerId && u.providerAccountId === providerUserId
    ) || null;
  }

  async updateUser(userId: string, updates: Partial<User>, context: AuthContext): Promise<User | null> {
    console.log(`Placeholder: Updating user ${userId} in DB with:`, updates);
    if (context.db._users?.[userId]) {
      // Ensure the stored user and updates are compatible with User type
      const currentUser = context.db._users[userId] as User;
      context.db._users[userId] = { ...currentUser, ...updates, updatedAt: new Date() } as User;
      return context.db._users[userId] as User;
    }
    return null;
  }

  async deleteUser(userId: string, context: AuthContext): Promise<boolean> {
    console.log(`Placeholder: Deleting user ${userId} from DB`);
    if (context.db._users?.[userId]) {
      delete context.db._users[userId];
      return true;
    }
    return false;
  }

  async linkProviderToUser(userId: string, providerId: string, providerUserId: string, providerDetails: any = {}, context: AuthContext): Promise<User | null> {
    const user = await this.findUserById(userId, context);
    if (!user) {
      throw new Error(`User with ID ${userId} not found.`);
    }

    // This method needs to be re-evaluated. The schema User doesn't have a 'providers' array.
    // Linking now means setting/updating authProvider and providerAccountId on the user record itself,
    // or managing this in the 'userAuthProviders' table.
    // For simplicity, let's assume we are updating the main user record if it's their primary/first provider.
    // Or, if this is for multiple providers, userAuthProviders table should be used.

    // If user already has a provider and it's different, this might be an error or a new link.
    if (user.authProvider && user.authProvider !== providerId) {
        console.warn(`User ${userId} already linked to ${user.authProvider}. Linking to new provider ${providerId}. This might require userAuthProviders table logic.`);
        // Here you would typically insert into userAuthProviders table.
        // For now, we'll just update the primary authProvider on the user for simplicity.
    }
    
    const updates: Partial<User> = {
        authProvider: providerId,
        providerAccountId: providerUserId,
        // 'privyDid' is not on schema User. If it's providerAccountId for privy:
        // privyDid: providerId === 'privy' ? providerUserId : user.privyDid,
    };

    return this.updateUser(userId, updates, context);
  }

  async unlinkProviderFromUser(userId: string, providerId: string, context: AuthContext): Promise<User | null> {
    const user = await this.findUserById(userId, context);
    if (!user) {
      throw new Error(`User with ID ${userId} not found.`);
    }

    // If unlinking means clearing the primary provider fields on the user record:
    if (user.authProvider === providerId) {
        const updates: Partial<User> = {
            authProvider: null,
            providerAccountId: null,
        };
        return this.updateUser(userId, updates, context);
    } else {
        // If using userAuthProviders table, you'd delete the specific entry.
        console.warn(`Provider ${providerId} not the primary for user ${userId}, or not found. No changes to primary auth fields.`);
        return user;
    }
  }
}