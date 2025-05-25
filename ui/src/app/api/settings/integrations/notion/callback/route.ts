import { createOAuthRoutes } from '@dome/oauth';
import { oauthConfig } from '@/lib/oauth-config';

const { callback } = createOAuthRoutes('notion', oauthConfig);

export const GET = callback;