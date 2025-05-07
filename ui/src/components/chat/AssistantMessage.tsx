import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Message, SourceItem } from '@/lib/chat-types';
import { ChatMessage } from './ChatMessage';
import { Paperclip } from 'lucide-react'; // Using Paperclip for sources icon

interface AssistantMessageProps {
  message: Message;
}

const renderRelevance = (score: number) => {
  const scorePercentage = Math.round(score * 100);
  let colorClass = 'text-red-600 dark:text-red-400';
  if (scorePercentage > 70) {
    colorClass = 'text-green-600 dark:text-green-400';
  } else if (scorePercentage > 40) {
    colorClass = 'text-yellow-600 dark:text-yellow-400';
  }
  return <span className={`text-xs font-medium ${colorClass}`}>({scorePercentage}%)</span>;
};

export const AssistantMessage: React.FC<AssistantMessageProps> = ({ message }) => {
  if (message.sender !== 'assistant') return null;

  const content = (
    <div className="space-y-3">
      <div className="prose prose-sm dark:prose-invert max-w-none">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown>
      </div>
      {message.sources && message.sources.length > 0 && (
        <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700">
          <h4 className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2 flex items-center">
            <Paperclip className="h-4 w-4 mr-2 flex-shrink-0" />
            Sources
          </h4>
          <ul className="space-y-1.5 pl-1">
            {message.sources.map((source: SourceItem, index: number) => (
              <li key={source.id || `source-${index}`} className="text-xs">
                <span className="font-medium text-gray-800 dark:text-gray-200">
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
                {source.relevanceScore !== undefined && (
                  <span className="ml-1">{renderRelevance(source.relevanceScore)}</span>
                )}
                {source.source && !source.url && ( // Show source if URL is not present
                   <span className="ml-1 text-gray-500 dark:text-gray-400">({source.source})</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );

  return (
    <ChatMessage
      message={message}
      avatarFallback="A"
      contentOverride={content}
    />
  );
};