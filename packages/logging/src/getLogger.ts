import { als, baseLogger } from './runtime';
import type { Logger } from 'pino';

export function getLogger(): Logger {
  return (als.getStore()?.get('logger') as Logger) ?? baseLogger;
}
