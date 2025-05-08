import { NextRequest, NextResponse } from 'next/server';
import { LoginSchema } from '@/lib/validators';
import * as jose from 'jose';
import { cookies } from 'next/headers';

// !!! SECURITY WARNING: Mock user data and plain password check !!!
// !!! This is for demonstration ONLY. Replace with secure database lookup and password hashing (e.g., bcrypt) in production. !!!
const users = [{ id: '1', name: 'Test User', email: 'test@example.com', password: 'password123' }];

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * Handles POST requests to `/api/auth/login`.
 * Validates user credentials against mock data, generates a JWT, and sets it in an HttpOnly cookie.
 *
 * @param req - The NextRequest object containing the request details.
 * @returns A NextResponse object with:
 *   - 200 OK: User data (excluding password) and success message on successful login.
 *   - 400 Bad Request: Validation errors if request body is invalid.
 *   - 401 Unauthorized: If email/password combination is incorrect (based on mock data).
 *   - 500 Internal Server Error: If JWT_SECRET is missing or other server errors occur.
 *
 * @security **Critical Warning:** This implementation uses mock user data and compares passwords in plain text.
 *           It is **highly insecure** and **must not** be used in production.
 *           Replace mock data with database lookups and implement password hashing (e.g., bcrypt)
 *           for secure password verification.
 */
export async function POST(req: NextRequest) {
  try {
    if (!JWT_SECRET) {
      console.error('CRITICAL: JWT_SECRET is not defined in environment variables.');
      return NextResponse.json({ message: 'Server configuration error: JWT secret missing.' }, { status: 500 });
    }

    const body = await req.json();
    const validation = LoginSchema.safeParse(body);

    if (!validation.success) {
      console.log('Login validation failed:', validation.error.flatten());
      return NextResponse.json({ message: "Invalid request body.", errors: validation.error.flatten().fieldErrors }, { status: 400 });
    }

    const { email, password } = validation.data;

    // --- !!! INSECURE MOCK AUTHENTICATION START !!! ---
    const user = users.find(u => u.email === email);

    // !!! NEVER compare plain text passwords in production !!!
    if (!user || user.password !== password) {
      console.log(`Login attempt failed for email: ${email}`);
      return NextResponse.json({ message: 'Invalid email or password' }, { status: 401 });
    }
    // --- !!! INSECURE MOCK AUTHENTICATION END !!! ---

    console.log(`Login successful for user: ${user.email}`);

    // Create JWT containing user claims
    const secret = new TextEncoder().encode(JWT_SECRET);
    const alg = 'HS256';
    const jwt = await new jose.SignJWT({ userId: user.id, email: user.email, name: user.name })
      .setProtectedHeader({ alg })
      .setIssuedAt()
      .setExpirationTime('2h') // Token valid for 2 hours
      .sign(secret);

    // Set JWT in an HttpOnly cookie for security
    const cookieStore = cookies();
    cookieStore.set('auth_token', jwt, {
      httpOnly: true, // Prevents client-side script access
      secure: process.env.NODE_ENV === 'production', // Only send over HTTPS in production
      sameSite: 'lax', // Mitigates CSRF attacks
      path: '/', // Cookie accessible for all paths
      maxAge: 2 * 60 * 60, // Cookie expiry in seconds (matches JWT expiration)
    });

    // Return user data (excluding password) in the response body
    const { password: _password, ...userWithoutPassword } = user;
    return NextResponse.json({ user: userWithoutPassword, message: 'Login successful' });

  } catch (error) {
    console.error('Login API route error:', error);
    return NextResponse.json({ message: 'An unexpected internal server error occurred.' }, { status: 500 });
  }
}
