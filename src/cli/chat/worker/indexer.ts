import { parentPort, workerData } from 'worker_threads';
import { listNotes } from '../../../mastra/core/notes.js';

interface IndexerMessage {
  type: 'progress' | 'complete' | 'error';
  progress?: number;
  error?: string;
  noteCount?: number;
  indexedCount?: number;
}

async function runIndexing() {
  if (!parentPort) {
    throw new Error('This file must be run as a worker thread');
  }

  const { vaultPath } = workerData;

  try {
    // Send initial progress
    parentPort.postMessage({
      type: 'progress',
      progress: 0,
    } as IndexerMessage);

    // List all notes
    const notes = await listNotes();
    const totalNotes = notes.length;

    if (totalNotes === 0) {
      parentPort.postMessage({
        type: 'complete',
        progress: 100,
        noteCount: 0,
        indexedCount: 0,
      } as IndexerMessage);
      return;
    }

    // Index notes in batches
    const batchSize = 10;
    let indexedCount = 0;

    for (let i = 0; i < totalNotes; i += batchSize) {
      const batch = notes.slice(i, Math.min(i + batchSize, totalNotes));
      
      // Simulate indexing work - in production this would generate embeddings
      // For now, just add a small delay to simulate processing
      await new Promise(resolve => setTimeout(resolve, 50 * batch.length));

      indexedCount += batch.length;
      const progress = Math.floor((indexedCount / totalNotes) * 100);

      // Send progress update
      parentPort.postMessage({
        type: 'progress',
        progress,
        noteCount: totalNotes,
        indexedCount,
      } as IndexerMessage);

      // Small delay to prevent overwhelming the main thread
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Send completion message
    parentPort.postMessage({
      type: 'complete',
      progress: 100,
      noteCount: totalNotes,
      indexedCount: totalNotes,
    } as IndexerMessage);

  } catch (error) {
    parentPort.postMessage({
      type: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
    } as IndexerMessage);
  }
}

// Start indexing when worker is created
runIndexing().catch(console.error);