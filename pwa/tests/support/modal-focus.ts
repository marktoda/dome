import { expect } from "bun:test";

/**
 * Assert focus restoration after a modal has unmounted.
 *
 * `useModalFocus` intentionally restores focus in its cleanup microtask so a
 * StrictMode effect probe cannot steal focus from the live modal scope. Queue
 * this assertion behind that documented boundary instead of polling for it.
 */
export async function expectModalFocusRestored(target: HTMLElement): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  expect(document.activeElement).toBe(target);
}
