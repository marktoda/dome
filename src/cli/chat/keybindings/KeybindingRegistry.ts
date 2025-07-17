import {
  Keybinding,
  KeyCombination,
  KeybindingContext,
  KeybindingRegistry,
} from './types.js';
import { formatKeybinding as formatKeybindingStr } from './utils.js';

interface CompiledKeybinding extends Keybinding {
  whenPredicate: (ctx: KeybindingContext) => boolean;
}

export class KeybindingRegistryImpl implements KeybindingRegistry {
  private bindings = new Map<string, CompiledKeybinding>();

  register(binding: Keybinding): void {
    if (this.bindings.has(binding.id)) {
      console.warn(`Keybinding with id '${binding.id}' already exists. Overwriting.`);
    }

    // Detect duplicate key combinations in same context condition
    for (const existing of this.bindings.values()) {
      if (this.keysEqual(existing.keys, binding.keys) && (existing.when || '') === (binding.when || '')) {
        console.warn(
          `Keybinding conflict: '${binding.id}' conflicts with existing binding '${existing.id}' using the same keys (${formatKeybindingStr(
            binding.keys
          )}) and context.`
        );
      }
    }

    const compiled: CompiledKeybinding = {
      ...binding,
      whenPredicate: this.compileWhen(binding.when),
    };

    this.bindings.set(binding.id, compiled);
  }

  unregister(id: string): void {
    this.bindings.delete(id);
  }

  getBindings(): Keybinding[] {
    // Strip the compiled function when returning publicly
    return Array.from(this.bindings.values()).map(({ whenPredicate, ...rest }) => rest);
  }

  getBindingsByGroup(group: string): Keybinding[] {
    return this.getBindings().filter(binding => binding.group === group);
  }

  findBinding(keys: KeyCombination, context: KeybindingContext): Keybinding | undefined {
    for (const binding of this.bindings.values()) {
      if (this.keysMatch(keys, binding.keys) && binding.whenPredicate(context)) {
        return binding;
      }
    }
    return undefined;
  }

  private keysMatch(pressed: KeyCombination, binding: KeyCombination): boolean {
    // Character key: must match exactly (case-insensitive)
    if (binding.key !== undefined) {
      if (pressed.key?.toLowerCase() !== binding.key.toLowerCase()) return false;
    }

    // Modifier keys – treat undefined as "don't care"
    const modifierProps: (keyof KeyCombination)[] = ['ctrl', 'shift', 'alt', 'meta'];
    for (const prop of modifierProps) {
      const bVal = binding[prop];
      if (bVal !== undefined && bVal !== pressed[prop]) return false;
    }

    // Special keys – only check those explicitly specified in binding
    const specialProps: (keyof KeyCombination)[] = [
      'upArrow',
      'downArrow',
      'leftArrow',
      'rightArrow',
      'tab',
      'escape',
      'return',
      'backspace',
      'delete',
      'pageUp',
      'pageDown',
    ];
    for (const prop of specialProps) {
      const bVal = binding[prop];
      if (bVal !== undefined && bVal !== pressed[prop]) return false;
    }

    // All constraints satisfied
    return true;
  }

  // Strict equality check between two key combinations (used for conflict detection)
  private keysEqual(a: KeyCombination, b: KeyCombination): boolean {
    const allProps: (keyof KeyCombination)[] = [
      'key',
      'ctrl',
      'shift',
      'alt',
      'meta',
      'upArrow',
      'downArrow',
      'leftArrow',
      'rightArrow',
      'tab',
      'escape',
      'return',
      'backspace',
      'delete',
      'pageUp',
      'pageDown',
    ];

    return allProps.every(prop => {
      const aVal = a[prop];
      const bVal = b[prop];

      if (typeof aVal === 'string' || typeof bVal === 'string') {
        return (aVal as string | undefined)?.toLowerCase() === (bVal as string | undefined)?.toLowerCase();
      }

      return !!aVal === !!bVal; // Normalize to boolean then compare
    });
  }

  // Compile the "when" expression into a predicate function evaluated against context.
  private compileWhen(when?: string): (ctx: KeybindingContext) => boolean {
    if (!when) return () => true;

    // Reuse the previous simple parser but close over the expression.
    const expr = when;
    return (context: KeybindingContext) => {
      const evaluate = (e: string): boolean => {
        const trimmed = e.trim();

        if (trimmed.startsWith('!')) {
          return !evaluate(trimmed.substring(1));
        }

        // Parentheses – simple single-level support
        if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
          return evaluate(trimmed.slice(1, -1));
        }

        if (trimmed.includes('&&')) {
          return trimmed.split('&&').every(part => evaluate(part));
        }

        if (trimmed.includes('||')) {
          return trimmed.split('||').some(part => evaluate(part));
        }

        const value = (context as any)[trimmed];
        return !!value;
      };

      try {
        return evaluate(expr);
      } catch (err) {
        console.error(`Error evaluating keybinding context: ${expr}`, err);
        return false;
      }
    };
  }

  // For backward compatibility – delegate to util implementation.
  static formatKeybinding(keys: KeyCombination): string {
    return formatKeybindingStr(keys);
  }
} 