import React from 'react';
import { Message } from '@/lib/chat-types';
import { ChatMessage } from './ChatMessage'; // Assuming ChatMessage can render a ReactNode
import { AlertTriangle, CheckCircle2 } from 'lucide-react';

interface AssistantMessageProps {
  message: Message;
}

interface ParsedAssistantContent {
  thinking?: string | object; // Can be string or further structured object
  answer?: string | object;   // Can be string or further structured object
  error?: string;
  // Add other potential top-level keys if necessary
}

const renderContent = (content: string | object): React.ReactNode => {
  if (typeof content === 'string') {
    return <p className="whitespace-pre-wrap">{content}</p>;
  }
  // If it's an object, stringify it for now, or implement more complex rendering
  return <pre className="whitespace-pre-wrap text-xs bg-gray-100 dark:bg-gray-800 p-2 rounded-md">{JSON.stringify(content, null, 2)}</pre>;
};

export const AssistantMessage: React.FC<AssistantMessageProps> = ({ message }) => {
  if (message.sender !== 'assistant') {
    return null;
  }

  let parsedContent: ParsedAssistantContent | null = null;
  let renderAsRaw = false;

  try {
    const parsed = JSON.parse(message.text);
    // Check if it has at least one of the expected keys
    if (typeof parsed === 'object' && parsed !== null && ('thinking' in parsed || 'answer' in parsed || 'error' in parsed)) {
      parsedContent = parsed;
    } else {
      renderAsRaw = true; // Not the structure we are looking for, render raw
    }
  } catch (error) {
    // If parsing fails, it's likely not the JSON structure we're expecting.
    renderAsRaw = true;
  }

  if (renderAsRaw || !parsedContent) {
    // Fallback to rendering the original text if parsing fails or structure is not as expected
    return (
      <ChatMessage
        message={message} // Pass the original message object
        avatarFallback="A"
        // avatarSrc="/path/to/assistant-avatar.png"
      />
    );
  }

  // If parsed successfully, render thinking and answer separately
  // We'll pass a custom ReactNode to ChatMessage's content prop (assuming ChatMessage is modified to accept it)
  // Or, we can construct the content here and pass it as a string if ChatMessage only accepts string.
  // For now, let's construct a ReactNode.

  const customRenderedContent = (
    <div className="space-y-3">
      {parsedContent.thinking && (
        <div className="p-3 bg-blue-50 dark:bg-blue-900/30 rounded-lg shadow">
          <div className="flex items-center text-blue-700 dark:text-blue-300 mb-1">
            <AlertTriangle className="h-5 w-5 mr-2 flex-shrink-0" />
            <h3 className="text-sm font-semibold">Thinking...</h3>
          </div>
          {renderContent(parsedContent.thinking)}
        </div>
      )}
      {parsedContent.answer && (
        <div className="p-3 bg-green-50 dark:bg-green-900/30 rounded-lg shadow">
          <div className="flex items-center text-green-700 dark:text-green-300 mb-1">
            <CheckCircle2 className="h-5 w-5 mr-2 flex-shrink-0" />
            <h3 className="text-sm font-semibold">Answer:</h3>
          </div>
          {renderContent(parsedContent.answer)}
        </div>
      )}
      {parsedContent.error && (
        <div className="p-3 bg-red-50 dark:bg-red-900/30 rounded-lg shadow">
           <div className="flex items-center text-red-700 dark:text-red-300 mb-1">
            <AlertTriangle className="h-5 w-5 mr-2 flex-shrink-0" />
            <h3 className="text-sm font-semibold">Error:</h3>
          </div>
          {renderContent(parsedContent.error)}
        </div>
      )}
      {/* If neither thinking nor answer is present but it was valid JSON, show raw */}
      {!parsedContent.thinking && !parsedContent.answer && !parsedContent.error && (
         <pre className="whitespace-pre-wrap text-xs bg-gray-100 dark:bg-gray-800 p-2 rounded-md">{JSON.stringify(parsedContent, null, 2)}</pre>
      )}
    </div>
  );


  // We need to modify ChatMessage to accept a ReactNode for its content,
  // or adjust this to pass a string. For now, assuming ChatMessage can take a node.
  // A simple way is to pass the customRenderedContent as a new prop, e.g., `customContent`.
  // Or, if ChatMessage is simple, we can replicate its structure here.
  // Let's assume we modify ChatMessage to accept `children` or a `contentNode` prop.
  // For this example, I'll pass it as if ChatMessage's `message.text` could be a ReactNode.
  // This will likely require a change in ChatMessage.tsx.

  const messageWithCustomContent: Message = {
    ...message,
    // This is a conceptual change. ChatMessage needs to be adapted.
    // A better approach would be to pass `customRenderedContent` as a separate prop
    // or for AssistantMessage to use ChatMessage's styling directly.
    text: customRenderedContent as any, // This is a hack; ChatMessage needs to support ReactNode
  };


  return (
    <ChatMessage
      message={message} // Pass original message for timestamp etc.
      avatarFallback="A"
      // avatarSrc="/path/to/assistant-avatar.png"
      // Add a new prop to ChatMessage like `contentOverride`
      contentOverride={customRenderedContent}
    />
  );
};