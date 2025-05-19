import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  AssistantContentMessage,
  AssistantThinkingMessage,
  AssistantSourcesMessage,
  AssistantErrorMessage,
  SystemMessage, // For system errors that might use this component
  SourceItem,
  ParsedMessage,
} from '@/lib/chat-types';
import { ChatMessage } from './ChatMessage';
import { Paperclip, AlertTriangle, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

/**
 * Props for the {@link AssistantMessage} component.
 */
interface AssistantMessageProps {
  /**
   * The message object to render. Can be one of several assistant or system message types.
   * System messages of type 'error' can also be rendered by this component.
   */
  message:
    | AssistantContentMessage
    | AssistantThinkingMessage
    | AssistantSourcesMessage
    | AssistantErrorMessage
    | SystemMessage;
}

/**
 * Renders the relevance score of a source item with appropriate color coding.
 * @param score - The relevance score, a number between 0 and 1.
 * @returns A React span element displaying the score as a percentage.
 */
const renderRelevance = (score: number): React.ReactElement => {
  const scorePercentage = Math.round(score * 100);
  let colorClass: string;

  if (scorePercentage > 70) {
    colorClass = 'text-green-600 dark:text-green-400';
  } else if (scorePercentage > 40) {
    colorClass = 'text-yellow-600 dark:text-yellow-400';
  } else {
    colorClass = 'text-red-600 dark:text-red-400';
  }
  return <span className={`text-xs font-medium ${colorClass}`}>({scorePercentage}%)</span>;
};

/**
 * Props for the {@link SourcesDisplay} component.
 */
interface SourcesDisplayProps {
  /** An array of source items to display. */
  sources: SourceItem[];
}

/**
 * Displays a list of sources associated with an assistant message.
 * Each source can include a title, URL, and relevance score.
 * @param props - The props for the component.
 * @param props.sources - An array of source items.
 * @returns A React element rendering the list of sources, or null if no sources are provided.
 */
const SourcesDisplay: React.FC<SourcesDisplayProps> = ({ sources }) => {
  if (!sources || sources.length === 0) return null;

  return (
    <div className="mt-3 pt-3 border-t border-border">
      <h4 className="text-xs font-semibold text-muted-foreground mb-2 flex items-center">
        <Paperclip className="h-4 w-4 mr-2 flex-shrink-0" />
        Sources
      </h4>
      <ul className="space-y-1.5 pl-1">
        {sources.map((source, index) => (
          <li key={source.id || `source-${index}`} className="text-xs">
            <span className="font-medium text-foreground">
              {index + 1}. {source.title || 'Untitled Source'}
            </span>
            {source.url && (
              <a
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-1 text-blue-600 hover:underline dark:text-blue-400"
              >
                (link)
              </a>
            )}
            {typeof source.relevanceScore === 'number' && (
              <span className="ml-1">{renderRelevance(source.relevanceScore)}</span>
            )}
            {source.source && !source.url && (
              <span className="ml-1 text-muted-foreground">({source.source})</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
};

/**
 * Props for the {@link ErrorDisplay} component.
 */
interface ErrorDisplayProps {
  /** The error data object from an AssistantErrorMessage. */
  errorData: AssistantErrorMessage['error'];
  /** Optional user-friendly text to display instead of or in addition to the raw error message. */
  userFriendlyText?: string;
}

/**
 * Displays an error message, potentially with a code and detailed information.
 * @param props - The props for the component.
 * @param props.errorData - The error object containing details like code and message.
 * @param props.userFriendlyText - An optional simpler text to show to the user.
 * @returns A React element rendering the error information.
 */
const ErrorDisplay: React.FC<ErrorDisplayProps> = ({ errorData, userFriendlyText }) => {
  return (
    <div className="mt-2 p-3 border border-destructive/50 rounded-md bg-destructive/10">
      <div className="flex items-center text-destructive mb-1">
        <AlertTriangle className="h-5 w-5 mr-2 flex-shrink-0" />
        <span className="font-semibold text-sm">Error</span>
        {errorData.code && <Badge variant="destructive" className="ml-2 text-xs">{errorData.code}</Badge>}
      </div>
      <p className="text-destructive text-xs prose prose-sm dark:prose-invert max-w-none break-words">
        {userFriendlyText || errorData.message}
      </p>
      {userFriendlyText && errorData.message !== userFriendlyText && (
         <p className="text-destructive/80 text-xs mt-1 italic opacity-80">
            <strong>Details:</strong> {errorData.message}
         </p>
      )}
      {/* TODO: Consider showing errorData.details if needed, perhaps in a collapsible section for technical users. */}
    </div>
  );
};

/**
 * Renders a message from the assistant or a system message.
 * It handles different types of assistant messages like content, thinking, sources, and errors.
 * It also handles system messages of type 'error' or 'system_generic'.
 *
 * @param props - The props for the component.
 * @param props.message - The assistant or system message object to render.
 * @returns A React element representing the assistant or system message, or null if the sender is not 'assistant' or 'system'.
 */
export const AssistantMessage: React.FC<AssistantMessageProps> = ({ message }) => {
  if (message.sender !== 'assistant' && message.sender !== 'system') {
    // This case should ideally not be reached if props are correctly typed and filtered upstream.
    console.warn('AssistantMessage received message from unexpected sender:', message.sender, message);
    return null;
  }

  let contentToRender: React.ReactNode;

  // Ensure message has 'type' property. This is crucial as UserMessage does not have it.
  // This component is specifically for messages that conform to Assistant or System message structures.
  if (!('type' in message)) {
    console.error("AssistantMessage received a message without a 'type' property (potentially a UserMessage):", message);
    // Fallback rendering for unexpected message structure.
    return (
      <ChatMessage
        message={message as ParsedMessage} // Cast, as we know it's not a standard Assistant/System type here.
        avatarFallback="ERR"
        contentOverride={<div className="text-red-500">Invalid message format: Missing &apos;type&apos;.</div>}
      />
    );
  }

  switch (message.type) {
    case 'content':
      contentToRender = (
        <div className="space-y-3">
          <div className="prose prose-sm dark:prose-invert max-w-none break-words">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown>
          </div>
          {/*
            Note: Sources are typically handled by a separate 'sources' message type.
            If the API design changes to embed sources directly within 'content' messages,
            logic to render `message.sources` would be needed here.
          */}
        </div>
      );
      break;
    case 'thinking':
      contentToRender = (
        <div className="flex items-center text-muted-foreground py-2">
          <Loader2 className="h-5 w-5 mr-2 animate-spin" />
          <span className="text-sm italic">{message.text || 'Processing...'}</span>
        </div>
      );
      break;
    case 'sources':
      contentToRender = <SourcesDisplay sources={message.sources} />;
      break;
    case 'error': // Handles both AssistantErrorMessage and SystemMessage with type 'error'
      contentToRender = <ErrorDisplay errorData={message.error} userFriendlyText={message.text} />;
      break;
    case 'system_generic': // Handles SystemMessage with type 'system_generic'
       contentToRender = (
        <div className="text-xs italic text-muted-foreground py-2 px-3 my-1 border-l-2 border-primary bg-muted/30 rounded-r-md">
            {message.text}
        </div>
       );
       break;
    default:
      // This handles cases where 'type' is present but not one of the expected values.
      // The `as any` cast is to satisfy TypeScript for logging, as `message.type` would be `never`.
      console.warn('Unknown message type in AssistantMessage:', (message as any).type, message);
      contentToRender = <div className="text-red-500">Error: Unknown message type received.</div>;
  }

  return (
    <ChatMessage
      message={message} // Pass the original message for ChatMessage's own logic (e.g., sender, timestamp)
      avatarFallback={message.sender === 'system' ? 'SYS' : 'A'}
      contentOverride={contentToRender}
    />
  );
};