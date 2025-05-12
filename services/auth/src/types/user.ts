/**
 * @file Defines the User type for the authentication service.
 */

/**
 * Represents a user in the system.
 */
export interface User {
  /** Unique identifier for the user. */
  id: string;
  /** User's email address (optional, but often used for login). */
  email?: string;
  /** Username (optional, can be used for login or display). */
  username?: string;
  /** Hashed password (if using password-based authentication). Should not be sent to client. */
  passwordHash?: string;
  /** Timestamp of when the user was created. */
  createdAt?: Date;
  /** Timestamp of the last update to the user's record. */
  updatedAt?: Date;
  /** Indicates if the user's email has been verified. */
  emailVerified?: boolean;
  /** Roles assigned to the user (e.g., "admin", "editor", "viewer"). */
  roles?: string[];
  /** Any additional provider-specific user information. */
  providerData?: {
    [providerName: string]: any; // e.g., { google: { googleId: '...', profile: {...} } }
  };
  // Add other relevant user fields as needed
  // e.g., firstName, lastName, profilePictureUrl, isActive, lastLoginAt, etc.
}