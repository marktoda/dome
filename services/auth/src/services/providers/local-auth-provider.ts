import * as bcrypt from 'bcryptjs';
import { BaseAuthProvider, AuthResult } from './base-auth-provider';
import { User, SupportedAuthProvider } from '../../types'; // Corrected path
import { TokenManager } from '../token/token-manager'; // Corrected path
import { UserManager } from '../user/user-manager'; // Corrected path
import { UnauthorizedError, ValidationError, ServiceError, BaseError } from '@dome/common/errors'; // Added BaseError

export interface LocalAuthConfig {
  saltRounds?: number;
  // isEnabled should be part of the generic ProviderConfig in types.ts
  isEnabled?: boolean; // Kept for direct use if not using global config structure
}

export interface LocalAuthCredentials {
  email: string;
  password?: string; // Password is required for creation and email/pass login
}

const DEFAULT_SALT_ROUNDS = 10;

export class LocalAuthProvider extends BaseAuthProvider {
  readonly providerName: string;
  private config: LocalAuthConfig;
  private userManager: UserManager;
  private env: any; // Store env

  constructor(
    config: LocalAuthConfig,
    tokenManager: TokenManager,
    userManager: UserManager,
    env: any, // Consider a more specific Env type
  ) {
    super(tokenManager); // BaseAuthProvider expects tokenManager
    this.providerName = SupportedAuthProvider.LOCAL; // Set provider name
    this.config = {
      ...config,
      saltRounds: config.saltRounds || DEFAULT_SALT_ROUNDS,
    };
    this.userManager = userManager;
    this.env = env; // Store env
  }

  private getAuthContext() {
    if (!this.env || !this.env.AUTH_DB) {
      // Or handle this more gracefully, maybe throw a config error
      console.error('AUTH_DB not found in environment provided to LocalAuthProvider');
      throw new ServiceError('LocalAuthProvider not configured correctly with AUTH_DB.', {
        service: 'auth',
        code: 'PROVIDER_CONFIG_ERROR',
      });
    }
    return {
      env: this.env,
      db: this.env.AUTH_DB,
      waitUntil: (promise: Promise<any>) => {
        /* Placeholder for waitUntil if needed */
      },
    };
  }

  /**
   * Authenticates a user with email and password.
   */
  async authenticate(credentials: LocalAuthCredentials): Promise<AuthResult> {
    if (!credentials.email || !credentials.password) {
      throw new ValidationError('Email and password are required for local authentication.');
    }
    const authContext = this.getAuthContext();
    const user = await this.userManager.findUserByEmail(credentials.email, authContext);

    if (!user || !user.password) {
      // Schema User has 'password' (hashed)
      throw new UnauthorizedError('Invalid email or password.');
    }

    const isValidPassword = await bcrypt.compare(credentials.password, user.password);
    if (!isValidPassword) {
      throw new UnauthorizedError('Invalid email or password.');
    }

    const { accessToken, refreshToken } = await this.generateTokens(user);

    return {
      success: true,
      user,
      accessToken,
      refreshToken,
    };
  }

  /**
   * Creates a new user with email and password.
   * This method is typically called by the main AuthService during a registration flow.
   */
  async register(registrationData: LocalAuthCredentials): Promise<AuthResult> {
    if (!registrationData.email || !registrationData.password) {
      throw new ValidationError('Email and password are required to register a local user.');
    }
    const registerAuthContext = this.getAuthContext();

    try {
      const existingUser = await this.userManager.findUserByEmail(
        registrationData.email,
        registerAuthContext,
      );
      if (existingUser) {
        throw new ServiceError('User with this email already exists.', {
          code: 'USER_ALREADY_EXISTS',
          service: 'auth',
          httpStatus: 409,
        });
      }

      const hashedPassword = await bcrypt.hash(registrationData.password, this.config.saltRounds!);

      const userToCreate: Partial<User> = {
        email: registrationData.email,
        password: hashedPassword,
        authProvider: this.providerName,
        providerAccountId: registrationData.email,
        emailVerified: false,
        isActive: true,
      };

      const newUser = await this.userManager.createUser(userToCreate, registerAuthContext, {
        providerId: this.providerName,
        providerUserId: registrationData.email,
      });

      if (!newUser) {
        // Should not happen if createUser throws on failure, but as a safeguard
        throw new ServiceError('Failed to create user.', {
          code: 'USER_CREATION_FAILED',
          service: 'auth',
        });
      }

      const { accessToken, refreshToken } = await this.generateTokens(newUser);

      return {
        success: true,
        user: newUser,
        accessToken,
        refreshToken,
      };
    } catch (error) {
      if (error instanceof BaseError) {
        // Re-throw known errors
        throw error;
      }
      // Log the original error for debugging
      console.error('Error during local provider registration:', error);
      // Wrap unknown errors in a ServiceError
      throw new ServiceError('An unexpected error occurred during registration.', {
        cause: error as Error,
        code: 'REGISTRATION_GENERAL_ERROR',
        service: 'auth',
      });
    }
  }

  /**
   * Finds a user by their ID using the UserManager.
   * This overrides the placeholder implementation in BaseAuthProvider.
   * @param userId - The ID of the user to find.
   * @returns A promise that resolves to the User object or null if not found.
   */
  protected async findUserById(userId: string): Promise<User | null> {
    const authContext = this.getAuthContext();
    return this.userManager.findUserById(userId, authContext);
  }

  // Other methods like refreshAccessToken, logout, getUserFromToken are inherited from BaseAuthProvider
  // getUserFromToken will now use the overridden findUserById from this class.
}
