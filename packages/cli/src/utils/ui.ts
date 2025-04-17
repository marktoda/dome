import chalk from 'chalk';
import ora from 'ora';

/**
 * Create a spinner with the given text
 * @param text The text to display
 * @returns The spinner instance
 */
export function createSpinner(text: string) {
  return ora({
    text,
    spinner: 'dots',
    color: 'cyan',
  });
}

/**
 * Format a success message
 * @param message The message to format
 * @returns The formatted message
 */
export function success(message: string): string {
  return `${chalk.green('✓')} ${message}`;
}

/**
 * Format an error message
 * @param message The message to format
 * @returns The formatted message
 */
export function error(message: string): string {
  return `${chalk.red('✗')} ${message}`;
}

/**
 * Format a warning message
 * @param message The message to format
 * @returns The formatted message
 */
export function warning(message: string): string {
  return `${chalk.yellow('⚠')} ${message}`;
}

/**
 * Format an info message
 * @param message The message to format
 * @returns The formatted message
 */
export function info(message: string): string {
  return `${chalk.blue('ℹ')} ${message}`;
}

/**
 * Format a heading
 * @param message The message to format
 * @returns The formatted message
 */
export function heading(message: string): string {
  return chalk.bold.cyan(message);
}

/**
 * Format a subheading
 * @param message The message to format
 * @returns The formatted message
 */
export function subheading(message: string): string {
  return chalk.bold.blue(message);
}

/**
 * Format a code block
 * @param message The message to format
 * @returns The formatted message
 */
export function code(message: string): string {
  return chalk.gray(message);
}

/**
 * Format a date
 * @param date The date to format
 * @returns The formatted date
 */
export function formatDate(date: Date | string | number): string {
  const d = new Date(date);
  return d.toLocaleString();
}

/**
 * Format a list of items
 * @param items The items to format
 * @returns The formatted list
 */
export function formatList(items: string[]): string {
  return items.map((item) => `  ${chalk.cyan('•')} ${item}`).join('\n');
}

/**
 * Format a key-value pair
 * @param key The key
 * @param value The value
 * @returns The formatted key-value pair
 */
export function formatKeyValue(key: string, value: string): string {
  return `${chalk.bold(key)}: ${value}`;
}

/**
 * Format a table
 * @param headers The table headers
 * @param rows The table rows
 * @returns The formatted table
 */
export function formatTable(headers: string[], rows: string[][]): string {
  // Calculate column widths
  const columnWidths = headers.map((header, index) => {
    const maxRowWidth = Math.max(...rows.map((row) => row[index]?.length || 0));
    return Math.max(header.length, maxRowWidth);
  });

  // Format headers
  const headerRow = headers
    .map((header, index) => header.padEnd(columnWidths[index]))
    .join(' | ');
  const separator = columnWidths
    .map((width) => '-'.repeat(width))
    .join('-+-');

  // Format rows
  const formattedRows = rows.map((row) =>
    row
      .map((cell, index) => (cell || '').padEnd(columnWidths[index]))
      .join(' | ')
  );

  return [headerRow, separator, ...formattedRows].join('\n');
}