import { FileEvent, FileEventType } from './types.js';

/**
 * Coalesce two events for the same file into a single event, or null if the net effect is noop.
 * The "next" event wins except for special cases.
 */
export function coalesceFileEvents(prev: FileEvent, next: FileEvent): FileEvent | null {
  // Creation then rapid deletion → no work
  if (prev.type === FileEventType.Added && next.type === FileEventType.Deleted) {
    return null; // noop
  }

  // Any deletion at the end dominates
  if (next.type === FileEventType.Deleted) {
    return { ...next, type: FileEventType.Deleted };
  }

  // Resurrection (was deleted, then added/changed) → treat as Changed (fresh content)
  if (prev.type === FileEventType.Deleted && (next.type === FileEventType.Added || next.type === FileEventType.Changed)) {
    return { ...next, type: FileEventType.Changed };
  }

  // Added then Changed → treat as Changed (final content)
  if (prev.type === FileEventType.Added && next.type === FileEventType.Changed) {
    return { ...next, type: FileEventType.Changed };
  }

  // Default: next wins
  return next;
}