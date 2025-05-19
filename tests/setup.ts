import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) {
  (globalThis as any).crypto = webcrypto as any;
}
