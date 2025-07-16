import { useEffect, useRef, useCallback } from 'react';
import { useAppState } from '../state/AppContext.js';

interface UseStreamOptions {
  messageId: string;
  onComplete?: () => void;
  fps?: number; // Characters per second for smooth streaming
}

export function useStream({ messageId, onComplete, fps = 30 }: UseStreamOptions) {
  const { dispatch } = useAppState();
  const queueRef = useRef<string[]>([]);
  const intervalRef = useRef<NodeJS.Timeout | undefined>(undefined);
  const isStreamingRef = useRef(false);

  const addToQueue = useCallback((text: string) => {
    // Split text into individual characters for smooth streaming
    const chars = text.split('');
    queueRef.current.push(...chars);

    if (!isStreamingRef.current) {
      startStreaming();
    }
  }, []);

  const startStreaming = useCallback(() => {
    if (isStreamingRef.current || queueRef.current.length === 0) return;

    isStreamingRef.current = true;
    dispatch({ type: 'SET_STREAMING', payload: true });

    const msPerChar = 1000 / fps;

    intervalRef.current = setInterval(() => {
      if (queueRef.current.length === 0) {
        stopStreaming();
        return;
      }

      const char = queueRef.current.shift()!;
      dispatch({
        type: 'APPEND_TO_MESSAGE',
        payload: { id: messageId, content: char },
      });
    }, msPerChar);
  }, [dispatch, fps, messageId]);

  const stopStreaming = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = undefined;
    }

    isStreamingRef.current = false;
    dispatch({ type: 'SET_STREAMING', payload: false });
    dispatch({ type: 'FINISH_STREAMING', payload: { id: messageId } });

    if (onComplete) {
      onComplete();
    }
  }, [dispatch, messageId, onComplete]);

  const forceFlush = useCallback(() => {
    // Immediately append all remaining characters
    if (queueRef.current.length > 0) {
      const remaining = queueRef.current.join('');
      queueRef.current = [];
      dispatch({
        type: 'APPEND_TO_MESSAGE',
        payload: { id: messageId, content: remaining },
      });
    }
    stopStreaming();
  }, [dispatch, messageId, stopStreaming]);

  useEffect(() => {
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, []);

  return {
    addToQueue,
    forceFlush,
    isStreaming: isStreamingRef.current,
  };
}
