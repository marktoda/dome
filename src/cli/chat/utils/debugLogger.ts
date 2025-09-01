import { DebugLogEntry } from '../components/DebugLogPanel.js';

type LogListener = (log: DebugLogEntry) => void;

class DebugLogger {
  private listeners: Set<LogListener> = new Set();
  private logs: DebugLogEntry[] = [];
  private maxLogs = 1000; // Keep last 1000 logs in memory
  
  constructor() {
    // Intercept console methods in debug mode
    if (process.env.LOG_LEVEL === 'debug' || process.env.DEBUG === '1') {
      this.interceptConsole();
    }
  }
  
  private interceptConsole() {
    // Store original console methods
    const originalLog = console.log;
    const originalDebug = console.debug;
    const originalInfo = console.info;
    const originalWarn = console.warn;
    const originalError = console.error;
    
    // Override console methods to capture logs
    console.log = (...args: any[]) => {
      this.addLog('info', this.formatArgs(args), 'console.log');
      originalLog.apply(console, args);
    };
    
    console.debug = (...args: any[]) => {
      this.addLog('debug', this.formatArgs(args), 'console.debug');
      originalDebug.apply(console, args);
    };
    
    console.info = (...args: any[]) => {
      this.addLog('info', this.formatArgs(args), 'console.info');
      originalInfo.apply(console, args);
    };
    
    console.warn = (...args: any[]) => {
      this.addLog('warn', this.formatArgs(args), 'console.warn');
      originalWarn.apply(console, args);
    };
    
    console.error = (...args: any[]) => {
      this.addLog('error', this.formatArgs(args), 'console.error');
      originalError.apply(console, args);
    };
  }
  
  private formatArgs(args: any[]): string {
    return args.map(arg => {
      if (typeof arg === 'object') {
        try {
          return JSON.stringify(arg, null, 2);
        } catch {
          return String(arg);
        }
      }
      return String(arg);
    }).join(' ');
  }
  
  addLog(level: DebugLogEntry['level'], message: string, source?: string) {
    const log: DebugLogEntry = {
      timestamp: new Date(),
      level,
      message,
      source,
    };
    
    this.logs.push(log);
    
    // Trim logs if exceeding max
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs);
    }
    
    // Notify listeners
    this.listeners.forEach(listener => listener(log));
  }
  
  subscribe(listener: LogListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  
  getLogs(): DebugLogEntry[] {
    return [...this.logs];
  }
  
  clear() {
    this.logs = [];
  }
  
  // Helper methods for different log levels
  debug(message: string, source?: string) {
    this.addLog('debug', message, source);
  }
  
  info(message: string, source?: string) {
    this.addLog('info', message, source);
  }
  
  warn(message: string, source?: string) {
    this.addLog('warn', message, source);
  }
  
  error(message: string, source?: string) {
    this.addLog('error', message, source);
  }
}

// Singleton instance
export const debugLogger = new DebugLogger();

// Also intercept pino logger if available
export function interceptPinoLogger(logger: any) {
  if (!logger || typeof logger !== 'object') return;
  
  const levels = ['debug', 'info', 'warn', 'error'];
  
  levels.forEach(level => {
    const original = logger[level];
    if (typeof original === 'function') {
      logger[level] = function(...args: any[]) {
        // Capture the log
        const message = args.map(arg => {
          if (typeof arg === 'object' && arg.msg) {
            return arg.msg;
          }
          return typeof arg === 'object' ? JSON.stringify(arg) : String(arg);
        }).join(' ');
        
        debugLogger.addLog(level as any, message, 'pino');
        
        // Call original
        return original.apply(this, args);
      };
    }
  });
}