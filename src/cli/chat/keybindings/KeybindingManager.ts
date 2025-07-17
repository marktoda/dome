import {
  KeybindingRegistry,
  CommandRegistry,
  KeybindingContext,
  KeyCombination,
  Keybinding,
} from './types.js';
import { KeybindingRegistryImpl } from './KeybindingRegistry.js';
import { CommandRegistryImpl } from './CommandRegistry.js';
import { fromInkInput, formatKeybinding as formatKeybindingStr } from './utils.js';
import { defaultKeybindings } from './defaultKeybindings.js';

/**
 * Main keybinding manager that handles keyboard input and executes commands
 */
export class KeybindingManager {
  private keybindingRegistry: KeybindingRegistry;
  private commandRegistry: CommandRegistry;
  private enabled = true;

  /**
   * @param keybindingRegistry Inject a custom KeybindingRegistry (defaults to internal impl)
   * @param commandRegistry    Inject a custom CommandRegistry   (defaults to internal impl)
   */
  constructor(
    keybindingRegistry: KeybindingRegistry = new KeybindingRegistryImpl(),
    commandRegistry: CommandRegistry = new CommandRegistryImpl()
  ) {
    this.keybindingRegistry = keybindingRegistry;
    this.commandRegistry = commandRegistry;
  }

  /**
   * Initialize with default keybindings and commands
   */
  initialize(commands: Record<string, () => void | Promise<void>>): void {
    // Register commands
    for (const [id, handler] of Object.entries(commands)) {
      this.commandRegistry.register({
        id,
        handler,
      });
    }

    // Register default keybindings
    for (const binding of defaultKeybindings) {
      this.keybindingRegistry.register(binding);
    }
  }

  /**
   * Handle keyboard input from Ink's useInput
   */
  handleInput(input: string, key: Record<string, boolean>, context: KeybindingContext): boolean {
    if (!this.enabled) return false;

    // Convert Ink key format to our KeyCombination format
    const keys: KeyCombination = fromInkInput(input, key);

    // Find matching keybinding
    const binding = this.keybindingRegistry.findBinding(keys, context);
    if (!binding) return false;

    // Execute the command (async, fire and forget)
    this.commandRegistry.execute(binding.command, binding.args).catch(error => {
      console.error(`Error executing command ${binding.command}:`, error);
    });

    return true;
  }

  /**
   * Register a custom keybinding
   */
  registerKeybinding(binding: {
    id: string;
    keys: KeyCombination;
    command: string;
    when?: string;
    description?: string;
    group?: string;
    args?: Record<string, any>;
  }): void {
    this.keybindingRegistry.register(binding);
  }

  /**
   * Register a custom command
   */
  registerCommand(id: string, handler: () => void | Promise<void>, description?: string, group?: string): void {
    this.commandRegistry.register({
      id,
      handler,
      description,
      group,
    });
  }

  /**
   * Enable or disable keybinding processing
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Get all registered keybindings
   */
  getKeybindings() {
    return this.keybindingRegistry.getBindings();
  }

  /**
   * Get keybindings organized by group
   */
  getKeybindingsByGroup() {
    const groups = new Map<string, Keybinding[]>();
    
    for (const binding of this.keybindingRegistry.getBindings()) {
      const group = binding.group || 'Other';
      if (!groups.has(group)) {
        groups.set(group, []);
      }
      groups.get(group)!.push(binding);
    }
    
    return groups;
  }

  /**
   * Generate help text for keybindings
   */
  generateHelpText(): string {
    const groups = this.getKeybindingsByGroup();
    const lines: string[] = ['Keyboard Shortcuts:'];
    
    for (const [group, bindings] of groups) {
      lines.push('');
      lines.push(`${group}:`);
      
      for (const binding of bindings) {
        const keyStr = formatKeybindingStr(binding.keys);
        let line = `  ${keyStr.padEnd(20)} - ${binding.description || binding.command}`;
        
        if (binding.when) {
          line += ` (when: ${binding.when})`;
        }
        
        lines.push(line);
      }
    }
    
    return lines.join('\n');
  }
} 