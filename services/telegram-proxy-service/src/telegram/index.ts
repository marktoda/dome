/**
 * Telegram module exports
 *
 * This file exports all components from the telegram module
 * to provide a clean interface for other parts of the application.
 */

// Export client wrapper
export { TelegramClientWrapper } from './clientWrapper';

// Export client pool
export { TelegramClientPool, clientPool } from './clientPool';

// Export session manager
export { SessionManager } from './sessionManager';

// Export types
export * from './types';

/**
 * Create and initialize the client pool
 * This is a convenience function to initialize the client pool
 */
export async function initializeTelegramClientPool(): Promise<void> {
  const { clientPool } = await import('./clientPool');
  await clientPool.initialize();
}
