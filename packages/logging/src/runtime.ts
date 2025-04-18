import { AsyncLocalStorage } from 'node:async_hooks'
import pino, { Logger } from 'pino'

export const als = new AsyncLocalStorage<Map<string, unknown>>()

// Export the base logger type for backward compatibility
export type BaseLogger = Logger

export const baseLogger: Logger = pino({
  level: 'info',
  browser: { serialize: true },          // console‑friendly JSON for Workers Logs
  timestamp: pino.stdTimeFunctions.isoTime,
  hooks: {
    // bubble error.stack to top level – Cloudflare Logs shows it nicely
    logMethod(args: any[], method: any) {
      if (args.length && args[0] instanceof Error) {
        const err = args[0] as Error
        args[0] = { err } as any         // `{ err:{ message, stack… } }`
      }
      method.apply(this, args as any)
    }
  }
})
