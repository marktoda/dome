import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

export async function POST(request: Request) {
  try {
    const cookieStore = await cookies(); // Assuming cookies() is Promise-like
    const tokenCookie = cookieStore.get('auth_token');

    if (tokenCookie) {
      // Clear the cookie by setting maxAge to 0 or an expiry date in the past
      // Use the ResponseCookies API for modification if directly modifying request cookies is not allowed/working
      // For Route Handlers, modifying cookies is typically done on the response.
      // However, cookies().set() is available for request cookies in some contexts or for setting on response.
      // Let's try setting it directly on the request's cookie store if allowed,
      // otherwise, we'd set it on the response.
      // The more standard way is to set it on the response.
      
      const response = NextResponse.json({ message: 'Logout successful' }, { status: 200 });
      response.cookies.set({
        name: 'auth_token',
        value: '',
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 0,
      });
      return response;
    }
    // If no cookie, still a successful logout from client's perspective
    return NextResponse.json({ message: 'Logout successful (no token found)' }, { status: 200 });
  } catch (error) {
    console.error('Logout API error:', error);
    return NextResponse.json({ message: 'Internal server error during logout' }, { status: 500 });
  }
}