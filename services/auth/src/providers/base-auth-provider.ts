// Define basic types for credentials, user, and token for the interface
// These can be made more specific by actual provider implementations.

export type DefaultProviderCredentials = { [key: string]: any };
export type DefaultUser = { id: string; email?: string; [key: string]: any };
export type DefaultAuthToken = { token: string; type: string; expiresAt?: Date | number; [key: string]: any };
export type DefaultRegistrationData = { [key: string]: any };
export type DefaultTokenValidationResult = { userId: string; providerInfo?: any; [key: string]: any };

/**
 * Base interface for all authentication providers.
 * @template CredentialsType The type for login credentials.
 * @template UserType The type for user objects returned by the provider.
 * @template TokenType The type for authentication tokens issued by the provider.
 * @template RegistrationDataType The type for data required for user registration.
 * @template TokenValidationResultType The type for the result of token validation.
 */
export interface BaseAuthProvider<
  CredentialsType = DefaultProviderCredentials,
  UserType = DefaultUser,
  TokenType = DefaultAuthToken,
  RegistrationDataType = DefaultRegistrationData,
  TokenValidationResultType = DefaultTokenValidationResult,
> {
  /**
   * Logs in a user with the given credentials.
   * @param credentials - The credentials for login.
   * @returns A promise that resolves to an object containing the user and token.
   */
  login(credentials: CredentialsType): Promise<{ user: UserType; token: TokenType }>;

  /**
   * Registers a new user with the given registration data.
   * @param registrationData - The data for user registration.
   * @returns A promise that resolves to an object containing the user and token.
   */
  register(registrationData: RegistrationDataType): Promise<{ user: UserType; token: TokenType }>;

  /**
   * Validates an authentication token.
   * @param token - The token to validate.
   * @returns A promise that resolves to the validation result, typically including user ID.
   */
  validateToken(token: string): Promise<TokenValidationResultType>;

  /**
   * Logs out a user by invalidating their token, if applicable.
   * @param token - The token to invalidate.
   * @returns A promise that resolves when logout is complete.
   */
  logout(token: string): Promise<void>;

  /**
   * (Optional) Refreshes an authentication token.
   * @param refreshToken - The refresh token.
   * @returns A promise that resolves to a new authentication token.
   */
  refreshToken?(refreshToken: string): Promise<TokenType>;
}