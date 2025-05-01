import { NextRequest, NextResponse } from 'next/server';
import { authClient } from '../../../lib/authClient';

// Configure route to use Edge Runtime for Cloudflare Pages compatibility
export const runtime = 'experimental-edge';

// Simple login endpoint that works in Edge Runtime
export async function POST(req: NextRequest) {
  try {
    const { email, password } = await req.json();
    
    if (!email || !password) {
      return NextResponse.json(
        { success: false, message: 'Email and password are required' },
        { status: 400 }
      );
    }
    
    const result = await authClient.login(email, password);
    
    // Set a cookie with the token
    const response = NextResponse.json({ 
      success: true, 
      user: {
        id: result.user.id,
        name: result.user.name,
        email: result.user.email,
        role: result.user.role,
      }
    });
    
    // Set an HTTP-only cookie with the token
    response.cookies.set({
      name: 'auth-token',
      value: result.token,
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 60 * 60 * 24 * 30, // 30 days
      path: '/',
    });
    
    return response;
  } catch (error) {
    console.error('Login error:', error);
    return NextResponse.json(
      { success: false, message: 'Authentication failed' },
      { status: 401 }
    );
  }
}