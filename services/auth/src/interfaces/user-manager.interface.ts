/**
 * @file Defines the interface for managing user data.
 */

import { User } from './auth-provider.interface'; // Re-using the User type

/**
 * Data required to create a new user.
 * Omits fields that are auto-generated or set by default (e.g., id, createdAt, updatedAt).
 */
export type CreateUserData = Omit<User, 'id' | 'createdAt' | 'updatedAt'>;

/**
 * Data allowed for updating an existing user.
 * All fields are optional, and 'id' is typically used to identify the user.
 */
export type UpdateUserData = Partial<Omit<User, 'id' | 'createdAt' | 'updatedAt'>>;

/**
 * Interface for a user manager.
 */
export interface UserManager {
  /**
   * Finds a user by their ID.
   * @param id - The ID of the user to find.
   * @returns A promise that resolves to the user object or null if not found.
   */
  findById(id: string): Promise<User | null>;

  /**
   * Finds a user by their email address.
   * @param email - The email address of the user to find.
   * @returns A promise that resolves to the user object or null if not found.
   */
  findByEmail(email: string): Promise<User | null>;

  /**
   * Creates a new user.
   * @param userData - The data for the new user.
   * @returns A promise that resolves to the created user object.
   */
  createUser(userData: CreateUserData): Promise<User>;

  /**
   * Updates an existing user.
   * @param id - The ID of the user to update.
   * @param userData - The data to update for the user.
   * @returns A promise that resolves to the updated user object or null if not found.
   */
  updateUser(id: string, userData: UpdateUserData): Promise<User | null>;

  /**
   * Deletes a user by their ID.
   * @param id - The ID of the user to delete.
   * @returns A promise that resolves to true if deletion was successful, false otherwise.
   */
  deleteUser(id: string): Promise<boolean>;

  /**
   * Optional: Finds a user by an external provider's ID.
   * @param providerName - The name of the external provider (e.g., 'google').
   * @param providerUserId - The user's ID within that external provider.
   * @returns A promise that resolves to the user object or null if not found.
   */
  findByProviderId?(providerName: string, providerUserId: string): Promise<User | null>;

  /**
   * Optional: Links an external provider account to an existing user.
   * @param userId - The ID of the local user.
   * @param providerName - The name of the external provider.
   * @param providerUserId - The user's ID within that external provider.
   * @param providerData - Optional additional data from the provider.
   * @returns A promise that resolves to the updated user object.
   */
  linkProviderAccount?(
    userId: string,
    providerName: string,
    providerUserId: string,
    providerData?: any,
  ): Promise<User | null>;

  /**
   * Optional: Unlinks an external provider account from a user.
   * @param userId - The ID of the local user.
   * @param providerName - The name of the external provider.
   * @returns A promise that resolves to true if unlinking was successful.
   */
  unlinkProviderAccount?(userId: string, providerName: string): Promise<boolean>;
}