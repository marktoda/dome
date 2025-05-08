import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import * as jose from 'jose';

const JWT_SECRET = process.env.JWT_SECRET;

export async function GET(request: Request) {
  if (!JWT_SECRET) {
    console.error('JWT_SECRET is not defined in environment variables for /api/auth/me.');
    return NextResponse.json({ message: 'Server configuration error.' }, { status: 500 });
  }

  const cookieStore = await cookies(); // Assuming cookies() is Promise-like based on previous fixes
  const tokenCookie = cookieStore.get('auth_token');

  if (!tokenCookie?.value) {
    return NextResponse.json({ message: 'Not authenticated: No token found.' }, { status: 401 });
  }

  try {
    const secret = new TextEncoder().encode(JWT_SECRET);
    const { payload } = await jose.jwtVerify(tokenCookie.value, secret);

    // Payload contains the claims we put in during login (userId, email, name)
    // Ensure the payload structure matches what you expect, e.g., payload.sub for userId if standard claims are used.
    // For this example, assuming direct properties like payload.userId based on SignJWT input.
    return NextResponse.json({ 
      user: { 
        id: payload.userId, 
        email: payload.email, 
        name: payload.name 
      } 
    });
  } catch (error) {
    console.error('JWT verification failed:', error);
    // Clear the invalid cookie
    const response = NextResponse.json({ message: 'Not authenticated: Invalid token.' }, { status: 401 });
    // Use the ResponseCookies API to delete a cookie
    response.cookies.set({
      name: 'auth_token',
      value: '',
      httpOnly: true,
      path: '/',
      maxAge: 0,
    });
    return response;
  }
}