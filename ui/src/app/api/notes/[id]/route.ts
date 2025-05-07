import { NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/notes/[id]
 * Proxies a note‑fetch request to the Dome API, preserving the caller's
 * Authorization header (if any).
 */

const DOME_API_URL = process.env.DOME_API_URL ?? 'http://localhost:8787';

export async function GET(
  request: NextRequest,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
) {
  const id = context.params.id;

  if (!id) {
    return NextResponse.json({ error: 'Note ID is required' }, { status: 400 });
  }

  try {
    const domeRes = await fetch(`${DOME_API_URL}/notes/${encodeURIComponent(id)}`, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: request.headers.get('Authorization') ?? '',
      },
      // Include cookies / credentials if your backend expects them
      // credentials: 'include',
    });

    // Stream the backend response through unchanged
    const body = await domeRes.text();
    return new NextResponse(body, {
      status: domeRes.status,
      headers: {
        'Content-Type': domeRes.headers.get('content-type') ?? 'application/json',
      },
    });
  } catch (err) {
    console.error('[GET /api/notes/[id]]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
