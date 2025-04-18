import pino from 'pino';

/**
 * Configuration options for initializing the logging system
 */
export interface InitOptions {
  /**
   * Factory function to generate unique request IDs
   * Defaults to nanoid(12) if not provided
   */
  idFactory?: () => string;

  /**
   * Additional data to include with every log entry
   * Useful for adding application-wide context like service name, version, etc.
   */
  extraBindings?: Record<string, unknown>;

  /**
   * Log level to use
   * Can be one of: 'trace', 'debug', 'info', 'warn', 'error', 'fatal', or 'silent'
   * Defaults to 'info' if not provided
   */
  level?: pino.LevelWithSilent;

  /**
   * Custom serializer function for log objects
   * Can be used to transform or sanitize log data before output
   */
  serializer?: pino.SerializerFn;
}
