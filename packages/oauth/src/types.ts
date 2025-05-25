import { z } from 'zod';

export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  scopes?: string[];
  authUrl: string;
  tokenUrl: string;
  userInfoUrl?: string;
  additionalParams?: Record<string, string>;
}

export interface OAuthFlowOptions {
  redirectPath?: string;
  additionalState?: Record<string, string>;
}

export interface OAuthInitResponse {
  authUrl: string;
  state: string;
}

export interface OAuthCallbackData {
  code: string;
  state: string;
  redirectPath?: string;
}

export interface StandardTokenData {
  userId: string;
  provider: string;
  providerAccountId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes?: string[];
  additionalData?: Record<string, any>;
}

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

export interface OAuthUserInfo {
  id: string;
  email?: string;
  name?: string;
  avatar?: string;
  additionalInfo?: Record<string, any>;
}

export interface StateData {
  state: string;
  redirectPath?: string;
  additionalData?: Record<string, string>;
  expiresAt: number;
}

export const OAuthErrorSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
  error_uri: z.string().optional(),
});

export type OAuthError = z.infer<typeof OAuthErrorSchema>;

export enum OAuthProvider {
  GITHUB = 'github',
  NOTION = 'notion',
}

export interface OAuthFlowResult {
  success: boolean;
  tokenData?: StandardTokenData;
  userInfo?: OAuthUserInfo;
  error?: string;
}