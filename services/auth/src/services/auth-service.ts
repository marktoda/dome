import { IUserManager, UserManager } from './user/user-manager'; // Import IUserManager
import { BaseAuthProvider, AuthResult } from './providers/base-auth-provider'; // Corrected import
import { BaseError, UnauthorizedError, ValidationError, ServiceError } from '@dome/common/errors';
import { SupportedAuthProvider, type User as SchemaUser } from '../types'; // Corrected path & import enum
import { TokenManager } from './token/token-manager';

// Use the schema-inferred User type
type User = SchemaUser;

// Define a more generic type for credentials and registration data if possible,
// or use 'any'/'unknown' and let providers handle specific structures.
type ProviderCredentials = any; // e.g., { email, password } or { token }
type UserRegistrationData = any; // e.g., { email, password, name }

// AuthToken is part of AuthResult from BaseAuthProvider

export interface AuthServiceDependencies {
  userManager: IUserManager; // Use IUserManager interface
  providerServices: Map<string, BaseAuthProvider>; // Use the simpler BaseAuthProvider type
  tokenManager: TokenManager; // Added tokenManager
  env: any; // Added env
}

export class AuthService {
  private userManager: IUserManager; // Use IUserManager interface
  private providerServices: Map<string, BaseAuthProvider>;
  private tokenManager: TokenManager;
  private env: any;

  constructor({ userManager, providerServices, tokenManager, env }: AuthServiceDependencies) {
    this.userManager = userManager;
    this.providerServices = providerServices;
    this.tokenManager = tokenManager;
    this.env = env;
  }

  private getProvider(providerName: string): BaseAuthProvider {
    const provider = this.providerServices.get(providerName);
    if (!provider) {
      throw new ValidationError(`Unsupported or unconfigured provider: ${providerName}`);
    }
    return provider;
  }

  async login(providerName: string, credentials: ProviderCredentials): Promise<{ user: User; tokenInfo: { token: string; type: string; expiresAt: number; refreshToken?: string } }> {
    try {
      const provider = this.getProvider(providerName);
      // Provider's authenticate method returns AuthResult
      const authResult = await provider.authenticate(credentials);

      if (!authResult.success || !authResult.user || !authResult.accessToken) {
        throw new UnauthorizedError(authResult.error || 'Login failed with provider.');
      }
      // Potentially update last login time or other user attributes via userManager
      // await this.userManager.updateUserLastLogin(authResult.user.id, this.env.AUTH_DB);

      const decodedToken = this.tokenManager.decodeToken(authResult.accessToken);
      const expiresAt = decodedToken.exp; // exp is a Unix timestamp (seconds)

      if (typeof expiresAt !== 'number') {
        // This should ideally not happen if tokens are generated correctly with 'exp'
        throw new ServiceError('Token expiration not found or invalid in decoded token.', { service: 'auth', code: 'TOKEN_EXP_MISSING' });
      }

      return {
        user: authResult.user as User, // Ensure type compatibility
        tokenInfo: {
          token: authResult.accessToken,
          type: 'Bearer',
          expiresAt: expiresAt, // Unix timestamp in seconds
          refreshToken: authResult.refreshToken,
        }
      };
    } catch (error) {
      if (error instanceof BaseError) throw error;
      throw new UnauthorizedError('Login failed', { cause: error as Error, service: 'auth' });
    }
  }

  async register(providerName: string, registrationData: UserRegistrationData): Promise<{ user: User; tokenInfo: { token: string; type: string; expiresAt: number; refreshToken?: string } }> {
    try {
      const provider = this.getProvider(providerName);
      if (!provider.register) {
        throw new ValidationError(`Registration is not supported by the ${providerName} provider.`);
      }
      // Provider's register method returns AuthResult
      const authResult = await provider.register(registrationData);

      if (!authResult.success || !authResult.user || !authResult.accessToken) {
        throw new ValidationError(authResult.error || 'Registration failed with provider.');
      }
      
      const decodedToken = this.tokenManager.decodeToken(authResult.accessToken);
      const expiresAt = decodedToken.exp; // exp is a Unix timestamp (seconds)

      if (typeof expiresAt !== 'number') {
        throw new ServiceError('Token expiration not found or invalid in decoded token.', { service: 'auth', code: 'TOKEN_EXP_MISSING' });
      }

      return {
        user: authResult.user as User, // Ensure type compatibility
        tokenInfo: {
          token: authResult.accessToken,
          type: 'Bearer',
          expiresAt: expiresAt, // Unix timestamp in seconds
          refreshToken: authResult.refreshToken,
        }
      };
    } catch (error) {
      if (error instanceof BaseError) throw error;
      throw new ValidationError('Registration failed', { cause: error as Error, service: 'auth' });
    }
  }

  async validateToken(token: string, providerName?: SupportedAuthProvider): Promise<{ userId: string; provider: SupportedAuthProvider; details?: any; user?: User }> {
    // Log the received token at the entry point of validation
    console.log(`AuthService.validateToken: Received token (first 30 chars): ${token.substring(0, 30)}...`);
    console.log(`AuthService.validateToken: Received token length: ${token.length}`);
    console.log(`AuthService.validateToken: Received providerName: ${providerName}`);

    let processedToken = token;
    if (token.toLowerCase().startsWith('bearer ')) {
      processedToken = token.slice(7);
      console.log(`AuthService.validateToken: Stripped "Bearer " prefix. Token for verification (first 30 chars): ${processedToken.substring(0, 30)}...`);
    }

    try {
      // If providerName is given, use that provider.
      if (providerName) {
        const provider = this.getProvider(providerName); // providerName is now enum
        // getUserFromToken is the method in BaseAuthProvider for validating and getting user
        const user = await provider.getUserFromToken(processedToken); // Use processedToken
        if (!user) {
          throw new UnauthorizedError('Token validation failed: Invalid or expired token for the specified provider.');
        }
        // Ensure the returned user object is compatible with the expected structure.
        // The 'User' type from '../types' should be the source of truth.
        // provider.providerName should be the string value ('local', 'privy', etc.) matching the enum
        const returnedProvider = provider.providerName as SupportedAuthProvider; // Cast string to enum
        return { userId: user.id, provider: returnedProvider, user: user as User };
      }

      // If no providerName, attempt to decode and verify with the main TokenManager (HS256)
      // This assumes internal tokens are HS256 and external (like Privy) would need providerName.
      try {
        const payload = await this.tokenManager.verifyAccessToken(processedToken); // Use processedToken
        // Construct AuthContext for userManager
        const authContext = { env: this.env, db: this.env.AUTH_DB, waitUntil: (p: Promise<any>) => {} };
        const user = await this.userManager.findUserById(payload.userId, authContext);
        if (!user) {
          throw new UnauthorizedError('User not found for token.');
        }
        // Assuming internal tokens correspond to the LOCAL provider
        const internalProvider = SupportedAuthProvider.LOCAL;
        return { userId: user.id, provider: internalProvider, details: payload, user: user as User };
      } catch (e) {
        // If TokenManager fails, and no providerName was given, then fail.
        throw new UnauthorizedError('Token validation failed: Invalid or expired token.');
      }

    } catch (error) {
      if (error instanceof BaseError) throw error;
      throw new UnauthorizedError('Token validation failed', { cause: error as Error, service: 'auth' });
    }
  }

  async logout(token: string, providerName: string): Promise<void> {
    try {
      const provider = this.getProvider(providerName);
      await provider.logout(token); // This calls BaseAuthProvider's logout
      // BaseAuthProvider's logout internally calls tokenManager.revokeToken
    } catch (error) {
      if (error instanceof BaseError) throw error;
      console.warn(`Logout attempt failed for provider ${providerName}:`, error);
      // Depending on requirements, you might still want to throw or just log
      throw new ServiceError('Logout operation encountered an issue.', { cause: error as Error, service: 'auth' });
    }
  }

  async refreshTokens(refreshToken: string): Promise<{user: User; accessToken: string; refreshToken: string; expiresAt: number}> {
    // Verify refresh token
    const payload = await this.tokenManager.verifyRefreshToken(refreshToken);
    const userId = payload.userId;
    const user = await this.userManager.findUserById(userId, { env: this.env, db: this.env.AUTH_DB, waitUntil: (p: Promise<any>) => {} });
    if (!user) {
      throw new UnauthorizedError('Invalid refresh token – user not found');
    }
    const accessToken = await this.tokenManager.generateAccessToken({ userId });
    const newRefreshToken = await this.tokenManager.generateRefreshToken({ userId });
    const decoded = this.tokenManager.decodeToken(accessToken);
    return { user: user as User, accessToken, refreshToken: newRefreshToken, expiresAt: decoded.exp as number };
  }

  // Potentially add other methods like refreshToken, forgotPassword, resetPassword etc.
}
