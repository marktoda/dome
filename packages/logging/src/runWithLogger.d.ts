/**
 * Interface for Cloudflare Workers ExecutionContext
 */
interface CFExecutionContext {
    run<T>(callback: () => T): Promise<T>;
    waitUntil(promise: Promise<unknown>): void;
    passThroughOnException(): void;
}
/**
 * Runs a function with a logger attached to the execution context.
 *
 * @remarks
 * This function creates a child logger with the provided metadata and attaches it
 * to the execution context. If the context has a run method, it will use that to
 * ensure the logger is available throughout the execution. If there's no context
 * or if accessing the context fails, it will fall back to running the function directly.
 *
 * @param meta - Metadata to attach to the logger
 * @param fn - The function to run with the logger
 * @param ctx - Optional Cloudflare Workers execution context
 * @returns The result of the function execution
 */
export declare function runWithLogger<T>(meta: Record<string, unknown>, fn: () => Promise<T>, ctx?: CFExecutionContext): Promise<T>;
export {};
