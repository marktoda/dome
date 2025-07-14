import React from 'react';
import { Box, Text } from 'ink';
import { COLORS } from '../constants.js';

interface MarkdownRendererProps {
  content: string;
  color?: string;
}

export const MarkdownRenderer = React.memo<MarkdownRendererProps>(({ content, color = COLORS.white }) => {
  // Handle empty content
  if (!content) {
    return <Box />;
  }
  
  // Split content into lines for processing
  const lines = content.split('\n');
  const elements: React.ReactNode[] = [];
  let inCodeBlock = false;
  let codeBlockContent: string[] = [];
  let codeBlockLang = '';

  const renderInlineMarkdown = (text: string): React.ReactNode[] => {
    const parts: React.ReactNode[] = [];
    let currentText = text;
    let key = 0;

    // Process inline code
    const codeRegex = /`([^`]+)`/g;
    let lastIndex = 0;
    let match;

    while ((match = codeRegex.exec(text)) !== null) {
      // Add text before code
      if (match.index > lastIndex) {
        const beforeText = text.slice(lastIndex, match.index);
        parts.push(renderFormattedText(beforeText, key++));
      }
      
      // Add code
      parts.push(
        <Text key={key++} backgroundColor={COLORS.gray} color={COLORS.black}>
          {' '}{match[1]}{' '}
        </Text>
      );
      
      lastIndex = match.index + match[0].length;
    }

    // Add remaining text
    if (lastIndex < text.length) {
      parts.push(renderFormattedText(text.slice(lastIndex), key++));
    }

    return parts.length > 0 ? parts : [text];
  };

  const renderFormattedText = (text: string, baseKey: number): React.ReactNode[] => {
    const parts: React.ReactNode[] = [];
    let remaining = text;
    let key = baseKey * 100;

    // Process bold
    const boldRegex = /\*\*([^*]+)\*\*/g;
    const boldParts = remaining.split(boldRegex);
    
    boldParts.forEach((part, index) => {
      if (index % 2 === 0) {
        // Regular text - check for italics
        const italicRegex = /\*([^*]+)\*/g;
        const italicParts = part.split(italicRegex);
        
        italicParts.forEach((italicPart, italicIndex) => {
          if (italicIndex % 2 === 0) {
            if (italicPart) parts.push(<Text key={key++}>{italicPart}</Text>);
          } else {
            parts.push(<Text key={key++} italic>{italicPart}</Text>);
          }
        });
      } else {
        // Bold text
        parts.push(<Text key={key++} bold>{part}</Text>);
      }
    });

    return parts.length > 0 ? parts : [<Text key={key}>{text}</Text>];
  };

  lines.forEach((line, lineIndex) => {
    // Handle code blocks
    if (line.startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockLang = line.slice(3).trim();
        codeBlockContent = [];
      } else {
        // End code block
        inCodeBlock = false;
        elements.push(
          <Box key={`code-${lineIndex}`} marginY={1} paddingLeft={2} paddingRight={2} borderStyle="round" borderColor={COLORS.gray}>
            <Box flexDirection="column">
              {codeBlockLang && (
                <Text color={COLORS.you} dimColor>{codeBlockLang}</Text>
              )}
              {codeBlockContent.map((codeLine, idx) => (
                <Text key={idx} color={COLORS.green}>{codeLine}</Text>
              ))}
            </Box>
          </Box>
        );
        codeBlockContent = [];
        codeBlockLang = '';
      }
      return;
    }

    if (inCodeBlock) {
      codeBlockContent.push(line);
      return;
    }

    // Handle headers
    if (line.startsWith('#')) {
      const headerMatch = line.match(/^(#+)\s+(.+)$/);
      if (headerMatch) {
        const level = headerMatch[1].length;
        const headerText = headerMatch[2];
        elements.push(
          <Box key={`h${level}-${lineIndex}`} marginTop={lineIndex > 0 ? 1 : 0}>
            <Text bold color={level === 1 ? COLORS.you : level === 2 ? COLORS.system : COLORS.dome}>
              {headerText}
            </Text>
          </Box>
        );
        return;
      }
    }

    // Handle lists
    if (line.match(/^[\s]*[-*+]\s+/)) {
      const listMatch = line.match(/^([\s]*)([-*+])\s+(.+)$/);
      if (listMatch) {
        const indent = listMatch[1].length;
        const bullet = '•';
        const text = listMatch[3];
        elements.push(
          <Box key={`list-${lineIndex}`} paddingLeft={Math.floor(indent / 2)}>
            <Text color={COLORS.yellow}>{bullet} </Text>
            <Text>{renderInlineMarkdown(text)}</Text>
          </Box>
        );
        return;
      }
    }

    // Handle numbered lists
    if (line.match(/^[\s]*\d+\.\s+/)) {
      const listMatch = line.match(/^([\s]*)(\d+)\.\s+(.+)$/);
      if (listMatch) {
        const indent = listMatch[1].length;
        const number = listMatch[2];
        const text = listMatch[3];
        elements.push(
          <Box key={`olist-${lineIndex}`} paddingLeft={Math.floor(indent / 2)}>
            <Text color={COLORS.yellow}>{number}. </Text>
            <Text>{renderInlineMarkdown(text)}</Text>
          </Box>
        );
        return;
      }
    }

    // Handle blockquotes
    if (line.startsWith('>')) {
      const quoteText = line.replace(/^>\s*/, '');
      elements.push(
        <Box key={`quote-${lineIndex}`} paddingLeft={2} marginY={0}>
          <Text color={COLORS.gray}>│ </Text>
          <Text color={COLORS.gray} italic>{renderInlineMarkdown(quoteText)}</Text>
        </Box>
      );
      return;
    }

    // Handle horizontal rules
    if (line.match(/^[-*_]{3,}$/)) {
      elements.push(
        <Box key={`hr-${lineIndex}`} marginY={1}>
          <Text color={COLORS.gray}>{'─'.repeat(30)}</Text>
        </Box>
      );
      return;
    }

    // Regular paragraph
    if (line.trim()) {
      elements.push(
        <Box key={`p-${lineIndex}`} marginBottom={line.trim() ? 0 : 1}>
          <Text color={color}>{renderInlineMarkdown(line)}</Text>
        </Box>
      );
    } else if (lineIndex < lines.length - 1) {
      // Empty line for spacing
      elements.push(<Box key={`empty-${lineIndex}`} height={1} />);
    }
  });

  return <Box flexDirection="column">{elements}</Box>;
});

MarkdownRenderer.displayName = 'MarkdownRenderer';