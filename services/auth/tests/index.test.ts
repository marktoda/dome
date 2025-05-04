import { describe, it, expect } from 'vitest';
import { AuthError, AuthErrorType } from '../src/utils/errors';

describe('Auth Service Test Suite', () => {
  it('should be properly set up', () => {
    expect(true).toBe(true);
  });

  it('should properly create AuthError instances', () => {
    const error = new AuthError('Test error', AuthErrorType.INVALID_CREDENTIALS);

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AuthError);
    expect(error.message).toBe('Test error');
    expect(error.type).toBe(AuthErrorType.INVALID_CREDENTIALS);
    expect(error.status).toBe(401); // Default status

    const jsonError = error.toJSON();
    expect(jsonError).toEqual({
      error: {
        type: AuthErrorType.INVALID_CREDENTIALS,
        message: 'Test error',
      },
    });
  });
});
