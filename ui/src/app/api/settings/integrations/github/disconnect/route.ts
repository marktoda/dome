import { createOAuthRoutes } from '@dome/oauth';
import { oauthConfig } from '@/lib/oauth-config';

const { disconnect } = createOAuthRoutes('github', oauthConfig);

export const POST = disconnect;