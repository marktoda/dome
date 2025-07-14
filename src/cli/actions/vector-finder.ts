import { searchNotesByText } from '../../mastra/core/search.js';

export interface VectorNoteResult {
  path: string;
  title: string;
  relevanceScore: number;
}

export async function vectorFindNotes(query: string, limit = 10): Promise<VectorNoteResult[]> {
  const results = await searchNotesByText(query, limit * 2);

  const byPath = new Map<string, { path: string; title: string; relevanceScore: number }>();

  for (const r of results) {
    const path = r.metadata?.notePath ?? r.id;
    const score = r.score;
    const title = r.metadata?.text ?? '';
    const existing = byPath.get(path);
    if (!existing || score > existing.relevanceScore) {
      byPath.set(path, { path, title, relevanceScore: score });
    }
  }

  return Array.from(byPath.values())
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, limit);
} 