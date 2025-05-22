import { z } from 'zod';

const csv = z
  .string()
  .transform(val => val.split(',').map(v => v.trim()).filter(Boolean));

export const AuthEnvSchema = z.object({
  AUTH_DB: z.any(),
  AUTH_TOKENS: z.any().optional(),
  ENVIRONMENT: z.string().optional(),
  VERSION: z.string().optional(),

  AUTH_PRIVY_ENABLED: z.string().optional(),
  PRIVY_APP_ID: z.string().optional(),
  PRIVY_JWKS_URI: z.string().optional(),

  AUTH_GOOGLE_CLIENT_ID: z.string().optional(),
  AUTH_GOOGLE_CLIENT_SECRET: z.string().optional(),
  AUTH_GOOGLE_CALLBACK_URL: z.string().optional(),
  AUTH_GOOGLE_SCOPES: csv.optional(),
  AUTH_GOOGLE_ENABLED: z.string().optional(),

  AUTH_GITHUB_CLIENT_ID: z.string().optional(),
  AUTH_GITHUB_CLIENT_SECRET: z.string().optional(),
  AUTH_GITHUB_CALLBACK_URL: z.string().optional(),
  AUTH_GITHUB_SCOPES: csv.optional(),
  AUTH_GITHUB_ENABLED: z.string().optional(),

  JWT_ACCESS_TOKEN_SECRET: z.string(),
  JWT_ACCESS_TOKEN_EXPIRES_IN: z.string().optional(),
  JWT_REFRESH_TOKEN_SECRET: z.string(),
  JWT_REFRESH_TOKEN_EXPIRES_IN: z.string().optional(),
  JWT_ISSUER: z.string().optional(),
  JWT_AUDIENCE: z.string().optional(),
});

export type AuthEnv = z.infer<typeof AuthEnvSchema>;
