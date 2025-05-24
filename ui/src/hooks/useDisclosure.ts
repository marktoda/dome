import { useState, useCallback } from 'react';

export interface DisclosureControls {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
}

/**
 * Simple helper hook to manage boolean open/closed state.
 * Provides stable handlers for opening, closing and toggling.
 */
export function useDisclosure(initial = false): DisclosureControls {
  const [isOpen, setIsOpen] = useState(initial);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((v) => !v), []);

  return { isOpen, open, close, toggle };
}
