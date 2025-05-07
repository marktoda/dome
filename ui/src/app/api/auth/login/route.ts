import { NextRequest, NextResponse } from 'next/server';
import { LoginSchema } from '@/lib/validators';

// Mock user data
const users = [{ id: '1', name: 'Test User', email: 'test@example.com', password: 'password123' }];

export async function POST(req: NextRequest) {
  try {
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

    // In a real app, you'd generate a token here
    const { ...userWithoutPassword } = user; // Removed _password
    return NextResponse.json({ user: userWithoutPassword, message: 'Login successful' });
  } catch (error) {
    console.error('Login API error:', error);
    return NextResponse.json({ message: 'Internal server error' }, { status: 500 });
  }
}
