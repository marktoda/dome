import { describe, it, expect } from 'vitest';
import { z, ZodError } from 'zod';
import { formatZodError } from '../../src/utils/zodUtils';

describe('Zod Utilities', () => {

  describe('formatZodError', () => {
    it('should format ZodError into structured format', () => {
      const schema = z.object({
        name: z.string().min(3, 'Name must be at least 3 characters'),
        email: z.string().email('Invalid email format'),
        age: z.number().min(18, 'Must be at least 18 years old'),
      });

      try {
        schema.parse({
          name: 'Jo',
          email: 'not-an-email',
          age: 16,
        });
        // Should not reach here
        expect(true).toBe(false);
      } catch (error) {
        const formatted = formatZodError(error as ZodError);
        
        expect(formatted).toHaveProperty('issues');
        expect(Array.isArray(formatted.issues)).toBe(true);
        expect(formatted.issues.length).toBe(3);
        
        // Check for name error
        expect(formatted.issues).toContainEqual(
          expect.objectContaining({
            path: expect.stringContaining('name'),
            message: expect.stringContaining('3 characters'),
          })
        );
        
        // Check for email error
        expect(formatted.issues).toContainEqual(
          expect.objectContaining({
            path: expect.stringContaining('email'),
            message: expect.stringContaining('Invalid email'),
          })
        );
        
        // Check for age error
        expect(formatted.issues).toContainEqual(
          expect.objectContaining({
            path: expect.stringContaining('age'),
            message: expect.stringContaining('18 years'),
          })
        );
      }
    });

    it('should handle nested object errors', () => {
      const schema = z.object({
        user: z.object({
          profile: z.object({
            name: z.string().min(3, 'Name must be at least 3 characters'),
          }),
        }),
      });

      try {
        schema.parse({
          user: {
            profile: {
              name: 'Jo',
            },
          },
        });
        // Should not reach here
        expect(true).toBe(false);
      } catch (error) {
        const formatted = formatZodError(error as ZodError);
        
        expect(formatted.issues.length).toBe(1);
        expect(formatted.issues[0].path).toBe('user.profile.name');
        expect(formatted.issues[0].message).toContain('3 characters');
      }
    });

    it('should handle array errors', () => {
      const schema = z.object({
        items: z.array(z.string().min(3, 'Item must be at least 3 characters')),
      });

      try {
        schema.parse({
          items: ['ok', 'a', 'valid'],
        });
        // Should not reach here
        expect(true).toBe(false);
      } catch (error) {
        const formatted = formatZodError(error as ZodError);
        
        expect(formatted.issues.length).toBe(1);
        expect(formatted.issues[0].path).toBe('items.1');
        expect(formatted.issues[0].message).toContain('3 characters');
      }
    });

    it('should handle non-ZodError gracefully', () => {
      // This is just for testing - in real code we should only pass ZodError
      // but we want to ensure it doesn't crash if something else is passed
      const mockZodError = {
        errors: [{ path: ['test'], message: 'Test error', code: 'custom' }]
      } as unknown as ZodError;
      
      const formatted = formatZodError(mockZodError);
      
      expect(formatted).toHaveProperty('issues');
      expect(formatted.issues.length).toBe(1);
    });
  });
});