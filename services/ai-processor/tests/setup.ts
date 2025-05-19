import { webcrypto } from 'node:crypto';

if (typeof globalThis.crypto === 'undefined') {
  // Vitest running under older Node versions may not expose `crypto` globally.
  // Provide a minimal polyfill so code relying on `crypto` works in tests.
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore - webcrypto is compatible with the Crypto interface expected
  globalThis.crypto = webcrypto as unknown as Crypto;
}
