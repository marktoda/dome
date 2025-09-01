import pino from 'pino';

// Resolve the desired log level once, in order of preference:
// 1. Explicit LOG_LEVEL env var
// 2. Legacy/shortcut DEBUG env var (any truthy value enables "debug")
// 3. Fallback to the default "info" level
const logLevel = process.env.LOG_LEVEL ?? (process.env.DEBUG ? 'debug' : 'info');

const baseLogger = pino({
  level: logLevel,
  transport:
    process.env.NODE_ENV !== 'production'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            ignore: 'pid,hostname',
            translateTime: 'SYS:standard',
          },
        }
      : undefined,
});

// Wrap logger to intercept for debug panel if available
const logger = new Proxy(baseLogger, {
  get(target, prop) {
    const original = target[prop as keyof typeof target];
    
    // Only intercept logging methods
    if (typeof original === 'function' && ['debug', 'info', 'warn', 'error', 'fatal'].includes(prop as string)) {
      return function(...args: any[]) {
        // Try to import debugLogger if available (only in chat context)
        try {
          // Dynamic import to avoid circular dependency
          const debugLoggerPath = '../../cli/chat/utils/debugLogger.js';
          import(debugLoggerPath).then(module => {
            const level = prop as string;
            const message = args.map(arg => 
              typeof arg === 'object' && arg.msg ? arg.msg : 
              typeof arg === 'object' ? JSON.stringify(arg) : 
              String(arg)
            ).join(' ');
            
            // Only log non-fatal messages to debug panel
            if (module.debugLogger && ['debug', 'info', 'warn', 'error'].includes(level)) {
              module.debugLogger.addLog(level as any, message, 'pino');
            }
          }).catch(() => {
            // Ignore if debugLogger not available
          });
        } catch {
          // Ignore if not in chat context
        }
        
        // Call original method - cast to any to avoid type issues
        return (original as any).apply(target, args);
      };
    }
    
    return original;
  }
});

export default logger;
