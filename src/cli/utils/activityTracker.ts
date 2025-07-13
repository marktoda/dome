import { Activity } from '../components/ActivityPanel.js';

export interface ActivityTracker {
  addActivity: (type: 'tool' | 'document', name: string) => void;
}

// Global activity tracker instance that can be used by tools
let globalTracker: ActivityTracker | null = null;

export function setActivityTracker(tracker: ActivityTracker) {
  globalTracker = tracker;
}

export function trackActivity(type: 'tool' | 'document', name: string) {
  if (globalTracker) {
    globalTracker.addActivity(type, name);
  }
}

// Helper to extract note titles from content
export function extractNoteInfo(content: string): { title: string; path: string } | null {
  // Try to extract title from markdown frontmatter
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (frontmatterMatch) {
    const titleMatch = frontmatterMatch[1].match(/title:\s*["']?([^"'\n]+)["']?/);
    if (titleMatch) {
      return { title: titleMatch[1], path: '' };
    }
  }
  
  // Try to extract title from first heading
  const headingMatch = content.match(/^#\s+(.+)$/m);
  if (headingMatch) {
    return { title: headingMatch[1], path: '' };
  }
  
  return null;
}

// Analyze agent responses to detect tool usage patterns
export function analyzeAgentResponse(response: string): { tools: string[], documents: string[] } {
  const tools: string[] = [];
  const documents: string[] = [];
  
  // Common patterns that indicate tool usage
  const toolPatterns = [
    { pattern: /searching\s+for\s+notes?/i, tool: 'searchNotesTool' },
    { pattern: /found\s+\d+\s+notes?/i, tool: 'searchNotesTool' },
    { pattern: /retrieving\s+note/i, tool: 'getNoteTool' },
    { pattern: /reading\s+note/i, tool: 'getNoteTool' },
    { pattern: /creating\s+(?:new\s+)?note/i, tool: 'writeNoteTool' },
    { pattern: /updating\s+note/i, tool: 'writeNoteTool' },
    { pattern: /writing\s+to\s+note/i, tool: 'writeNoteTool' },
    { pattern: /deleting\s+note/i, tool: 'removeNoteTool' },
    { pattern: /removing\s+note/i, tool: 'removeNoteTool' },
    { pattern: /vault\s+context/i, tool: 'getVaultContextTool' }
  ];
  
  for (const { pattern, tool } of toolPatterns) {
    if (pattern.test(response) && !tools.includes(tool)) {
      tools.push(tool);
    }
  }
  
  // Extract document references
  const notePatterns = [
    /(?:note|file|document):\s*['"]?([^'"]+\.md)['"]?/gi,
    /(?:reading|found|retrieved)\s+['"]?([^'"]+\.md)['"]?/gi,
    /\b(\w+[-\w]*\.md)\b/gi
  ];
  
  for (const pattern of notePatterns) {
    const matches = response.matchAll(pattern);
    for (const match of matches) {
      const docName = match[1];
      if (!docName.includes('example') && !documents.includes(docName)) {
        documents.push(docName);
      }
    }
  }
  
  return { tools, documents };
}