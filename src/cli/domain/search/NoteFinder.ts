import { NoteSearchService } from '../../../core/services/NoteSearchService.js';
import { NoteService } from '../../../core/services/NoteService.js';
import { z } from 'zod';

const FindNoteSchema = z.object({
  path: z.string(),
  title: z.string(),
  reason: z.string().optional(),
  relevanceScore: z.number().min(0).max(1),
});

export type FindNoteResult = z.infer<typeof FindNoteSchema>;

/**
 * NoteFinder provides fast local vector search to locate existing notes.
 */
export class NoteFinder {
  async vectorFindNotes(query: string, limit = 10): Promise<FindNoteResult[]> {
    const noteService = new NoteService();
    const noteSearchService = new NoteSearchService(noteService);
    const results = await noteSearchService.searchNotes(query, limit * 2);

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
}

