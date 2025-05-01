import { getLogger } from '@dome/logging';
import { AuthClient, createAuthClient } from './client';
import type {
  AuthBinding,
  AuthService,
  LoginResponse,
  RegisterResponse,
  ValidateTokenResponse,
  LogoutResponse,
  User
} from './types';

export * from './types';
export * from './client';

/**
 * CloudflareWorker-style binding for the auth service
 * This is what the Worker runtime expects for service bindings
 */
export interface AuthWorkerBinding {
  login: typeof Auth.prototype.login;
  register: typeof Auth.prototype.register;
  validateToken: typeof Auth.prototype.validateToken;
  logout: typeof Auth.prototype.logout;
}

/**
 * Creates an AuthClient from a Cloudflare Worker binding
 * This is the main entry point for other services to consume the auth service
 *
 * @param binding The Cloudflare Worker binding to the auth service
 * @returns An AuthService implementation
 */
export function createAuthServiceFromBinding(binding: AuthWorkerBinding): AuthService {
  // The binding is already compatible with our AuthBinding interface
  // since it exports the same method signatures
  return createAuthClient(binding as unknown as AuthBinding);
}

/**
 * Reference to the Auth class from index.ts
 * Used for type inference only
 */
declare class Auth {
  login(email: string, password: string): Promise<LoginResponse>;
  register(email: string, password: string, name?: string): Promise<RegisterResponse>;
  validateToken(token: string): Promise<ValidateTokenResponse>;
  logout(token: string): Promise<LogoutResponse>;
}
