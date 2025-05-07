import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const userMessage = body.message;

    if (!userMessage || typeof userMessage !== 'string') {
      return NextResponse.json(
        { error: 'Message is required and must be a string' },
        { status: 400 },
      );
    }

    // Simulate a delay and a mock assistant response
    await new Promise(resolve => setTimeout(resolve, 1000));

    const mockReplies = [
      "That's an interesting point!",
      "I'm not sure I understand, could you elaborate?",
      'Let me think about that for a moment...',
      'Thanks for sharing your thoughts.',
      'Okay, I see what you mean.',
      'Fascinating! Tell me more.',
    ];

    const randomReply = mockReplies[Math.floor(Math.random() * mockReplies.length)];

    return NextResponse.json({ reply: randomReply });
  } catch (error) {
    console.error('Error in chat API:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
