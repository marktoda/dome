import React from 'react';
import { Message } from '@/lib/chat-types';
import { ChatMessage } from './ChatMessage';
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';

interface AssistantMessageProps {
  message: Message;
}

// Helper function to render generic content (string or stringified JSON)
const renderGenericContent = (content: string | object): React.ReactNode => {
  if (typeof content === 'string') {
    return <p className="whitespace-pre-wrap">{content}</p>;
  }
  return <pre className="whitespace-pre-wrap text-xs bg-gray-100 dark:bg-gray-800 p-2 rounded-md shadow-inner">{JSON.stringify(content, null, 2)}</pre>;
};

// Types for structured "updates" answer
interface Chunk {
  id: string;
  content: string;
  title?: string;
  metadata?: {
    url?: string;
    [key: string]: unknown; // Changed any to unknown
  };
}

interface Retrieval {
  category: string;
  query: string;
  chunks: Chunk[];
}

interface RetrieveEventData {
  retrieve: {
    retrievals: Retrieval[];
  };
}

type UpdatesEvent = ["updates", RetrieveEventData];

// Type guard for UpdatesEvent
function isUpdatesEvent(data: unknown): data is UpdatesEvent { // Changed any to unknown
  return (
    Array.isArray(data) &&
    data.length === 2 &&
    data[0] === "updates" &&
    typeof data[1] === "object" &&
    data[1] !== null &&
    "retrieve" in data[1] &&
    typeof data[1].retrieve === "object" &&
    data[1].retrieve !== null &&
    "retrievals" in data[1].retrieve &&
    Array.isArray(data[1].retrieve.retrievals)
  );
}

// Custom renderer for the "updates" event structure
const renderStructuredAnswer = (data: UpdatesEvent): React.ReactNode => {
  const retrievals = data[1].retrieve.retrievals;
  if (!retrievals || retrievals.length === 0) {
    return <p className="text-sm italic">No retrieval data found in the update.</p>;
  }

  return (
    <div className="space-y-3">
      {retrievals.map((retrieval, rIndex) => (
        <div key={`retrieval-${rIndex}`} className="p-2 border border-gray-200 dark:border-gray-700 rounded-md bg-white dark:bg-slate-750 shadow">
          <h4 className="font-semibold text-sm mb-1 text-gray-700 dark:text-gray-300">
            Query: <span className="font-normal">{retrieval.query}</span> (Category: <span className="font-normal">{retrieval.category}</span>)
          </h4>
          {retrieval.chunks.map((chunk, cIndex) => (
            <div key={chunk.id || `chunk-${cIndex}`} className="mb-2 last:mb-0 p-2 bg-gray-50 dark:bg-slate-700 rounded-sm border-l-2 border-blue-500 dark:border-blue-400">
              {chunk.title && <h5 className="font-medium text-xs text-gray-800 dark:text-gray-200 mb-0.5">{chunk.title}</h5>}
              <div
                className="text-xs prose prose-sm dark:prose-invert max-w-none [&_strong]:font-semibold"
                dangerouslySetInnerHTML={{ __html: chunk.content }}
              />
              {chunk.metadata?.url && (
                <a
                  href={chunk.metadata.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-600 hover:underline dark:text-blue-400 mt-1 block"
                >
                  Source
                </a>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
};


/**
 * Extracts the first valid JSON object from the start of a string.
 */
function extractJsonAndRemainder(text: string): { parsedJson: unknown | null, remainder: string } { // Changed any to unknown
  let balance = 0;
  let endIndex = -1;
  let inString = false;
  let firstCharIndex = -1;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (firstCharIndex === -1 && (char === '{' || char === '[')) firstCharIndex = i;
    if (firstCharIndex === -1) continue;

    if (char === '"' && (i === firstCharIndex || text[i - 1] !== '\\')) inString = !inString;
    if (!inString) {
      if (char === '{' || char === '[') balance++;
      else if (char === '}' || char === ']') balance--;
    }
    if (balance === 0 && firstCharIndex !== -1 && (char === '}' || char === ']')) {
      endIndex = i;
      break;
    }
  }

  if (endIndex !== -1) {
    const jsonPart = text.substring(firstCharIndex, endIndex + 1);
    try {
      return { parsedJson: JSON.parse(jsonPart), remainder: text.substring(endIndex + 1) };
    } catch (_e) { /* fall through, variable _e is unused */ }
  }
  return { parsedJson: null, remainder: text };
}

export const AssistantMessage: React.FC<AssistantMessageProps> = ({ message }) => {
  if (message.sender !== 'assistant') return null;

  const thinkingSteps: unknown[] = []; // Changed any[] to unknown[]
  let finalAnswerContent: string | object | null = null;
  let finalErrorContent: string | object | null = null;
  const intermediateJsonObjects: unknown[] = []; // Changed any[] to unknown[]

  let textToParse = message.text;
  let explicitAnswerFoundJson = false; // Tracks if {"answer": ...} was found

  while (textToParse.trim().length > 0) {
    const { parsedJson, remainder } = extractJsonAndRemainder(textToParse);

    if (parsedJson) {
      if (typeof parsedJson === 'object' && parsedJson !== null) {
        if ('answer' in parsedJson && !explicitAnswerFoundJson) {
          finalAnswerContent = parsedJson.answer;
          explicitAnswerFoundJson = true;
        } else if ('thinking' in parsedJson) {
          thinkingSteps.push(parsedJson.thinking);
        } else if ('error' in parsedJson) {
          finalErrorContent = parsedJson.error; // Allow error to be set even if answer was found
        } else {
          intermediateJsonObjects.push(parsedJson);
        }
      } else { // Primitive JSON value
        intermediateJsonObjects.push(parsedJson);
      }
      textToParse = remainder.trimStart();
    } else { // No more JSON, remainder is plain text
      if (textToParse.trim().length > 0 && !explicitAnswerFoundJson) {
        finalAnswerContent = textToParse.trim(); // This becomes the answer if no {"answer":...}
        explicitAnswerFoundJson = true; // Treat trailing text as an explicit answer form
      }
      break;
    }
  }

  if (!explicitAnswerFoundJson && intermediateJsonObjects.length > 0) {
    finalAnswerContent = intermediateJsonObjects.pop(); // Last non-special JSON is the answer
  }
  thinkingSteps.push(...intermediateJsonObjects); // Remaining are thinking steps

  // If after all parsing, no answer/error/thinking steps, and original message had text, use original text as answer.
  if (finalAnswerContent === null && finalErrorContent === null && thinkingSteps.length === 0 && message.text.trim().length > 0) {
    finalAnswerContent = message.text;
  }

  const customRenderedContent = (
    <div className="space-y-3">
      {thinkingSteps.map((step, index) => (
        <div key={`thinking-${index}`} className="p-3 bg-blue-50 dark:bg-slate-800 rounded-lg shadow-md border border-blue-200 dark:border-slate-700">
          <div className="flex items-center text-blue-700 dark:text-blue-400 mb-1.5">
            <Info className="h-5 w-5 mr-2 flex-shrink-0" />
            <h3 className="text-sm font-semibold tracking-wide">Intermediate Step</h3>
          </div>
          {renderGenericContent(step)}
        </div>
      ))}
      {finalErrorContent && (
        <div className="p-3 bg-red-50 dark:bg-red-900/40 rounded-lg shadow-md border border-red-200 dark:border-red-700">
          <div className="flex items-center text-red-700 dark:text-red-400 mb-1.5">
            <AlertTriangle className="h-5 w-5 mr-2 flex-shrink-0" />
            <h3 className="text-sm font-semibold tracking-wide">Error:</h3>
          </div>
          {renderGenericContent(finalErrorContent)}
        </div>
      )}
      {finalAnswerContent !== null && ( // Check for null explicitly, as empty string is a valid answer
        <div className="p-3 bg-green-50 dark:bg-emerald-900/40 rounded-lg shadow-md border border-green-200 dark:border-emerald-700">
          <div className="flex items-center text-green-700 dark:text-emerald-400 mb-1.5">
            <CheckCircle2 className="h-5 w-5 mr-2 flex-shrink-0" />
            <h3 className="text-sm font-semibold tracking-wide">Answer:</h3>
          </div>
          {isUpdatesEvent(finalAnswerContent)
            ? renderStructuredAnswer(finalAnswerContent as UpdatesEvent)
            : renderGenericContent(finalAnswerContent)
          }
        </div>
      )}
      {/* Fallback for truly empty messages or if all content was consumed and nothing rendered */}
      {finalAnswerContent === null && finalErrorContent === null && thinkingSteps.length === 0 && (
         <div className="p-3 bg-gray-100 dark:bg-slate-800 rounded-lg shadow-md border dark:border-slate-700">
             <p className="text-sm italic">Assistant provided no structured response.</p>
         </div>
      )}
    </div>
  );

  return (
    <ChatMessage
      message={message}
      avatarFallback="A"
      contentOverride={customRenderedContent}
    />
  );
};