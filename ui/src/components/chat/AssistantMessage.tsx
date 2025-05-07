import React from 'react';
import { Message } from '@/lib/chat-types';
import { ChatMessage } from './ChatMessage';
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';

interface AssistantMessageProps {
  message: Message;
}

const renderContent = (content: string | object): React.ReactNode => {
  if (typeof content === 'string') {
    // Ensure newlines in string content are respected
    return <p className="whitespace-pre-wrap">{content}</p>;
  }
  // If it's an object, stringify it for display
  return <pre className="whitespace-pre-wrap text-xs bg-gray-100 dark:bg-gray-800 p-2 rounded-md shadow-inner">{JSON.stringify(content, null, 2)}</pre>;
};

/**
 * Extracts the first valid JSON object from the start of a string.
 * Returns the parsed JSON and the remainder of the string.
 */
function extractJsonAndRemainder(text: string): { parsedJson: any | null, remainder: string } {
  let balance = 0;
  let endIndex = -1;
  let inString = false;
  let firstCharIndex = -1;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (firstCharIndex === -1 && (char === '{' || char === '[')) {
      firstCharIndex = i;
    }
    
    if (firstCharIndex === -1) continue; // Skip leading non-JSON characters for this extraction attempt

    if (char === '"') {
      // Look for unescaped quotes
      if (i === 0 || text[i-1] !== '\\') {
        inString = !inString;
      }
    }

    if (!inString) {
      if (char === '{' || char === '[') {
        balance++;
      } else if (char === '}' || char === ']') {
        balance--;
      }
    }

    if (balance === 0 && firstCharIndex !== -1 && (char === '}' || char === ']')) {
      endIndex = i;
      break;
    }
  }

  if (endIndex !== -1) {
    // Ensure we start parsing from the actual beginning of the JSON object
    const jsonPart = text.substring(firstCharIndex, endIndex + 1);
    try {
      const parsed = JSON.parse(jsonPart);
      return { parsedJson: parsed, remainder: text.substring(endIndex + 1) };
    } catch (e) {
      // Parsing failed, return original text as remainder
      return { parsedJson: null, remainder: text };
    }
  }
  return { parsedJson: null, remainder: text }; // No complete JSON object found
}


export const AssistantMessage: React.FC<AssistantMessageProps> = ({ message }) => {
  if (message.sender !== 'assistant') {
    return null;
  }

  const thinkingSteps: any[] = [];
  let answerContent: string | object | null = null;
  let errorContent: string | object | null = null;
  let textToParse = message.text;
  let hasProcessedStructuredContent = false;

  while (textToParse.trim().length > 0) {
    const { parsedJson, remainder } = extractJsonAndRemainder(textToParse);
    if (parsedJson) {
      hasProcessedStructuredContent = true;
      if (typeof parsedJson === 'object' && parsedJson !== null) {
        let isSpecialObject = false;
        if ('answer' in parsedJson) {
          answerContent = parsedJson.answer;
          isSpecialObject = true;
        }
        // 'thinking' can co-exist with 'answer' or be standalone
        if ('thinking' in parsedJson) {
          thinkingSteps.push(parsedJson.thinking);
          isSpecialObject = true;
        }
        if ('error' in parsedJson) {
          errorContent = parsedJson.error;
          isSpecialObject = true;
        }
        // If it's a JSON object but not one of the special ones, treat it as a thinking step
        if (!isSpecialObject) {
          thinkingSteps.push(parsedJson);
        }
      } else {
        // If parsedJson is a primitive (e.g. a string from JSON.parse(`"hello"`)), treat as thinking
        thinkingSteps.push(parsedJson);
      }
      textToParse = remainder.trimStart(); // Use trimStart to preserve internal newlines in potential plain text remainder
    } else {
      // No more JSON found at the beginning of textToParse.
      // The rest is plain text. If no structured answerContent was found, this is it.
      if (textToParse.trim().length > 0 && !answerContent) {
        answerContent = textToParse.trim();
      }
      break; // Stop processing
    }
  }

  // If no structured content was processed at all from the start, the original message.text is the answer.
  if (!hasProcessedStructuredContent && message.text.trim().length > 0) {
    answerContent = message.text;
  }
  
  const customRenderedContent = (
    <div className="space-y-3">
      {thinkingSteps.length > 0 && thinkingSteps.map((step, index) => (
        <div key={`thinking-${index}`} className="p-3 bg-blue-50 dark:bg-slate-800 rounded-lg shadow-md border border-blue-200 dark:border-slate-700">
          <div className="flex items-center text-blue-700 dark:text-blue-400 mb-1.5">
            <Info className="h-5 w-5 mr-2 flex-shrink-0" />
            <h3 className="text-sm font-semibold tracking-wide">Intermediate Step</h3>
          </div>
          {renderContent(step)}
        </div>
      ))}
      {errorContent && (
        <div className="p-3 bg-red-50 dark:bg-red-900/40 rounded-lg shadow-md border border-red-200 dark:border-red-700">
          <div className="flex items-center text-red-700 dark:text-red-400 mb-1.5">
            <AlertTriangle className="h-5 w-5 mr-2 flex-shrink-0" />
            <h3 className="text-sm font-semibold tracking-wide">Error:</h3>
          </div>
          {renderContent(errorContent)}
        </div>
      )}
      {answerContent && (
        <div className="p-3 bg-green-50 dark:bg-emerald-900/40 rounded-lg shadow-md border border-green-200 dark:border-emerald-700">
          <div className="flex items-center text-green-700 dark:text-emerald-400 mb-1.5">
            <CheckCircle2 className="h-5 w-5 mr-2 flex-shrink-0" />
            <h3 className="text-sm font-semibold tracking-wide">Answer:</h3>
          </div>
          {renderContent(answerContent)}
        </div>
      )}
      {/* Fallback if nothing was extracted but the original message had content */}
      {!thinkingSteps.length && !answerContent && !errorContent && message.text.trim().length > 0 && (
           <div className="p-3 bg-gray-100 dark:bg-slate-800 rounded-lg shadow-md border dark:border-slate-700">
               {renderContent(message.text)}
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