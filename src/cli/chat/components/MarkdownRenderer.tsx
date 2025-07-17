import React from 'react';
import { Box, Text } from 'ink';
import { COLORS } from '../constants.js';

interface MarkdownRendererProps {
  content: string;
  color?: string;
}

export const MarkdownRenderer = React.memo<MarkdownRendererProps>(
  ({ content, color = COLORS.white }) => {
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
            {' '}
            {match[1]}{' '}
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

    const renderFormattedText = (text: string, key: number): React.ReactNode => {
      // Process bold
      const boldRegex = /\*\*([^*]+)\*\*/g;
      const boldParts: React.ReactNode[] = [];
      let lastBoldIndex = 0;
      let boldMatch;

      while ((boldMatch = boldRegex.exec(text)) !== null) {
        if (boldMatch.index > lastBoldIndex) {
          boldParts.push(text.slice(lastBoldIndex, boldMatch.index));
        }
        boldParts.push(
          <Text key={`b-${key}-${boldMatch.index}`} bold>
            {boldMatch[1]}
          </Text>
        );
        lastBoldIndex = boldMatch.index + boldMatch[0].length;
      }

      if (lastBoldIndex < text.length) {
        boldParts.push(text.slice(lastBoldIndex));
      }

      if (boldParts.length === 0) {
        return text;
      }

      return <React.Fragment key={key}>{boldParts}</React.Fragment>;
    };

    const renderCodeBlock = (
      lang: string,
      content: string[],
      lineIndex: number
    ): React.ReactNode => {
      return (
        <Box key={`code-${lineIndex}`} flexDirection="column" marginY={1}>
          {lang && (
            <Box marginBottom={0}>
              <Text color={COLORS.gray}>{lang}</Text>
            </Box>
          )}
          <Box
            borderStyle="single"
            borderColor={COLORS.gray}
            paddingX={1}
            flexDirection="column"
          >
            {content.map((line, i) => (
              <Text key={i} color={COLORS.green}>
                {line || ' '}
              </Text>
            ))}
          </Box>
        </Box>
      );
    };

    lines.forEach((line, lineIndex) => {
      // Check for code block markers
      if (line.trim().startsWith('```')) {
        if (!inCodeBlock) {
          // Starting a code block
          inCodeBlock = true;
          codeBlockLang = line.trim().slice(3);
          codeBlockContent = [];
        } else {
          // Ending a code block
          inCodeBlock = false;
          elements.push(renderCodeBlock(codeBlockLang, codeBlockContent, lineIndex));
          codeBlockContent = [];
          codeBlockLang = '';
        }
        return;
      }

      // If we're in a code block, collect the content
      if (inCodeBlock) {
        codeBlockContent.push(line);
        return;
      }

      // Headers
      if (line.startsWith('#')) {
        const level = line.match(/^#+/)?.[0].length || 1;
        const headerText = line.slice(level).trim();
        const headerColor = level === 1 ? COLORS.dome : level === 2 ? COLORS.you : COLORS.system;

        elements.push(
          <Box key={`h-${lineIndex}`} marginY={1}>
            <Text color={headerColor} bold>
              {renderInlineMarkdown(headerText)}
            </Text>
          </Box>
        );
        return;
      }

      // Bullet points
      if (line.trim().match(/^[-*+]\s+/)) {
        const bulletContent = line.trim().slice(2);
        elements.push(
          <Box key={`ul-${lineIndex}`} marginLeft={2}>
            <Text color={COLORS.gray}>• </Text>
            <Text color={color}>{renderInlineMarkdown(bulletContent)}</Text>
          </Box>
        );
        return;
      }

      // Numbered lists
      const numberedMatch = line.trim().match(/^(\d+)\.\s+(.*)$/);
      if (numberedMatch) {
        elements.push(
          <Box key={`ol-${lineIndex}`} marginLeft={2}>
            <Text color={COLORS.gray}>{numberedMatch[1]}. </Text>
            <Text color={color}>{renderInlineMarkdown(numberedMatch[2])}</Text>
          </Box>
        );
        return;
      }

      // Blockquotes
      if (line.trim().startsWith('>')) {
        const quoteContent = line.trim().slice(1).trim();
        elements.push(
          <Box
            key={`bq-${lineIndex}`}
            marginLeft={2}
            borderStyle="single"
            borderColor={COLORS.gray}
            paddingX={1}
            marginY={1}
          >
            <Text color={COLORS.gray} italic>
              {renderInlineMarkdown(quoteContent)}
            </Text>
          </Box>
        );
        return;
      }

      // Horizontal rule
      if (line.trim().match(/^---+$/)) {
        elements.push(
          <Box key={`hr-${lineIndex}`} marginY={1}>
            <Text color={COLORS.gray}>{'─'.repeat(50)}</Text>
          </Box>
        );
        return;
      }

      // Regular paragraph
      if (line.trim()) {
        elements.push(
          <Box key={`p-${lineIndex}`} marginBottom={line.trim() ? 0 : 1}>
            <Text color={color} wrap="wrap">{renderInlineMarkdown(line)}</Text>
          </Box>
        );
      } else if (lineIndex < lines.length - 1) {
        // Empty line for spacing
        elements.push(<Box key={`empty-${lineIndex}`} height={1} />);
      }
    });

    return <Box flexDirection="column">{elements}</Box>;
  },
  // Custom comparison - only re-render if content or color changes
  (prevProps, nextProps) => {
    return prevProps.content === nextProps.content && prevProps.color === nextProps.color;
  }
);

MarkdownRenderer.displayName = 'MarkdownRenderer';
