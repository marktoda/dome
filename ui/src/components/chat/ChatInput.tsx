'use client';

import React, { useState, FormEvent, useEffect } from 'react'; // Added useEffect
import { toast } from 'sonner'; // Added toast import
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Send } from 'lucide-react';
import { useChat } from '@/contexts/ChatContext';

/**
 * ChatInput component provides a text input field and a send button for users to send messages.
 * It uses the `useChat` context to add new messages and manage loading states.
 * @returns A React functional component.
 */
export const ChatInput: React.FC = () => {
  const [inputValue, setInputValue] = useState('');
  const { addMessage, isLoading, error } = useChat(); // Add error state
 
  /**
   * Handles the form submission event.
   * Prevents the default form submission, trims the input value,
   * and calls `addMessage` if the input is not empty and not currently loading.
   * Clears the input field after the message is sent.
   * @param e - The form event.
   */
  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (inputValue.trim() && !isLoading) {
      try {
        await addMessage(inputValue.trim());
        setInputValue('');
        toast.success("Message sent!");
      } catch (e) {
        // Errors are typically handled by the ChatContext and reflected in the `error` state.
        // This catch is a fallback, but primary error toasting is via useEffect.
        console.error("Failed to send message directly:", e);
        toast.error("Failed to send message. Please try again.");
      }
    }
  };

  useEffect(() => {
    if (error) {
      const authErrorCodes = ['AUTH_REQUIRED', 'AUTH_REQUIRED_SEND', 'WS_AUTH_FAILED'];
      if (!authErrorCodes.includes(error.error.code || '')) {
        toast.error(error.text || error.error.message || "An unknown error occurred.");
      }
    }
  }, [error]);

  return (
    <div className="sticky bottom-0 border-t bg-background shadow-t-md">
      <form
        onSubmit={handleSubmit}
        className="flex w-full items-center gap-2 p-2 sm:p-3 md:p-4"
      >
        <Input
          type="text"
          placeholder="Send a message..."
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          disabled={isLoading || (!!error && (error.error.code === 'AUTH_REQUIRED' || error.error.code === 'AUTH_REQUIRED_SEND' || error.error.code === 'WS_AUTH_FAILED'))}
          className="flex-1 rounded-full px-4 py-2 focus-visible:ring-1 focus-visible:ring-ring"
          aria-label="Chat message input"
        />
        <Button
          type="submit"
          size="icon"
          disabled={isLoading || !inputValue.trim() || (!!error && (error.error.code === 'AUTH_REQUIRED' || error.error.code === 'AUTH_REQUIRED_SEND' || error.error.code === 'WS_AUTH_FAILED'))}
          className="rounded-full h-9 w-9 hover:bg-primary/90 transition-colors"
          aria-label="Send message"
        >
          <Send className="h-4 w-4" />
        </Button>
      </form>
      {error && (error.error.code === 'AUTH_REQUIRED' || error.error.code === 'AUTH_REQUIRED_SEND' || error.error.code === 'WS_AUTH_FAILED') && (
        <div className="px-3 pb-2 md:px-4 text-xs text-destructive text-center">
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