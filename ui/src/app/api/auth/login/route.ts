import { NextRequest, NextResponse } from 'next/server';
import { LoginSchema } from '@/lib/validators';
import * as jose from 'jose';
import { cookies } from 'next/headers';

// Mock user data
const users = [{ id: '1', name: 'Test User', email: 'test@example.com', password: 'password123' }];
const JWT_SECRET = process.env.JWT_SECRET;

export async function POST(req: NextRequest) {
  try {
    if (!JWT_SECRET) {
      console.error('JWT_SECRET is not defined in environment variables.');
      return NextResponse.json({ message: 'Server configuration error.' }, { status: 500 });
    }

    const body = await req.json();
    const validation = LoginSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json({ errors: validation.error.flatten().fieldErrors }, { status: 400 });
    }

    const { email, password } = validation.data;

    const user = users.find(u => u.email === email);

    if (!user || user.password !== password) {
      return NextResponse.json({ message: 'Invalid email or password' }, { status: 401 });
    }

    // Create JWT
    const secret = new TextEncoder().encode(JWT_SECRET);
    const alg = 'HS256';
    const jwt = await new jose.SignJWT({ userId: user.id, email: user.email, name: user.name })
      .setProtectedHeader({ alg })
      .setIssuedAt()
      .setExpirationTime('2h') // Token valid for 2 hours
      .sign(secret);

    // Set JWT in an HttpOnly cookie
    const cookieStore = await cookies(); // Await if TS thinks it's a Promise
    cookieStore.set('auth_token', jwt, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production', // Use secure cookies in production
      sameSite: 'lax',
      path: '/',
      maxAge: 2 * 60 * 60, // 2 hours in seconds
    });
    
    const { password: _password, ...userWithoutPassword } = user;
    return NextResponse.json({ user: userWithoutPassword, message: 'Login successful' });
  } catch (error) {
    console.error('Login API error:', error);
    return NextResponse.json({ message: 'Internal server error' }, { status: 500 });
  }
}
