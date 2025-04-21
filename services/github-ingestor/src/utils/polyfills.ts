/**
 * Polyfills for Cloudflare Workers environment
 * This file provides polyfills for APIs that might not be available in the Cloudflare Workers runtime
 */

// Ensure crypto is available on globalThis
if (!('crypto' in globalThis)) {
  Object.defineProperty(globalThis, 'crypto', {
    value: crypto,
    writable: false,
    configurable: false,
    enumerable: false,
  });
}

// Ensure TextEncoder is available on globalThis
if (!('TextEncoder' in globalThis)) {
  Object.defineProperty(globalThis, 'TextEncoder', {
    value: TextEncoder,
    writable: false,
    configurable: false,
    enumerable: false,
  });
}

// Ensure console is available on globalThis
if (!('console' in globalThis)) {
  Object.defineProperty(globalThis, 'console', {
    value: console,
    writable: false,
    configurable: false,
    enumerable: false,
  });
}

// Export a function to initialize polyfills
export function initPolyfills(): void {
  // This function is called to ensure the polyfills are initialized
  // The actual initialization happens when the module is imported
}
