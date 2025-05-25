import { createOAuthRoutes } from '@dome/oauth';
import { oauthConfig } from '@/lib/oauth-config';

const { disconnect } = createOAuthRoutes('notion', oauthConfig);

export const POST = disconnect;