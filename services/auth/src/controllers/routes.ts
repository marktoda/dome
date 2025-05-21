import { Hono } from 'hono';
import { ValidationError } from '@dome/common/errors';
import {
  LoginResponse,
  RegisterResponse,
  ValidateTokenResponse,
  LogoutResponse,
  SupportedAuthProvider,
} from '../types';
import type { AuthService as UnifiedAuthService } from '../services/auth-service';
import type { Env } from '../index';
export function registerRoutes(app: Hono<{ Bindings: Env }>, service: UnifiedAuthService) {
  // /login
  app.post('/login', async c => {
    const body = await c.req.json<{ providerName: string; credentials: Record<string, unknown> }>();
    if (!body.providerName || !body.credentials) {
      throw new ValidationError('providerName and credentials are required.');
    }
    const result = await service.login(body.providerName, body.credentials);
    const response: LoginResponse = {
      success: true,
      user: result.user,
      token: result.tokenInfo.token,
      tokenType: result.tokenInfo.type,
      expiresAt: result.tokenInfo.expiresAt,
      provider: body.providerName,
    };
    return c.json(response);
  });

  // /register
  app.post('/register', async c => {
    const body = await c.req.json<{ providerName: string; registrationData: Record<string, unknown> }>();
    if (!body.providerName || !body.registrationData) {
      throw new ValidationError('providerName and registrationData are required.');
    }
    const result = await service.register(body.providerName, body.registrationData);
    const response: RegisterResponse = {
      success: true,
      user: result.user,
      token: result.tokenInfo.token,
      tokenType: result.tokenInfo.type,
      expiresAt: result.tokenInfo.expiresAt,
      provider: body.providerName,
    };
    return c.json(response);
  });

  // /validate
  app.post('/validate', async c => {
    const body = await c.req.json<{ token: string; providerName?: string }>();
    if (!body.token) {
      throw new ValidationError('token is required.');
    }
    const providerEnum = body.providerName as SupportedAuthProvider | undefined;
    const result = await service.validateToken(body.token, providerEnum);
    const response: ValidateTokenResponse = {
      success: true,
      userId: result.userId,
      provider: result.provider,
      details: result.details,
    };
    return c.json(response);
  });

  // /logout
  app.post('/logout', async c => {
    const body = await c.req.json<{ providerName: string; token: string }>();
    if (!body.providerName || !body.token) {
      throw new ValidationError('providerName and token are required.');
    }
    await service.logout(body.token, body.providerName);
    const response: LogoutResponse = { success: true };
    return c.json(response);
  });

  app.get('/health', c => c.text('OK'));
}
