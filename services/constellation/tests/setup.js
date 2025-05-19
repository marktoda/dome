import { webcrypto as crypto } from 'node:crypto';

// Provide a global crypto polyfill for Node versions where it is absent
// (e.g. Node 16). Vitest uses the Node environment for these tests, so
// assigning to globalThis ensures APIs like crypto.randomUUID are available.
if (!globalThis.crypto) {
  globalThis.crypto = crypto;
}
