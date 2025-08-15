// Main chat component export
export { ChatApp } from './components/ChatApp.js';

// Type exports
export type { ChatMessage, ActivityEvent, IndexingStatus, RootState } from './state/types.js';

// Hook exports
export { useStream } from './hooks/useStream.js';
export { useMessageRenderer } from './hooks/useMessageRenderer.js';

// State exports
export {
  AppProvider,
  useAppState,
  useChatState,
  useActivityState,
  useConfigState,
  useUIState,
  useIndexingState,
} from './state/AppContext.js';

// Utility exports
export { setActivityTracker, trackActivity } from './utils/activityTracker.js';
export { withRetry, createErrorMessage, isRetryableError } from './utils/errorHandler.js';

// Constants
export { COLORS, STREAMING, LIMITS, LAYOUT } from './constants.js';
