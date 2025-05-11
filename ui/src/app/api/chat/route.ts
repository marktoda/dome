import { NextRequest, NextResponse } from 'next/server'; // Use NextRequest

/**
 * Handles POST requests to `/api/chat`.
 *
 * @deprecated **This is a MOCK implementation.** It simulates a delay and returns a random canned response.
 *             It does **not** connect to a real AI or chat service. Replace this with actual backend logic,
 *             potentially involving WebSocket handling or calls to an AI service.
 *
 * @param req - The NextRequest object containing the request details. Expects a JSON body with a `message` property.
 * @returns A NextResponse object with:
 *   - 200 OK: A JSON object containing a mock `reply` string.
 *   - 400 Bad Request: If the `message` property is missing or not a string in the request body.
 *   - 500 Internal Server Error: If an unexpected error occurs.
 */
export async function POST(req: NextRequest) {
  // Changed type to NextRequest
  console.warn('⚠️ Using MOCK /api/chat endpoint! Replace with actual implementation. ⚠️');
  try {
    const body = await req.json();
    // Validate the incoming message structure more robustly if needed
    const userMessage = body?.message;

    if (!userMessage || typeof userMessage !== 'string') {
      return NextResponse.json(
        { error: 'Bad Request: Message is required and must be a string.' },
        { status: 400 },
      );
    }

    // --- MOCK LOGIC START ---
    // Simulate network delay/processing time
    await new Promise(resolve => setTimeout(resolve, 800)); // Simulate 800ms delay

    const mockReplies = [
      "That's an interesting perspective!",
      'Could you please elaborate on that?',
      'Processing... just kidding! This is a mock response.',
      'Thank you for your input.',
      'Understood.',
      'How fascinating!',
      `You said: "${userMessage}". Acknowledged.`,
    ];

    const randomReply = mockReplies[Math.floor(Math.random() * mockReplies.length)];
    // --- MOCK LOGIC END ---

    // Return the mock reply
    return NextResponse.json({ reply: randomReply });
  } catch (error) {
    console.error('Error in MOCK /api/chat:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
