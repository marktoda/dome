import { createOAuthRoutes } from '@dome/oauth';
import { oauthConfig } from '@/lib/oauth-config';

const { connect } = createOAuthRoutes('notion', oauthConfig);

export const GET = connect;