import { NextRequest, NextResponse } from 'next/server';
import { RegisterSchema } from '@/lib/validators';

// Mock user data - in a real app, this would be a database
const users = [ // Changed let to const
  { id: '1', name: 'Test User', email: 'test@example.com', password: 'password123' },
];

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const validation = RegisterSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json({ errors: validation.error.flatten().fieldErrors }, { status: 400 });
    }

    const { name, email, password } = validation.data;

    const existingUser = users.find((u) => u.email === email);
    if (existingUser) {
      return NextResponse.json({ message: 'User with this email already exists' }, { status: 409 });
    }

    const newUser = {
      id: String(users.length + 1), // simple id generation
      name,
      email,
      password, // In a real app, hash the password
    };

    users.push(newUser);

    // In a real app, you might auto-login or send a verification email
    const { password: _password, ...userWithoutPassword } = newUser; // Renamed _ to _password
    return NextResponse.json({ user: userWithoutPassword, message: 'Registration successful' }, { status: 201 });

  } catch (error) {
    console.error('Register API error:', error);
    return NextResponse.json({ message: 'Internal server error' }, { status: 500 });
  }
}