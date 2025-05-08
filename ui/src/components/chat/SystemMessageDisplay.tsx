import React from 'react';
import { SystemMessage } from '@/lib/chat-types';

/**
 * Props for the {@link SystemMessageDisplay} component.
 */
interface SystemMessageDisplayProps {
  /** The system message object to display. */
  message: SystemMessage & { type: 'system_generic' }; // Ensure it's a generic system message
}

/**
 * Displays a generic system message in the chat.
 * These messages are typically informational and styled differently from user or assistant messages.
 *
 * @param props - The props for the component.
 * @param props.message - The system message to render.
 * @returns A React element representing the system message.
 */
export const SystemMessageDisplay: React.FC<SystemMessageDisplayProps> = ({ message }) => {
  if (message.type !== 'system_generic') {
    // This component should only render 'system_generic' types.
    // Errors of type 'system' are handled by AssistantMessage.
    console.warn('SystemMessageDisplay received non-generic system message:', message);
    return null;
  }

  return (
    <div className="my-2 py-2 px-3 text-center text-xs italic text-muted-foreground">
      <p>{message.text}</p>
    </div>
  );
};