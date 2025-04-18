import pino from 'pino';

/**
 * Global base logger – heavy Pino internals are initialised once per isolate.
 */
export const baseLogger = pino({
  level: (globalThis as any).LOG_LEVEL ?? 'info',
  // browser: {
  //   asObject: true,
  //   write: (obj: any) => console.log(obj), // Workers picks this up for Logpush
  // },
  browser: {
    asObject: true,
    write: o => console.log(JSON.stringify(o)),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type BaseLogger = typeof baseLogger;
