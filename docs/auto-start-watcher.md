# Auto-Start Watcher Feature

The dome watch worker now automatically starts when you run any dome command, ensuring file changes are tracked without manual intervention.

## How It Works

When you run any dome command (except watch-related commands), the system:
1. Checks if the watcher daemon is already running
2. If not running and auto-start is enabled, starts it in the background
3. Shows a subtle notification: `→ Watcher started in background`

## Configuration

### Enable/Disable Auto-Start

```bash
# Disable auto-start
dome config --auto-start-watcher false

# Enable auto-start (default)
dome config --auto-start-watcher true

# View current configuration
dome config --show
```

### Environment Variable

You can also control auto-start via environment variable:

```bash
export DOME_AUTO_START_WATCHER=false
```

## Manual Control

You still have full manual control over the watcher:

```bash
# Start manually
dome watch --daemon

# Check status
dome watch:status

# Stop the daemon
dome watch:stop
```

## Benefits

- **Zero Configuration**: Works out of the box
- **Automatic**: No need to remember to start the watcher
- **Unobtrusive**: Runs silently in the background
- **Configurable**: Can be disabled if preferred
- **Smart**: Won't start multiple instances

## Implementation Details

- Auto-start is skipped when running watch commands themselves
- Configuration is stored in `~/.dome/.dome/config.json`
- PID tracking prevents duplicate daemons
- Fails silently if unable to start (won't interrupt your work)