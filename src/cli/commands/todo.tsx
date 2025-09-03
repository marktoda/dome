import React, { useState, useEffect } from 'react';
import { render, Box, Text, useApp, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import fs from 'node:fs/promises';
import { getTodoPath, parseTodoMarkdown, buildTodoMarkdown, Task, TaskStatus } from '../../core/utils/todo.js';
import logger from '../../core/utils/logger.js';
import chalk from 'chalk';

interface TodoAppProps {
  initialTasks: Task[];
}

interface TrackedTask extends Task {
  wasInitiallyDone?: boolean;
}

const TodoApp: React.FC<TodoAppProps> = ({ initialTasks }) => {
  // Track which tasks were initially done to hide them (unless changed in session)
  const [trackedTasks, setTrackedTasks] = useState<TrackedTask[]>(
    initialTasks.map(task => ({ 
      ...task, 
      wasInitiallyDone: task.status === 'done' 
    }))
  );
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [view, setView] = useState<'all' | TaskStatus>('all');
  const [message, setMessage] = useState<string>('');
  const [isAddingTask, setIsAddingTask] = useState(false);
  const [newTaskText, setNewTaskText] = useState('');
  const [sessionChangedTasks, setSessionChangedTasks] = useState<Set<string>>(new Set());
  const { exit } = useApp();

  // Filter tasks based on current view and hide pre-existing done items
  const visibleTasks = trackedTasks.filter(task => {
    // Always show tasks that were changed in this session
    const taskId = `${task.text}-${task.from}`;
    if (sessionChangedTasks.has(taskId)) {
      return true;
    }
    // Hide tasks that were initially done (not changed in session)
    if (task.wasInitiallyDone && task.status === 'done') {
      return false;
    }
    return true;
  });
  
  const filteredTasks = view === 'all' 
    ? visibleTasks 
    : visibleTasks.filter(t => t.status === view);

  // Save tasks to file
  const saveTasks = async (updatedTasks: TrackedTask[]) => {
    try {
      // Extract base Task objects for saving
      const tasksToSave: Task[] = updatedTasks.map(({ wasInitiallyDone, ...task }) => task);
      const markdown = buildTodoMarkdown(tasksToSave);
      const vaultPath = process.env.DOME_VAULT_PATH || `${process.env.HOME}/dome`;
      const todoPath = await getTodoPath(vaultPath);
      await fs.writeFile(todoPath, markdown, 'utf-8');
      setTrackedTasks(updatedTasks);
      setMessage('✅ Changes saved');
      setTimeout(() => setMessage(''), 2000);
    } catch (error) {
      setMessage(`❌ Error saving: ${error}`);
    }
  };

  // Handle adding new task
  const handleAddTask = async () => {
    if (newTaskText.trim()) {
      const newTask: TrackedTask = {
        text: newTaskText.trim(),
        status: 'pending',
        from: 'manual',
        wasInitiallyDone: false
      };
      const updatedTasks = [...trackedTasks, newTask];
      await saveTasks(updatedTasks);
      setNewTaskText('');
      setIsAddingTask(false);
      setMessage('✅ Task added');
      setTimeout(() => setMessage(''), 2000);
    } else {
      setIsAddingTask(false);
    }
  };

  // Handle keyboard input
  useInput((input, key) => {
    // If adding task, don't process other inputs
    if (isAddingTask) {
      if (key.escape) {
        setIsAddingTask(false);
        setNewTaskText('');
      } else if (key.return) {
        handleAddTask();
      }
      return;
    }

    if (key.escape || (key.ctrl && input === 'c')) {
      exit();
      return;
    }

    if (input === 'q') {
      exit();
      return;
    }

    // Add new task
    if (input === 'a' || input === 'n') {
      setIsAddingTask(true);
      setNewTaskText('');
      return;
    }

    // Navigation
    if (key.upArrow || input === 'k') {
      setSelectedIndex(prev => Math.max(0, prev - 1));
    }
    if (key.downArrow || input === 'j') {
      setSelectedIndex(prev => Math.min(filteredTasks.length - 1, prev + 1));
    }

    // Status changes
    const currentTask = filteredTasks[selectedIndex];
    if (currentTask) {
      const taskIndex = trackedTasks.findIndex(t => 
        t.text === currentTask.text && t.from === currentTask.from
      );
      
      const markTaskChanged = (task: TrackedTask) => {
        const taskId = `${task.text}-${task.from}`;
        setSessionChangedTasks(prev => new Set(prev).add(taskId));
      };
      
      if (input === ' ' || key.return) {
        // Toggle status
        const newStatus = currentTask.status === 'done' 
          ? 'pending' 
          : currentTask.status === 'pending' 
            ? 'in-progress' 
            : 'done';
        
        const updatedTasks = [...trackedTasks];
        updatedTasks[taskIndex] = { ...currentTask, status: newStatus };
        markTaskChanged(updatedTasks[taskIndex]);
        saveTasks(updatedTasks);
      }

      // Quick status shortcuts
      if (input === 'p') {
        const updatedTasks = [...trackedTasks];
        updatedTasks[taskIndex] = { ...currentTask, status: 'pending' };
        markTaskChanged(updatedTasks[taskIndex]);
        saveTasks(updatedTasks);
      }
      if (input === 'i') {
        const updatedTasks = [...trackedTasks];
        updatedTasks[taskIndex] = { ...currentTask, status: 'in-progress' };
        markTaskChanged(updatedTasks[taskIndex]);
        saveTasks(updatedTasks);
      }
      if (input === 'd' || input === 'x') {
        const updatedTasks = [...trackedTasks];
        updatedTasks[taskIndex] = { ...currentTask, status: 'done' };
        markTaskChanged(updatedTasks[taskIndex]);
        saveTasks(updatedTasks);
      }
    }

    // View filters
    if (input === '1') setView('all');
    if (input === '2') setView('pending');
    if (input === '3') setView('in-progress');
    if (input === '4') setView('done');

    // Help
    if (input === '?' || input === 'h') {
      setMessage('Keys: ↑↓/jk=navigate, Space/Enter=toggle, a/n=add task, p=pending, i=in-progress, d/x=done, 1-4=filter, q/Esc=quit');
      setTimeout(() => setMessage(''), 5000);
    }
  });

  // Adjust selected index when filtering changes
  useEffect(() => {
    if (selectedIndex >= filteredTasks.length) {
      setSelectedIndex(Math.max(0, filteredTasks.length - 1));
    }
  }, [view, filteredTasks.length]);

  const getStatusEmoji = (status: TaskStatus) => {
    switch (status) {
      case 'pending': return '⏳';
      case 'in-progress': return '🔄';
      case 'done': return '✅';
    }
  };

  const getStatusColor = (status: TaskStatus) => {
    switch (status) {
      case 'pending': return 'yellow';
      case 'in-progress': return 'blue';
      case 'done': return 'green';
    }
  };

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="cyan">📋 Todo Manager</Text>
        <Text color="gray"> - Press ? for help</Text>
      </Box>

      {/* View tabs */}
      <Box marginBottom={1}>
        <Text color={view === 'all' ? 'cyan' : 'gray'}>[1] All ({visibleTasks.length}) </Text>
        <Text color={view === 'pending' ? 'yellow' : 'gray'}>[2] Pending ({visibleTasks.filter(t => t.status === 'pending').length}) </Text>
        <Text color={view === 'in-progress' ? 'blue' : 'gray'}>[3] In Progress ({visibleTasks.filter(t => t.status === 'in-progress').length}) </Text>
        <Text color={view === 'done' ? 'green' : 'gray'}>[4] Done ({visibleTasks.filter(t => t.status === 'done').length})</Text>
      </Box>

      {/* Task list */}
      <Box flexDirection="column" marginBottom={1}>
        {filteredTasks.length === 0 ? (
          <Text color="gray">No tasks in this view</Text>
        ) : (
          filteredTasks.map((task, index) => (
            <Box key={index}>
              <Text color={index === selectedIndex ? 'cyan' : 'white'}>
                {index === selectedIndex ? '▶ ' : '  '}
              </Text>
              <Text color={getStatusColor(task.status)}>
                {getStatusEmoji(task.status)} 
              </Text>
              <Text color={index === selectedIndex ? 'white' : 'gray'}>
                {' '}{task.text}
              </Text>
              {task.from !== 'manual' && (
                <Text color="gray" dimColor> ({task.from})</Text>
              )}
            </Box>
          ))
        )}
      </Box>

      {/* Add task input */}
      {isAddingTask && (
        <Box marginBottom={1}>
          <Text color="cyan">New task: </Text>
          <TextInput
            value={newTaskText}
            onChange={setNewTaskText}
            placeholder="Enter task description..."
          />
          <Text color="gray"> (Enter to add, Esc to cancel)</Text>
        </Box>
      )}

      {/* Status/Message bar */}
      {message && (
        <Box>
          <Text>{message}</Text>
        </Box>
      )}
    </Box>
  );
};

interface TodoOptions {
  status?: TaskStatus;
  json?: boolean;
  add?: string;
}

export async function handleTodo(options: TodoOptions = {}): Promise<void> {
  try {
    // Read current todos - pass vault path from env if available
    const vaultPath = process.env.DOME_VAULT_PATH || `${process.env.HOME}/dome`;
    const todoPath = await getTodoPath(vaultPath);
    let tasks: Task[] = [];
    
    try {
      const content = await fs.readFile(todoPath, 'utf-8');
      tasks = parseTodoMarkdown(content);
    } catch (err) {
      // File doesn't exist yet
      logger.info('📝 No todo.md file found. Creating one...');
      const markdown = buildTodoMarkdown([]);
      await fs.writeFile(todoPath, markdown, 'utf-8');
    }

    // If adding a new task
    if (options.add) {
      const newTask: Task = {
        text: options.add,
        status: 'pending',
        from: 'manual'
      };
      tasks.push(newTask);
      const markdown = buildTodoMarkdown(tasks);
      await fs.writeFile(todoPath, markdown, 'utf-8');
      logger.info(`✅ Added todo: "${options.add}"`);
      return;
    }

    // If JSON output requested
    if (options.json) {
      console.log(JSON.stringify(tasks, null, 2));
      return;
    }

    // If filtering by status (non-interactive)
    if (options.status) {
      const filtered = tasks.filter(t => t.status === options.status);
      if (filtered.length === 0) {
        logger.info(`No ${options.status} tasks found.`);
      } else {
        logger.info(`\n${options.status.toUpperCase()} Tasks:\n`);
        filtered.forEach(task => {
          const emoji = task.status === 'done' ? '✅' : task.status === 'in-progress' ? '🔄' : '⏳';
          logger.info(`${emoji} ${task.text}${task.from !== 'manual' ? ` (from: ${task.from})` : ''}`);
        });
      }
      return;
    }

    // Interactive mode
    const { waitUntilExit } = render(<TodoApp initialTasks={tasks} />);
    await waitUntilExit();
    
  } catch (error) {
    logger.error(`❌ Failed to manage todos: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  }
}

// Command builder for integration with commander
import { Command } from 'commander';
import { run } from '../utils/command-runner.js';

export function createTodoCommand() {
  return new Command('todo')
    .description('Manage todos from your notes')
    .option('-a, --add <text>', 'Add a new todo')
    .option('-s, --status <status>', 'Filter by status (pending, in-progress, done)')
    .option('--json', 'Output as JSON')
    .action((options: TodoOptions) => {
      return run(() => handleTodo(options));
    });
}