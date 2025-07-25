// Color palette from design document (24-bit RGB)
export const COLORS = {
  // Tag colors
  you: '#00d7d7', // cyan
  dome: '#ff00ff', // magenta
  system: '#5f87ff', // blue
  error: '#ff5f5f', // red

  // Activity colors
  tool: '#00d7d7', // cyan (same as you)
  document: '#5fff87', // green

  // UI colors
  border: {
    help: '#5f87ff', // blue
    activity: '#ff00ff', // magenta
  },

  // Other colors
  gray: '#808080',
  yellow: '#ffff00',
  green: '#00ff00',
  white: '#ffffff',
  black: '#000000',
} as const;

// Streaming configuration
export const STREAMING = {
  // Number of UI refreshes per second while streaming.
  // Lower values reduce redraw jitter at the expense of latency.
  FPS: 33, // ~33 fps for smooth streaming
  CURSOR: '▊', // Blinking cursor character
  CURSOR_BLINK_MS: 500, // Cursor blink interval
  // Derived convenience – milliseconds between buffer flushes.
  // Keep this in sync with FPS in the rest of the codebase.
  FLUSH_INTERVAL_MS: 30, // 30ms ≈ 33 fps
} as const;

// Message limits
export const LIMITS = {
  MAX_MESSAGES: 50, // Maximum messages to keep in memory
  MAX_ACTIVITIES: 100, // Maximum activities to keep in memory
  COLLAPSE_THRESHOLD: 200, // Character count to enable collapsing
} as const;

// Layout configuration
export const LAYOUT = {
  HELP_WIDTH: '25%',
  ACTIVITY_WIDTH: '25%',
  PADDING_X: 1,
  PADDING_Y: 1,
} as const;
