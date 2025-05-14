/**
 * @file Base class for authentication providers, providing common functionality.
 */
import { TokenManager, TokenPayload } from '../token/token-manager';
import { User } from '../../types/user'; // Assuming a User type definition exists

/**
 * Represents the result of an authentication attempt.
 */
export interface AuthResult {
  success: boolean;
  user?: User;
  accessToken?: string;
  refreshToken?: string;
  error?: string; // Error message if authentication failed
  providerDetails?: Record<string, any>; // Provider-specific details
}

/**
 * Interface for an authentication provider.
 * Specific providers (e.g., EmailPasswordAuthProvider, GoogleAuthProvider) will implement this.
 */
export interface AuthProvider {
  /**
   * The unique name of the provider (e.g., "email-password", "google", "github").
   */
  readonly providerName: string;

  /**
   * Authenticates a user based on provider-specific credentials or tokens.
   * @param credentials - An object containing credentials (e.g., { email, password } or { idToken }).
   * @returns A promise that resolves to an AuthResult.
   */
  authenticate(credentials: Record<string, any>): Promise<AuthResult>;

  /**
   * Registers a new user with the provider. Optional.
   * @param registrationData - Data required for registration.
   * @returns A promise that resolves to an AuthResult.
   * @throws Error if registration is not supported or fails.
   */
  register?(registrationData: Record<string, any>): Promise<AuthResult>;

  /**
   * Refreshes an access token using a refresh token.
   * @param refreshToken - The refresh token.
   * @returns A promise that resolves to an AuthResult containing a new access token.
   */
  refreshAccessToken(refreshToken: string): Promise<AuthResult>;

  /**
   * Logs out a user. This might involve revoking tokens or clearing session data.
   * @param token - The token (e.g., access or refresh token) to invalidate.
   * @returns A promise that resolves when logout is complete.
   */
  logout(token: string): Promise<void>;

  /**
   * Retrieves user information based on an access token.
   * @param accessToken - The access token.
   * @returns A promise that resolves to the User object or null if not found/invalid.
   */
  getUserFromToken(accessToken: string): Promise<User | null>;

  // Potentially other common methods:
  // - registerUser(details: Record<string, any>): Promise<AuthResult>;
  // - handleCallback(query: Record<string, string>): Promise<AuthResult>; // For OAuth providers
}

/**
 * Abstract base class for authentication providers.
 * It provides common token handling and user operation logic.
 */
export abstract class BaseAuthProvider implements AuthProvider {
  abstract readonly providerName: string;
  protected readonly tokenManager: TokenManager;

  constructor(tokenManager: TokenManager) {
    this.tokenManager = tokenManager;
  }

  /**
   * Abstract method for provider-specific authentication logic.
   * Must be implemented by subclasses.
   */
  abstract authenticate(credentials: Record<string, any>): Promise<AuthResult>;

  /**
   * Optional method for provider-specific registration.
   * Subclasses can override this if they support direct registration.
   */
  async register?(registrationData: Record<string, any>): Promise<AuthResult> {
    throw new Error(`Registration via ${this.providerName} provider is not supported directly.`);
  }

  /**
   * Generates access and refresh tokens for an authenticated user.
   * @param user - The authenticated user object.
   * @param additionalClaims - Optional additional claims to include in the access token.
   * @returns A promise that resolves to an object containing accessToken and refreshToken.
   */
  protected async generateTokens(
    user: User,
    additionalClaims: Record<string, any> = {},
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const accessTokenPayload: TokenPayload = {
      userId: user.id,
      // Add other standard claims like username, roles, etc., from the user object
      // email: user.email, // if available and desired in token
      ...additionalClaims,
    };
    const accessToken = await this.tokenManager.generateAccessToken(accessTokenPayload);

    const refreshTokenPayload: Pick<TokenPayload, 'userId'> = {
      userId: user.id,
    };
    const refreshToken = await this.tokenManager.generateRefreshToken(refreshTokenPayload);

    return { accessToken, refreshToken };
  }

  /**
   * Refreshes an access token using a valid refresh token.
   * @param refreshToken - The refresh token.
   * @returns A promise that resolves to an AuthResult.
   */
  async refreshAccessToken(refreshToken: string): Promise<AuthResult> {
    try {
      const refreshTokenPayload = await this.tokenManager.verifyRefreshToken(refreshToken);

      // Here, you would typically fetch the user details from your database
      // using refreshTokenPayload.userId to ensure the user still exists and is active.
      // For this example, we'll assume a placeholder user retrieval.
      const user = await this.findUserById(refreshTokenPayload.userId);

      if (!user) {
        return { success: false, error: 'User not found for refresh token.' };
      }

      const newAccessTokenPayload: TokenPayload = {
        userId: user.id,
        // Potentially re-add other claims if needed, or keep it minimal
      };
      const newAccessToken = await this.tokenManager.generateAccessToken(newAccessTokenPayload);

      return {
        success: true,
        user,
        accessToken: newAccessToken,
        // Optionally, issue a new refresh token (e.g., for refresh token rotation)
        // refreshToken: newRefreshToken,
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to refresh token: ${(error as Error).message}`,
      };
    }
  }

  /**
   * Logs out a user by attempting to revoke the provided token.
   * @param token - The token (access or refresh) to revoke.
   */
  async logout(token: string): Promise<void> {
    try {
      await this.tokenManager.revokeToken(token);
      // Additional logout logic (e.g., clearing server-side session if any) can go here.
    } catch (error) {
      // Log error, but don't let it block logout flow typically
      console.error(`Error during token revocation on logout: ${(error as Error).message}`);
    }
  }

  /**
   * Retrieves user information based on a valid access token.
   * @param accessToken - The access token.
   * @returns A promise that resolves to the User object or null.
   */
  async getUserFromToken(accessToken: string): Promise<User | null> {
    try {
      const payload = await this.tokenManager.verifyAccessToken(accessToken);
      // In a real application, you'd fetch the full user object from your database
      // using payload.userId.
      const user = await this.findUserById(payload.userId);
      return user;
    } catch (error) {
      // Token is invalid, expired, or user not found
      console.warn(`Failed to get user from token: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Placeholder method to find a user by ID.
   * Subclasses or a dedicated user service would implement this.
   * @param userId - The ID of the user to find.
   * @returns A promise that resolves to the User object or null.
   */
  protected async findUserById(userId: string): Promise<User | null> {
    // This is a placeholder. In a real application, this would query your user database.
    console.warn(`findUserById(${userId}) is a placeholder. Implement actual user lookup.`);
    // Simulate a user lookup
    if (userId === 'mock-user-id') {
      // Example
      // Align with the User schema (which uses 'name', not 'username', and has other required fields)
      return {
        id: userId,
        email: 'user@example.com',
        name: 'mockuser', // Changed from username to name
        role: 'user',
        emailVerified: false,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        password: null, // Or a mock hash if needed for other placeholder logic
        lastLoginAt: null,
        authProvider: null,
        providerAccountId: null,
      };
    }
    return null;
  }
}
