import { vi, describe, it, expect } from 'vitest';
import { createStateSummary } from './loggingHelpers';
import { AgentState, Document } from '../types';

describe('loggingHelpers', () => {
  describe('createStateSummary', () => {
    it('should handle empty state', () => {
      expect(createStateSummary({})).toEqual({});
      expect(createStateSummary(null as any)).toEqual({});
    });

    it('should summarize docs array', () => {
      const docs: Document[] = [
        { id: 'doc1', title: 'Document 1', body: 'Lorem ipsum dolor sit amet', metadata: { source: 'test', createdAt: '2025-01-01', relevanceScore: 0.9 } },
        { id: 'doc2', title: 'Document 2', body: 'Consectetur adipiscing elit', metadata: { source: 'test', createdAt: '2025-01-02', relevanceScore: 0.8 } },
        { id: 'doc3', title: 'Document 3', body: 'Sed do eiusmod tempor', metadata: { source: 'test', createdAt: '2025-01-03', relevanceScore: 0.7 } },
        { id: 'doc4', title: 'Document 4', body: 'Incididunt ut labore', metadata: { source: 'test', createdAt: '2025-01-04', relevanceScore: 0.6 } },
      ];

      const state: Partial<AgentState> = { docs };
      const summary = createStateSummary(state);
      
      expect(summary.docs).toHaveLength(4);
      expect(summary.docs[0]).toEqual({
        idx: 0,
        id: 'doc1',
        title: 'Document 1',
        source: 'test',
        url: undefined,
        relevanceScore: 0.9,
      });
    });

    it('should truncate long messages', () => {
      const longContent = 'This is a very long message that should be truncated in the logging summary. We want to make sure that it does not take up too much space in the logs.';
      const state: Partial<AgentState> = {
        messages: [
          { role: 'user', content: longContent },
          { role: 'assistant', content: 'Short reply' }
        ]
      };

      const summary = createStateSummary(state);
      expect(summary.messages[0].content).toEqual('This is a very long message that should be truncat...');
      expect(summary.messages[1].content).toEqual('Short reply');
    });
  });
});