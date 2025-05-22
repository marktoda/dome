import { describe, it, expect } from 'vitest';
import { toDomeError, createServiceErrorHandler, InternalError, DomeError } from '../src/errors';

describe('toDomeError', () => {
  it('wraps generic Error into InternalError', () => {
    const err = new Error('boom');
    const dome = toDomeError(err);
    expect(dome).toBeInstanceOf(InternalError);
    expect(dome.message).toBe('boom');
  });

  it('passes through existing DomeError and merges details', () => {
    const initial = toDomeError('bad');
    const dome = toDomeError(initial, 'ignored', { extra: true });
    expect(dome).toBe(initial);
    expect(dome.details?.extra).toBe(true);
  });
});

describe('createServiceErrorHandler', () => {
  it('adds service context to converted errors', () => {
    const handler = createServiceErrorHandler('svc');
    const dome = handler(new Error('oops'));
    expect(dome).toBeInstanceOf(DomeError);
    expect(dome.details?.service).toBe('svc');
  });
});
