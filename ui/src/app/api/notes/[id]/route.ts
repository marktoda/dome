import { NextRequest, NextResponse } from 'next/server';

type Params = Promise<{ id: string }>;   // <- note Promise

export async function GET(
  req: NextRequest,
  { params }: { params: Params }        // <- must match the new async shape
) {
  const { id } = await params;          // await is required now

  const backendUrl =
    `${process.env.DOME_API_URL ?? 'http://localhost:8787'}/notes/${encodeURIComponent(id)}`;

  const domeRes = await fetch(backendUrl, {
    headers: { Authorization: req.headers.get('Authorization') ?? '' },
  });

  return new NextResponse(await domeRes.text(), {
    status: domeRes.status,
    statusText: domeRes.statusText,
    headers: { 'Content-Type': domeRes.headers.get('content-type') ?? 'application/json' },
  });
}
