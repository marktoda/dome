import { handlers } from '../../../../auth';

// Configure route to use Edge Runtime for Cloudflare Pages compatibility
export const runtime = 'experimental-edge';

// Export Auth.js v5 Edge-native handlers
export const { GET, POST } = handlers;
