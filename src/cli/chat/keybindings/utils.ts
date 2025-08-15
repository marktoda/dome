import { KeyCombination } from './types.js';

/**
 * Convert Ink's input/key object to our internal KeyCombination representation.
 */
export function fromInkInput(input: string, key: Record<string, boolean>): KeyCombination {
  return {
    key: input.length === 1 ? input : undefined,
    ctrl: key.ctrl || false,
    shift: key.shift || false,
    alt: key.alt || false,
    meta: key.meta || false,
    upArrow: key.upArrow || false,
    downArrow: key.downArrow || false,
    leftArrow: key.leftArrow || false,
    rightArrow: key.rightArrow || false,
    tab: key.tab || false,
    escape: key.escape || false,
    return: key.return || false,
    backspace: key.backspace || false,
    delete: key.delete || false,
    pageUp: key.pageUp || false,
    pageDown: key.pageDown || false,
  };
}

/**
 * Human-readable formatting of a KeyCombination, used for help/output views.
 */
export function formatKeybinding(keys: KeyCombination): string {
  const parts: string[] = [];

  if (keys.ctrl) parts.push('Ctrl');
  if (keys.shift) parts.push('Shift');
  if (keys.alt) parts.push('Alt');
  if (keys.meta) parts.push('Meta');

  if (keys.key) {
    parts.push(keys.key.toUpperCase());
  } else if (keys.upArrow) {
    parts.push('↑');
  } else if (keys.downArrow) {
    parts.push('↓');
  } else if (keys.leftArrow) {
    parts.push('←');
  } else if (keys.rightArrow) {
    parts.push('→');
  } else if (keys.tab) {
    parts.push('Tab');
  } else if (keys.escape) {
    parts.push('Esc');
  } else if (keys.return) {
    parts.push('Enter');
  } else if (keys.backspace) {
    parts.push('Backspace');
  } else if (keys.delete) {
    parts.push('Delete');
  } else if (keys.pageUp) {
    parts.push('PageUp');
  } else if (keys.pageDown) {
    parts.push('PageDown');
  }

  return parts.join('+');
}
