'use client';

import React, { useState, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useChat } from '@/contexts/ChatContext';

/**
 * ChatInput component provides a minimalist text entry area.
 * Messages are sent on Enter and a blinking block cursor is shown.
 */
export const ChatInput: React.FC = () => {
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef<HTMLDivElement>(null);
  const { addMessage, isLoading, error } = useChat();
 
  /**
   * Sends the current input value to the chat context and clears the field.
   */
  const send = async () => {
    if (inputValue.trim() && !isLoading) {
      try {
        await addMessage(inputValue.trim());
        setInputValue('');
        if (inputRef.current) {
          inputRef.current.innerText = '';
        }
        toast.success('Message sent!');
      } catch (e) {
        console.error('Failed to send message directly:', e);
        toast.error('Failed to send message. Please try again.');
      }
    }
  };

  useEffect(() => {
    if (error) {
      const authErrorCodes = ['AUTH_REQUIRED', 'AUTH_REQUIRED_SEND', 'WS_AUTH_FAILED'];
      if (!authErrorCodes.includes(error.error.code || '')) {
        toast.error(error.text || error.error.message || 'An unknown error occurred.');
      }
    }
  }, [error]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="sticky bottom-0 border-t bg-background p-3">
      <div
        ref={inputRef}
        contentEditable
        role="textbox"
        onInput={(e) => setInputValue(e.currentTarget.textContent || '')}
        onKeyDown={handleKeyDown}
        className="minimal-input w-full"
        aria-label="Chat message input"
      />
      {error &&
        (error.error.code === 'AUTH_REQUIRED' ||
          error.error.code === 'AUTH_REQUIRED_SEND' ||
          error.error.code === 'WS_AUTH_FAILED') && (
          <div className="pt-2 text-center text-xs text-destructive">
            {error.text} Please{' '}
            <a href="/login" className="underline hover:text-destructive/80">
              log in
            </a>{' '}
            to continue.
          </div>
        )}
    </div>
  );
};