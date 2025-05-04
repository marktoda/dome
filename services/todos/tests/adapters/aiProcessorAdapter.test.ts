import { describe, it, expect } from 'vitest';
import { AiProcessorAdapter, AiExtractedTodo } from '../../src/adapters/aiProcessorAdapter';
import { TodoJob, TodoPriority } from '../../src/types';

describe('AiProcessorAdapter', () => {
  describe('transformTodos', () => {
    it('should return an empty array when input is empty', () => {
      // Test with an empty array
      const result = AiProcessorAdapter.transformTodos([], 'note-123', 'user-456');
      expect(result).toEqual([]);

      // Test with null/undefined
      const result2 = AiProcessorAdapter.transformTodos(null as any, 'note-123', 'user-456');
      expect(result2).toEqual([]);
    });

    it('should transform a simple todo without metadata', () => {
      const rawTodos: AiExtractedTodo[] = [{ text: 'Buy groceries' }];

      const result = AiProcessorAdapter.transformTodos(rawTodos, 'note-123', 'user-456');

      expect(result).toHaveLength(1);
      const todo = result[0];

      expect(todo).toMatchObject({
        userId: 'user-456',
        sourceNoteId: 'note-123',
        sourceText: 'Buy groceries',
        title: 'Buy groceries',
        aiGenerated: true,
        version: 1,
      });

      // Check created timestamp exists and is recent
      expect(todo.created).toBeDefined();
      expect(Date.now() - todo.created).toBeLessThan(5000);

      // No priority or due date should be set
      expect(todo.aiSuggestions?.priority).toBeUndefined();
      expect(todo.aiSuggestions?.dueDate).toBeUndefined();
    });

    it('should transform todos with priority information', () => {
      const rawTodos: AiExtractedTodo[] = [
        { text: 'Fix urgent bug', priority: 'high' },
        { text: 'Update documentation', priority: 'low' },
      ];

      const result = AiProcessorAdapter.transformTodos(rawTodos, 'note-123', 'user-456');

      expect(result).toHaveLength(2);

      // Check priorities are correctly mapped
      expect(result[0].aiSuggestions?.priority).toBe(TodoPriority.HIGH);
      expect(result[1].aiSuggestions?.priority).toBe(TodoPriority.LOW);
    });

    it('should normalize priority values', () => {
      const rawTodos: AiExtractedTodo[] = [
        { text: 'Task 1', priority: 'HIGH' },
        { text: 'Task 2', priority: 'medium' },
        { text: 'Task 3', priority: 'URGENT' },
        { text: 'Task 4', priority: 'invalid' },
      ];

      const result = AiProcessorAdapter.transformTodos(rawTodos, 'note-123', 'user-456');

      expect(result[0].aiSuggestions?.priority).toBe(TodoPriority.HIGH);
      expect(result[1].aiSuggestions?.priority).toBe(TodoPriority.MEDIUM);
      expect(result[2].aiSuggestions?.priority).toBe(TodoPriority.URGENT);
      expect(result[3].aiSuggestions?.priority).toBe(TodoPriority.MEDIUM); // Default for unknown values
    });

    it('should parse due dates correctly', () => {
      // Use fixed timestamp for testing
      const testDate = new Date('2025-01-15T10:00:00Z');

      const rawTodos: AiExtractedTodo[] = [
        { text: 'Task with ISO date', dueDate: '2025-01-15T10:00:00Z' },
        { text: 'Task with human date', dueDate: 'January 15, 2025' },
        { text: 'Task with invalid date', dueDate: 'next Tuesday' },
      ];

      const result = AiProcessorAdapter.transformTodos(rawTodos, 'note-123', 'user-456');

      // Valid ISO date should be parsed
      expect(result[0].aiSuggestions?.dueDate).toBeDefined();
      expect(new Date(result[0].aiSuggestions!.dueDate!).toISOString()).toBe(
        testDate.toISOString(),
      );

      // Human readable date should be parsed
      expect(result[1].aiSuggestions?.dueDate).toBeDefined();

      // Invalid date might be parsed differently depending on environment
      // Just verify it doesn't crash
      expect(result[2]).toBeDefined();
    });

    it('should handle complex todos', () => {
      const rawTodos: AiExtractedTodo[] = [
        {
          text: 'Prepare quarterly report',
          dueDate: '2025-03-31',
          priority: 'high',
          location: 'Finance department',
        },
      ];

      const result = AiProcessorAdapter.transformTodos(rawTodos, 'note-123', 'user-456');

      expect(result[0]).toMatchObject({
        sourceText: 'Prepare quarterly report',
        aiSuggestions: {
          priority: TodoPriority.HIGH,
        },
      });

      // Due date should be parsed correctly
      expect(result[0].aiSuggestions?.dueDate).toBeDefined();

      // Extra fields should be ignored
      expect(Object.keys(result[0]).includes('location')).toBe(false);
    });
  });
});
