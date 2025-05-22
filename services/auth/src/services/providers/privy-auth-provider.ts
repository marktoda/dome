import { jwtVerify, createRemoteJWKSet, JWTPayload } from 'jose';
import { BaseAuthProvider, AuthResult } from './base-auth-provider';
import { User } from '../../types'; // Corrected path
import { TokenManager } from '../token/token-manager'; // Corrected path
import { UserManager } from '../user/user-manager'; // Corrected path
import { UnauthorizedError, ValidationError, ServiceError } from '@dome/common/errors';

export interface PrivyAuthConfig {
  appId: string; // Privy Application ID
  jwksUri?: string; // Optional: override default JWKS URI
  // isEnabled can be part of the generic ProviderConfig in types.ts
  isEnabled?: boolean;
}

export interface PrivyAuthCredentials {
  token: string; // The Privy JWT
}

// Privy specific JWT payload fields (extend as needed)
interface PrivyJWTPayload extends JWTPayload {
  sub: string; // User's Privy DID (Decentralized Identifier)
  // Add other fields you expect from Privy JWT, e.g., email, wallet address
  email?: string; // Example: if Privy token contains email
}

const DEFAULT_PRIVY_JWKS_URI = 'https://auth.privy.io/jwks';

export class PrivyAuthProvider extends BaseAuthProvider {
  readonly providerName: string;
  private config: PrivyAuthConfig;
  private userManager: UserManager;
  private env: any;
  private jwksClient: ReturnType<typeof createRemoteJWKSet>;

  constructor(
    config: PrivyAuthConfig,
    tokenManager: TokenManager,
    userManager: UserManager,
    env: any, // Consider a more specific Env type
  ) {
    super(tokenManager);
    this.providerName = 'privy'; // Set provider name

    if (!config.appId) {
      throw new ServiceError('Privy App ID (appId) is required for PrivyAuthProvider.', {
        service: 'auth',
        code: 'PROVIDER_CONFIG_ERROR',
      });
    }
    this.config = config;
    this.userManager = userManager;
    this.env = env;

    const jwksUri = config.jwksUri || DEFAULT_PRIVY_JWKS_URI;
    this.jwksClient = createRemoteJWKSet(new URL(jwksUri));
  }

  private getAuthContext() {
    return {
      env: this.env,
      db: this.env.AUTH_DB,
      waitUntil: (promise: Promise<any>) => {
        /* Placeholder */
      },
    };
  }

  async authenticate(credentials: PrivyAuthCredentials): Promise<AuthResult> {
    if (!credentials.token) {
      throw new ValidationError('Privy token is required for authentication.');
    }

    const authContext = this.getAuthContext();

    try {
      const { payload } = await jwtVerify<PrivyJWTPayload>(credentials.token, this.jwksClient, {
        issuer: 'privy.io', // Standard Privy issuer
        audience: this.config.appId,
      });

      if (!payload.sub) {
        throw new UnauthorizedError('Privy token "sub" (DID) is missing.');
      }

      const privyUserId = payload.sub; // This is the Privy DID

      let user = await this.userManager.findUserByProvider(
        this.providerName,
        privyUserId,
        authContext,
      );

      if (!user) {
        console.log(`User with Privy DID ${privyUserId} not found. Attempting to create.`);
        const userToCreate: Partial<User> = {
          // Use email from token if available, otherwise it might be null or generated
          email: payload.email || `privy_${privyUserId.substring(0, 8)}@example.com`,
          authProvider: this.providerName,
          providerAccountId: privyUserId,
          emailVerified: !!payload.email, // Assume email verified if present in token, adjust as needed
          isActive: true,
        };
        user = await this.userManager.createUser(userToCreate, authContext, {
          providerId: this.providerName,
          providerUserId: privyUserId,
        });
      }

      const { accessToken, refreshToken } = await this.generateTokens(user);

      return {
        success: true,
        user,
        accessToken,
        refreshToken,
      };
    } catch (error: any) {
      console.error('Privy token validation or user processing failed:', error.message);
      if (
        error instanceof ServiceError ||
        error instanceof UnauthorizedError ||
        error instanceof ValidationError
      ) {
        throw error;
      }
      throw new UnauthorizedError(`Privy authentication failed: ${error.message}`, {
        cause: error,
      });
    }
  }

  async register(registrationData: PrivyAuthCredentials): Promise<AuthResult> {
    // For Privy, registration is often the same as the first authentication
    // if the user doesn't exist yet. The `authenticate` method handles implicit creation.
    console.warn(
      'PrivyAuthProvider.register called. Forwarding to authenticate, which handles implicit user creation.',
    );
    return this.authenticate(registrationData);
  }

  // findUserById is inherited from BaseAuthProvider
  // Other methods like refreshAccessToken, logout, getUserFromToken are inherited
}
