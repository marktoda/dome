import { createOAuthRoutes } from '@dome/oauth';
import { oauthConfig } from '@/lib/oauth-config';

const { callback } = createOAuthRoutes('github', oauthConfig);

export const GET = callback;