'use client';

import React, { useState, FormEvent } from 'react';
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
  const { addMessage, isLoading } = useChat();

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
      await addMessage(inputValue.trim());
      setInputValue('');
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="sticky bottom-0 flex w-full items-center gap-2 border-t bg-background p-3 md:p-4 shadow-t-md" // Changed space-x to gap, adjusted padding, added top shadow
    >
      <Input
        type="text"
        placeholder="Send a message..." // Changed placeholder text
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        disabled={isLoading}
        className="flex-1 rounded-full px-4 py-2 focus-visible:ring-1 focus-visible:ring-ring" // Rounded input, adjusted padding, added focus style
        aria-label="Chat message input"
      />
      <Button type="submit" size="icon" disabled={isLoading || !inputValue.trim()} className="rounded-full h-9 w-9 hover:bg-primary/90 transition-colors" aria-label="Send message"> {/* Rounded button, adjusted size, hover effect */}
        <Send className="h-4 w-4" />
      </Button>
    </form>
  );
};