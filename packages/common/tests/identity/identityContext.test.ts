import {
  Identity,
  identityContext,
  getIdentityContext,
  setIdentityContext,
  withIdentityContext,
  encodeIdentityAsBaggage,
  decodeIdentityFromBaggage,
  MissingIdentityContextError,
} from '../../src/identity';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('Identity Context Module', () => {
  // Make sure tests are isolated
  // No need for explicit setup/teardown as AsyncLocalStorage automatically
  // isolates contexts between tests
  beforeEach(() => {
    // Each test will run in its own context
  });

  afterEach(() => {
    // Context is automatically cleared between tests
  });

  describe('getIdentityContext', () => {
    it('should throw MissingIdentityContextError when no identity is set', () => {
      expect(() => getIdentityContext()).toThrow(MissingIdentityContextError);
    });

    it('should return the current identity when set', () => {
      const identity: Identity = { uid: 'user-123' };

      setIdentityContext(identity, () => {
        const result = getIdentityContext();
        expect(result).toEqual(identity);
      });
    });
  });

  describe('setIdentityContext', () => {
    it('should set the identity context for synchronous operations', () => {
      const identity: Identity = { uid: 'user-123', org: 'org-456' };
      let result: Identity | undefined;

      setIdentityContext(identity, () => {
        result = identityContext.getStore();
      });

      expect(result).toEqual(identity);
    });

    it('should set the identity context for asynchronous operations', async () => {
      const identity: Identity = { uid: 'user-123' };
      let result: Identity | undefined;

      await setIdentityContext(identity, async () => {
        // Simulate async operation
        await Promise.resolve();
        result = identityContext.getStore();
      });

      expect(result).toEqual(identity);
    });
  });

  describe('withIdentityContext', () => {
    it('should run a function with the provided identity context', async () => {
      const identity: Identity = { uid: 'user-123', org: 'org-456' };
      let contextInFn: Identity | undefined;

      await withIdentityContext(identity, async () => {
        contextInFn = identityContext.getStore();
      });

      expect(contextInFn).toEqual(identity);
    });

    it('should return the result of the function', async () => {
      const identity: Identity = { uid: 'user-123' };
      const expected = { success: true };

      const result = await withIdentityContext(identity, async () => {
        return expected;
      });

      expect(result).toEqual(expected);
    });
  });

  describe('encodeIdentityAsBaggage', () => {
    it('should encode identity with only uid', () => {
      const identity: Identity = { uid: 'user-123' };
      const baggage = encodeIdentityAsBaggage(identity);

      expect(baggage).toBe('uid=user-123');
    });

    it('should encode identity with uid and org', () => {
      const identity: Identity = { uid: 'user-123', org: 'org-456' };
      const baggage = encodeIdentityAsBaggage(identity);

      expect(baggage).toBe('uid=user-123,org=org-456');
    });

    it('should properly encode special characters', () => {
      const identity: Identity = { uid: 'user@example.com', org: 'acme inc.' };
      const baggage = encodeIdentityAsBaggage(identity);

      expect(baggage).toBe('uid=user%40example.com,org=acme%20inc.');
    });
  });

  describe('decodeIdentityFromBaggage', () => {
    it('should decode valid baggage string with uid only', () => {
      const baggage = 'uid=user-123';
      const identity = decodeIdentityFromBaggage(baggage);

      expect(identity).toEqual({ uid: 'user-123' });
    });

    it('should decode valid baggage string with uid and org', () => {
      const baggage = 'uid=user-123,org=org-456';
      const identity = decodeIdentityFromBaggage(baggage);

      expect(identity).toEqual({ uid: 'user-123', org: 'org-456' });
    });

    it('should properly decode special characters', () => {
      const baggage = 'uid=user%40example.com,org=acme%20inc.';
      const identity = decodeIdentityFromBaggage(baggage);

      expect(identity).toEqual({ uid: 'user@example.com', org: 'acme inc.' });
    });

    it('should return undefined for empty baggage', () => {
      const identity = decodeIdentityFromBaggage('');

      expect(identity).toBeUndefined();
    });

    it('should return undefined if uid is missing', () => {
      const baggage = 'org=org-456';
      const identity = decodeIdentityFromBaggage(baggage);

      expect(identity).toBeUndefined();
    });

    it('should ignore invalid pairs', () => {
      const baggage = 'uid=user-123,invalid,org=org-456';
      const identity = decodeIdentityFromBaggage(baggage);

      expect(identity).toEqual({ uid: 'user-123', org: 'org-456' });
    });
  });
});
