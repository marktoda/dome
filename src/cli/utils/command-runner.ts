import logger from '../../mastra/utils/logger.js';

/**
 * Wrap an async command function so any un-handled error is logged and the
 * process exits with a non-zero code. Use it like:
 *   program.command('foo').action((...args) => run(() => foo(args)))
 */
export function run(fn: () => Promise<void>): void {
  fn().catch(err => {
    if (err instanceof Error && err.message?.includes('SIGINT')) {
      logger.warn('\n🚫 Operation cancelled');
      process.exit(0);
    }
    // Commander already prints the stack when DEBUG – keep it tidy otherwise
    if (err instanceof Error) {
      logger.error(`❌ ${err.message}`);
    } else {
      logger.error(err);
    }
    process.exit(1);
  });
} 