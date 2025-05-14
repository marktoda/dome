# Auth Service Documentation

## 1. Overview of the Architecture

The Auth service is responsible for managing user authentication and authorization within the platform. It is designed with a modular and extensible architecture to support various authentication providers and strategies.

Key components of the architecture include:

- **AuthService**: The central orchestrator that handles login, registration, token validation, and logout requests. It delegates provider-specific logic to the appropriate `IAuthProvider`.
- **IAuthProvider Interface**: Defines a common contract for all authentication providers (e.g., local username/password, Privy, OAuth providers). This allows for easy addition of new authentication methods.
  - **LocalAuthProvider**: Implements authentication using email/password stored securely in our database.
  - **PrivyAuthProvider**: Implements authentication by integrating with [Privy.io](https://privy.io/), leveraging their wallet-based and social login capabilities.
- **TokenManager**: Responsible for generating, verifying, and (if applicable) managing the lifecycle of authentication tokens (e.g., JWTs).
- **UserManager**: Manages user data, including creating new users, finding existing users, and linking accounts from different providers.
- **User Entity**: Represents a user in the system, storing profile information, provider details, and security-related data.
- **Configuration**: Environment variables and configuration files are used to manage settings for JWT secrets, provider API keys, token expiration times, etc.

The primary goals of this architecture are:

- **Security**: Prioritizing secure storage of credentials, robust token handling, and protection against common attack vectors.
- **Modularity**: Separating concerns to make the system easier to understand, maintain, and test.
- **Extensibility**: Allowing new authentication providers to be added with minimal changes to the core service.
- **Scalability**: Designing components to handle a growing number of users and authentication requests.

## 2. Authentication Flow Diagrams

_(These diagrams would ideally be actual image files or use a text-based diagramming tool like Mermaid.js)_

### 2.1. Local Provider - Registration Flow

```mermaid
sequenceDiagram
    participant Client
    participant AuthGateway as API Gateway / Load Balancer
    participant AuthService
    participant LocalAuthProvider
    participant UserManager
    participant PasswordManager
    participant TokenManager

    Client->>+AuthGateway: POST /auth/local/register (email, password, name)
    AuthGateway->>+AuthService: register('local', {email, password, name})
    AuthService->>+LocalAuthProvider: register({email, password, name})
    LocalAuthProvider->>+UserManager: findUserByEmail(email)
    UserManager-->>-LocalAuthProvider: null (user not found)
    LocalAuthProvider->>+PasswordManager: hashPassword(password)
    PasswordManager-->>-LocalAuthProvider: hashedPassword
    LocalAuthProvider->>+UserManager: createUser({email, hashedPassword, name, provider:'local'})
    UserManager-->>-LocalAuthProvider: newUser (excluding hashedPassword)
    LocalAuthProvider-->>-AuthService: { user: newUser }
    AuthService->>+TokenManager: generateToken({ userId: newUser.id })
    TokenManager-->>-AuthService: jwtToken
    AuthService-->>-AuthGateway: { user: newUser, token: jwtToken }
    AuthGateway-->>-Client: 201 Created { user, token }
```

### 2.2. Local Provider - Login Flow

```mermaid
sequenceDiagram
    participant Client
    participant AuthGateway as API Gateway / Load Balancer
    participant AuthService
    participant LocalAuthProvider
    participant UserManager
    participant PasswordManager
    participant TokenManager

    Client->>+AuthGateway: POST /auth/local/login (email, password)
    AuthGateway->>+AuthService: login('local', {email, password})
    AuthService->>+LocalAuthProvider: login({email, password})
    LocalAuthProvider->>+UserManager: findUserByEmail(email)
    UserManager-->>-LocalAuthProvider: existingUser (with hashedPassword)
    alt User Found and is Local Provider
        LocalAuthProvider->>+PasswordManager: comparePassword(password, existingUser.hashedPassword)
        PasswordManager-->>-LocalAuthProvider: true (password matches)
        LocalAuthProvider-->>-AuthService: { user: cleanUser }
        AuthService->>+TokenManager: generateToken({ userId: cleanUser.id })
        TokenManager-->>-AuthService: jwtToken
        AuthService-->>-AuthGateway: { user: cleanUser, token: jwtToken }
        AuthGateway-->>-Client: 200 OK { user, token }
    else User Not Found or Incorrect Password
        LocalAuthProvider-->>-AuthService: Error (Invalid Credentials)
        AuthService-->>-AuthGateway: Error Response
        AuthGateway-->>-Client: 401 Unauthorized
    end
```

### 2.3. Privy Provider - Login/Registration Flow

```mermaid
sequenceDiagram
    participant ClientApp as Client Application (Web/Mobile)
    participant PrivySDK as Privy SDK (Client-Side)
    participant AuthGateway as API Gateway / Load Balancer
    participant AuthService
    participant PrivyAuthProvider
    participant PrivyClient as Server-Side Privy Client
    participant UserManager
    participant TokenManager

    ClientApp->>+PrivySDK: User initiates login (e.g., connect wallet, social login)
    PrivySDK-->>ClientApp: privyAuthToken (after successful Privy authentication)
    ClientApp->>+AuthGateway: POST /auth/privy/callback (privyAuthToken)
    AuthGateway->>+AuthService: login('privy', { privyToken: privyAuthToken })
    AuthService->>+PrivyAuthProvider: login({ privyToken: privyAuthToken })
    PrivyAuthProvider->>+PrivyClient: validateTokenAndGetUser(privyToken)
    PrivyClient-->>-PrivyAuthProvider: privyUserData (e.g., {id, email, name})
    alt Privy Token Valid
        PrivyAuthProvider->>+UserManager: findOrCreateUser({externalId: privyUserData.id, email, name, provider:'privy'})
        UserManager-->>-PrivyAuthProvider: appUser (our application's user object)
        PrivyAuthProvider-->>-AuthService: { user: appUser }
        AuthService->>+TokenManager: generateToken({ userId: appUser.id })
        TokenManager-->>-AuthService: jwtToken (application session token)
        AuthService-->>-AuthGateway: { user: appUser, token: jwtToken }
        AuthGateway-->>-ClientApp: 200 OK { user, token }
    else Privy Token Invalid
        PrivyAuthProvider-->>-AuthService: Error (Privy Validation Failed)
        AuthService-->>-AuthGateway: Error Response
        AuthGateway-->>-ClientApp: 401 Unauthorized
    end
```

### 2.4. Token Validation Flow (General)

```mermaid
sequenceDiagram
    participant Client
    participant ResourceServer as Protected Resource Server
    participant AuthGateway as API Gateway (acts as validator or forwards to AuthService)
    participant AuthService
    participant TokenManager
    participant UserManager

    Client->>+ResourceServer: GET /api/protected/resource (Authorization: Bearer jwtToken)
    ResourceServer->>+AuthGateway: Validate Token (or middleware does this)
    AuthGateway->>+AuthService: validateToken(jwtToken)
    AuthService->>+TokenManager: verifyToken(jwtToken)
    TokenManager-->>-AuthService: decodedPayload (e.g., {userId, exp, iat})
    alt Token Valid and Not Expired
        AuthService->>+UserManager: findUserById(decodedPayload.userId)
        UserManager-->>-AuthService: user
        AuthService-->>-AuthGateway: { isValid: true, user: user }
        AuthGateway-->>ResourceServer: Validation Success (user context attached)
        ResourceServer-->>-Client: 200 OK (with resource data)
    else Token Invalid or Expired or User Not Found
        AuthService-->>-AuthGateway: { isValid: false, user: null }
        AuthGateway-->>ResourceServer: Validation Failure
        ResourceServer-->>-Client: 401 Unauthorized / 403 Forbidden
    end
```

## 3. Provider Abstraction and Extension Guide

The `IAuthProvider` interface is key to the extensibility of the auth service.

### 3.1. `IAuthProvider` Interface Definition (Conceptual)

```typescript
// Conceptual representation - actual path: ./src/services/providers/i-auth-provider.ts (or similar)
interface IAuthProvider<C, R, L, V> {
  /**
   * Returns the type of the provider (e.g., 'local', 'privy', 'google').
   */
  getProviderType(): string;

  /**
   * Handles user registration with the provider.
   * @param details - Registration details specific to the provider.
   * @returns A promise resolving to an object containing the user.
   * @throws AuthError if registration fails.
   */
  register(details: R): Promise<{ user: User }>; // User is your application's User entity

  /**
   * Handles user login with the provider.
   * @param credentials - Login credentials specific to the provider.
   * @returns A promise resolving to an object containing the user.
   * @throws AuthError if login fails.
   */
  login(credentials: L): Promise<{ user: User }>;

  /**
   * Validates credentials without necessarily creating a session.
   * Useful for checking if credentials are correct.
   * @param credentials - Credentials to validate.
   * @returns A promise resolving to an object containing the user if valid, otherwise null or throws.
   */
  validateCredentials?(credentials: V): Promise<{ user: User } | null>;

  // Potentially other methods like:
  // refreshToken?(refreshTokenDetails: any): Promise<{ accessToken: string }>;
  // logout?(userContext: any, token?: string): Promise<void>;
}
```

### 3.2. Adding a New Authentication Provider (e.g., OAuth - Google)

1.  **Create the Provider Implementation**:
    Create a new class, e.g., `GoogleAuthProvider.ts`, that implements the `IAuthProvider` interface.

    ```typescript
    // Example: services/auth/src/services/providers/google-auth-provider.ts
    import { IAuthProvider } from './i-auth-provider';
    import { User } from '../../entities/user';
    import { UserManager } // ...
    // import GoogleStrategy or Google API client

    class GoogleAuthProvider implements IAuthProvider<any, any, { googleIdToken: string }, any> {
        constructor(
            private userManager: UserManager,
            // private googleClient: GoogleClient // Your Google API client wrapper
        ) {}

        getProviderType(): string {
            return 'google';
        }

        async register(details: { googleIdToken: string }): Promise<{ user: User }> {
            // For OAuth, registration is often implicit in the first login
            return this.login(details);
        }

        async login(credentials: { googleIdToken: string }): Promise<{ user: User }> {
            // 1. Validate googleIdToken with Google's servers
            // const googleProfile = await this.googleClient.verifyIdToken(credentials.googleIdToken);
            // if (!googleProfile) throw new AuthError('Invalid Google token', AuthErrorType.EXTERNAL_AUTH_FAILED);

            // 2. Find or create user in your system based on googleProfile.sub (Google's unique ID) and email
            // const user = await this.userManager.findOrCreateUser({
            //   externalId: googleProfile.sub,
            //   email: googleProfile.email,
            //   name: googleProfile.name,
            //   provider: 'google',
            //   // other details...
            // });
            // if (!user) throw new AuthError('Failed to process Google user', AuthErrorType.USER_PROCESSING_ERROR);
            // return { user };
            throw new Error('Not implemented'); // Placeholder
        }

        // validateCredentials might not be applicable or could re-verify a token
    }
    ```

2.  **Update `AuthService`**:
    In `AuthService`, import and instantiate your new provider. Add it to the `providers` map.

    ```typescript
    // In AuthService constructor or initialization logic
    // import { GoogleAuthProvider } from './providers/google-auth-provider';
    // ...
    // this.providers = {
    //   local: new LocalAuthProvider(...),
    //   privy: new PrivyAuthProvider(...),
    //   google: new GoogleAuthProvider(this.userManager, /* this.googleClient */), // Add new provider
    // };
    ```

3.  **Configuration**:
    Add any necessary configuration for the new provider (e.g., Google Client ID, Client Secret) to your environment variables and configuration files. Ensure these are securely managed.

4.  **API Endpoints**:
    Define new API endpoints if required for the provider's flow (e.g., `/auth/google/callback` for OAuth).

5.  **Testing**:
    Write comprehensive unit and integration tests for the new provider.

## 4. API Reference

_(This section should detail all HTTP and RPC endpoints exposed by the Auth service. Actual paths and request/response bodies will depend on your specific Hono/RPC setup.)_

### 4.1. HTTP Endpoints

Base Path: `/auth`

| Method | Endpoint          | Provider | Description                                        | Request Body (Example)                                     | Response (Success - Example)               | Response (Error - Example)                 |
| :----- | :---------------- | :------- | :------------------------------------------------- | :--------------------------------------------------------- | :----------------------------------------- | :----------------------------------------- |
| POST   | `/local/register` | Local    | Registers a new user.                              | `{ "email": "u@e.com", "password": "...", "name": "..." }` | `201 { "user": {...}, "token": "jwt..." }` | `400, 409 { "error": "message" }`          |
| POST   | `/local/login`    | Local    | Logs in an existing user.                          | `{ "email": "u@e.com", "password": "..." }`                | `200 { "user": {...}, "token": "jwt..." }` | `401 { "error": "Invalid credentials" }`   |
| POST   | `/privy/callback` | Privy    | Handles Privy authentication callback.             | `{ "privyToken": "privy_jwt..." }`                         | `200 { "user": {...}, "token": "jwt..." }` | `401 { "error": "Invalid Privy token" }`   |
| GET    | `/validate-token` | N/A      | Validates the provided session token (via Bearer). | N/A (Token in `Authorization` header)                      | `200 { "isValid": true, "user": {...} }`   | `401 { "isValid": false, "user": null }`   |
| POST   | `/logout`         | N/A      | Logs out the user (invalidates token if stateful). | N/A (Token in `Authorization` header)                      | `200/204 { "message": "Logged out" }`      | `401 { "error": "Unauthorized" }`          |
| POST   | `/refresh-token`  | N/A      | (If implemented) Refreshes an access token.        | `{ "refreshToken": "..." }`                                | `200 { "accessToken": "jwt..." }`          | `401 { "error": "Invalid refresh token" }` |

### 4.2. RPC Endpoints (Conceptual)

If using RPC (e.g., Hono RPC, tRPC), the methods would mirror the `AuthService` capabilities:

- `auth.login(providerType: string, credentials: any): Promise<{ user: User, token: string }>`
- `auth.register(providerType: string, details: any): Promise<{ user: User, token: string }>`
- `auth.validateToken(token: string): Promise<{ isValid: boolean, user: User | null }>`
- `auth.logout(token: string): Promise<{ success: boolean }>`
- `auth.refreshToken?(refreshToken: string): Promise<{ accessToken: string }>`

Refer to the specific RPC implementation details for exact method signatures and client usage.

## 5. Configuration Guide

The Auth service relies on environment variables for critical configuration. Ensure these are set appropriately in your deployment environments and local `.dev.vars` (or equivalent).

| Variable Name          | Description                                                                    | Example Value                    | Required |
| :--------------------- | :----------------------------------------------------------------------------- | :------------------------------- | :------- |
| `JWT_SECRET_KEY`       | Secret key used to sign and verify JWTs. **Keep this highly confidential.**    | `a_very_strong_and_long_secret`  | Yes      |
| `JWT_EXPIRES_IN`       | Duration for which JWTs are valid (e.g., '1h', '15m', '7d').                   | `1h`                             | Yes      |
| `PRIVY_APP_ID`         | Your Privy Application ID.                                                     | `cl_abcdef123456`                | If Privy |
| `PRIVY_APP_SECRET`     | Your Privy Application Secret. **Keep this highly confidential.**              | `ps_abcdefghijklmnopqrstuvwxyz`  | If Privy |
| `PASSWORD_SALT_ROUNDS` | Number of rounds for bcrypt/argon2 hashing (if applicable for local provider). | `10`                             | If Local |
| `DATABASE_URL`         | Connection string for the user database.                                       | `postgresql://user:pass@host/db` | Yes      |
| `REDIS_URL`            | (If using Redis for token blacklisting/caching) Connection string for Redis.   | `redis://localhost:6379`         | Optional |

**Security Note:**

- **Never hardcode secrets** like `JWT_SECRET_KEY` or `PRIVY_APP_SECRET` directly in the code.
- Use a secure method for managing environment variables in production (e.g., Cloudflare Secrets, HashiCorp Vault, AWS Secrets Manager).
- Rotate `JWT_SECRET_KEY` periodically as a security best practice.

### Local Development (`.dev.vars`)

For local development with Wrangler, create a `.dev.vars` file in the `services/auth` directory:

```ini
JWT_SECRET_KEY="your_local_jwt_secret_for_testing_only"
JWT_EXPIRES_IN="1h"
PRIVY_APP_ID="your_privy_test_app_id"
PRIVY_APP_SECRET="your_privy_test_app_secret"
DATABASE_URL="your_local_database_connection_string"
# PASSWORD_SALT_ROUNDS=10
```

Remember to add `.dev.vars` to your `.gitignore` file to prevent committing local secrets.
