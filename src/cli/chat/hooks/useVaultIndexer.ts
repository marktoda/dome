import { useEffect, useRef } from 'react';
import { useAppState } from '../state/AppContext.js';
import { IndexWorker } from '../services/IndexWorker.js';

export function useVaultIndexer(vaultPath: string) {
  const { dispatch } = useAppState();
  const workerRef = useRef<IndexWorker | undefined>(undefined);
  
  useEffect(() => {
    const worker = new IndexWorker();
    workerRef.current = worker;
    
    // Set up event listeners
    worker.on('progress', ({ progress, noteCount, indexedCount }) => {
      dispatch({
        type: 'UPDATE_INDEXING_STATUS',
        payload: {
          progress,
          isIndexing: true,
          running: true,
        },
      });
    });
    
    worker.on('complete', ({ noteCount }) => {
      dispatch({
        type: 'UPDATE_INDEXING_STATUS',
        payload: {
          progress: 100,
          isIndexing: false,
          running: true,
          lastIndexTime: Date.now(),
        },
      });
      
      // Update note count
      dispatch({
        type: 'SET_NOTE_COUNT',
        payload: noteCount,
      });
    });
    
    worker.on('error', (error) => {
      dispatch({
        type: 'ADD_MESSAGE',
        payload: {
          type: 'error',
          content: `Indexing error: ${error.message}`,
        },
      });
      
      dispatch({
        type: 'UPDATE_INDEXING_STATUS',
        payload: {
          isIndexing: false,
          running: false,
        },
      });
    });
    
    worker.on('restarting', (attempt) => {
      dispatch({
        type: 'ADD_MESSAGE',
        payload: {
          type: 'system',
          content: `Restarting indexer (attempt ${attempt})...`,
        },
      });
    });
    
    // Start the worker
    worker.start(vaultPath).catch((error) => {
      dispatch({
        type: 'ADD_MESSAGE',
        payload: {
          type: 'error',
          content: `Failed to start indexer: ${error.message}`,
        },
      });
    });
    
    // Cleanup
    return () => {
      worker.stop().catch(() => {
        // Ignore errors during cleanup
      });
    };
  }, [vaultPath, dispatch]);
  
  return workerRef.current;
}