import * as z from 'zod';

/**
 * Zod schema for validating login form data.
 * Requires a valid email and a non-empty password.
 */
export const LoginSchema = z.object({
  /** User's email address. Must be a valid email format. */
  email: z.string().email({ message: 'Invalid email address' }),
  /** User's password. Must not be empty. */
  password: z.string().min(1, { message: 'Password is required' }),
});

/**
 * TypeScript type inferred from the {@link LoginSchema}.
 * Represents the structure of validated login form data.
 */
export type LoginFormData = z.infer<typeof LoginSchema>;

/**
 * Zod schema for validating registration form data.
 * Requires a non-empty name, a valid email, a password of at least 8 characters,
 * and matching password confirmation.
 */
export const RegisterSchema = z
  .object({
    /** User's full name or display name. Must not be empty. */
    name: z.string().min(1, { message: 'Name is required' }),
    /** User's email address. Must be a valid email format. */
    email: z.string().email({ message: 'Invalid email address' }),
    /** User's chosen password. Must be at least 8 characters long. */
    password: z.string().min(8, { message: 'Password must be at least 8 characters long' }),
    /** Confirmation of the user's password. */
    confirmPassword: z.string(),
  })
  // Custom refinement to ensure password and confirmPassword fields match.
  .refine(data => data.password === data.confirmPassword, {
    message: "Passwords don't match",
    path: ['confirmPassword'], // Associates the error message with the confirmPassword field.
  });

/**
 * TypeScript type inferred from the {@link RegisterSchema}.
 * Represents the structure of validated registration form data.
 */
export type RegisterFormData = z.infer<typeof RegisterSchema>;
