import { wrapServiceCall, getLogger, createServiceMetrics } from '@dome/common';

// Create service-specific metrics
const authMetrics = createServiceMetrics('auth');
import {
  LoginResponse,
  RegisterResponse,
  ValidateTokenResponse,
  LogoutResponse,
  SupportedAuthProvider,
} from '../types';

const runRpcWithLog = wrapServiceCall('auth');

export async function login(this: any, providerName: string, credentials: Record<string, unknown>): Promise<LoginResponse> {
  const requestId = crypto.randomUUID();
  return runRpcWithLog({ service: 'auth', op: 'rpcLogin', providerName, requestId }, async () => {
    authMetrics.counter('rpc.login.requests', 1, { providerName });
    getLogger().info(
      { providerName, requestId, operation: 'rpcLogin' },
      'Processing RPC login request',
    );

    const result = await this.unifiedAuthService.login(providerName, credentials);

    authMetrics.counter('rpc.login.success', 1, { providerName });
    getLogger().info(
      { userId: result.user.id, providerName, requestId, operation: 'rpcLogin' },
      'RPC Login successful',
    );

    return {
      success: true,
      user: result.user,
      token: result.tokenInfo.token,
      tokenType: result.tokenInfo.type,
      expiresAt: result.tokenInfo.expiresAt,
      provider: providerName,
    };
  });
}

export async function register(this: any, providerName: string, registrationData: Record<string, unknown>): Promise<RegisterResponse> {
  const requestId = crypto.randomUUID();
  return runRpcWithLog({ service: 'auth', op: 'rpcRegister', providerName, requestId }, async () => {
    authMetrics.counter('rpc.register.requests', 1, { providerName });
    getLogger().info(
      { providerName, requestId, operation: 'rpcRegister' },
      'Processing RPC register request',
    );

    const result = await this.unifiedAuthService.register(providerName, registrationData);

    authMetrics.counter('rpc.register.success', 1, { providerName });
    getLogger().info(
      { userId: result.user.id, providerName, requestId, operation: 'rpcRegister' },
      'RPC Registration successful',
    );
    return {
      success: true,
      user: result.user,
      token: result.tokenInfo.token,
      tokenType: result.tokenInfo.type,
      expiresAt: result.tokenInfo.expiresAt,
      provider: providerName,
    };
  });
}

export async function validateToken(this: any, token: string, providerName?: string): Promise<ValidateTokenResponse> {
  const requestId = crypto.randomUUID();
  return runRpcWithLog({ service: 'auth', op: 'rpcValidateToken', providerName, requestId }, async () => {
    authMetrics.counter('rpc.validateToken.requests', 1, {
      providerName: providerName || 'unknown',
    });
    getLogger().info(
      { providerName, requestId, operation: 'rpcValidateToken' },
      'Processing RPC validateToken request',
    );

    const providerEnum = providerName as SupportedAuthProvider | undefined;
    const result = await this.unifiedAuthService.validateToken(token, providerEnum);

    authMetrics.counter('rpc.validateToken.success', 1, {
      providerName: providerName || 'unknown',
    });
    getLogger().info(
      {
        userId: result.userId,
        provider: result.provider,
        requestId,
        operation: 'rpcValidateToken',
      },
      'RPC Token validation successful',
    );

    return {
      success: true,
      userId: result.userId,
      provider: result.provider,
      details: result.details,
      user: result.user,
    };
  });
}

export async function logout(this: any, providerName: string, token: string): Promise<LogoutResponse> {
  const requestId = crypto.randomUUID();
  return runRpcWithLog({ service: 'auth', op: 'rpcLogout', providerName, requestId }, async () => {
    authMetrics.counter('rpc.logout.requests', 1, { providerName });
    getLogger().info(
      { providerName, requestId, operation: 'rpcLogout' },
      'Processing RPC logout request',
    );

    await this.unifiedAuthService.logout(token, providerName);

    authMetrics.counter('rpc.logout.success', 1, { providerName });
    getLogger().info(
      { providerName, requestId, operation: 'rpcLogout' },
      'RPC Logout successful',
    );
    return { success: true };
  });
}

export async function refreshToken(this: any, refreshToken: string): Promise<LoginResponse> {
  const requestId = crypto.randomUUID();
  return runRpcWithLog({ service: 'auth', op: 'rpcRefresh', requestId }, async () => {
    authMetrics.counter('rpc.refresh.requests', 1);
    getLogger().info(
      { requestId, operation: 'rpcRefresh' },
      'Processing RPC refreshToken request',
    );

    const result = await this.unifiedAuthService.refreshTokens(refreshToken);

    authMetrics.counter('rpc.refresh.success', 1);
    getLogger().info(
      { requestId, userId: result.user.id, operation: 'rpcRefresh' },
      'Token refresh successful',
    );

    return {
      success: true,
      user: result.user,
      token: result.accessToken,
      refreshToken: result.refreshToken,
      tokenType: 'Bearer',
      expiresAt: result.expiresAt,
      provider: 'refresh',
    } as any;
  });
}
