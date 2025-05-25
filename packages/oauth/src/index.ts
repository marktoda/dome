// Main exports
export { OAuthFlowManager } from './OAuthFlowManager.js';
export { OAuthConfig } from './config.js';

// Provider exports
export { BaseOAuthProvider } from './providers/BaseOAuthProvider.js';
export { GitHubProvider } from './providers/GitHubProvider.js';
export { NotionProvider } from './providers/NotionProvider.js';

// Manager exports
export { 
  StateManager, 
  StateStorage, 
  MemoryStateStorage 
} from './managers/StateManager.js';
export { 
  TokenManager, 
  TokenStorage, 
  TokenEncryption, 
  MemoryTokenStorage, 
  NoOpTokenEncryption 
} from './managers/TokenManager.js';

// Next.js utilities
export { 
  NextJSOAuthHandlers, 
  createOAuthRoutes 
} from './nextjs/RouteHandlers.js';
export type { NextJSOAuthConfig } from './nextjs/RouteHandlers.js';

// Type exports
export type {
  OAuthProviderConfig,
  OAuthFlowOptions,
  OAuthInitResponse,
  OAuthCallbackData,
  StandardTokenData,
  OAuthTokenResponse,
  OAuthUserInfo,
  StateData,
  OAuthFlowResult,
} from './types.js';

export { OAuthProvider, OAuthErrorSchema } from './types.js';