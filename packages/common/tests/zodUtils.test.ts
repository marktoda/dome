import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { formatZodError } from '../src/utils/zodUtils';

describe('formatZodError', () => {
  it('formats errors into readable issues', () => {
    const schema = z.object({ name: z.string() });
    const result = schema.safeParse({ name: 123 });
    if (result.success) throw new Error('Expected failure');

    const formatted = formatZodError(result.error);
    expect(formatted.issues[0]).toMatchObject({
      path: 'name',
    });
  });
});
