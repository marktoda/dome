import { NextRequest, NextResponse } from 'next/server';
import { RegisterSchema } from '@/lib/validators';

// !!! SECURITY WARNING: Mock user data and plain password storage !!!
// !!! This is for demonstration ONLY. Replace with secure database storage and password hashing (e.g., bcrypt) in production. !!!
const users = [
  { id: '1', name: 'Test User', email: 'test@example.com', password: 'password123' },
];

/**
 * Handles POST requests to `/api/auth/register`.
 * Validates registration data, checks for existing users (using mock data),
 * and adds the new user to the mock data store.
 *
 * @param req - The NextRequest object containing the request details.
 * @returns A NextResponse object with:
 *   - 201 Created: User data (excluding password) and success message on successful registration.
 *   - 400 Bad Request: Validation errors if request body is invalid.
 *   - 409 Conflict: If a user with the provided email already exists (based on mock data).
 *   - 500 Internal Server Error: If an unexpected server error occurs.
 *
 * @security **Critical Warning:** This implementation uses a mock in-memory array for users
 *           and stores passwords in plain text. It is **highly insecure** and **must not**
 *           be used in production. Replace mock data with a database and implement
 *           password hashing (e.g., bcrypt) before storing user credentials.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const validation = RegisterSchema.safeParse(body);

    if (!validation.success) {
      console.log('Registration validation failed:', validation.error.flatten());
      return NextResponse.json({ message: "Invalid request body.", errors: validation.error.flatten().fieldErrors }, { status: 400 });
    }

    const { name, email, password } = validation.data;

    // --- !!! INSECURE MOCK USER CHECK START !!! ---
    const existingUser = users.find(u => u.email === email);
    if (existingUser) {
      console.log(`Registration attempt failed: Email already exists - ${email}`);
      return NextResponse.json({ message: 'User with this email already exists' }, { status: 409 }); // 409 Conflict
    }
    // --- !!! INSECURE MOCK USER CHECK END !!! ---

    // --- !!! INSECURE MOCK USER CREATION START !!! ---
    const newUser = {
      id: String(users.length + 1), // Very basic ID generation
      name,
      email,
      password, // !!! Storing plain text password - DO NOT DO THIS IN PRODUCTION !!!
    };

    users.push(newUser); // Add to mock array
    console.log(`New user registered: ${email} (ID: ${newUser.id})`);
    // --- !!! INSECURE MOCK USER CREATION END !!! ---

    // In a real application, you might:
    // 1. Hash the password securely (bcrypt.hash) before saving.
    // 2. Save the user to a database.
    // 3. Optionally, automatically log the user in by generating a JWT and setting a cookie (like in the login route).
    // 4. Or, send a verification email.

    // Return the newly created user data (excluding the password)
    const { password: _removedPassword, ...userWithoutPassword } = newUser;
    return NextResponse.json(
      { user: userWithoutPassword, message: 'Registration successful' },
      { status: 201 }, // 201 Created
    );

  } catch (error) {
    console.error('Register API route error:', error);
    return NextResponse.json({ message: 'An unexpected internal server error occurred.' }, { status: 500 });
  }
}
