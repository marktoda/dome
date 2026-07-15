import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

const FOCUSABLE = "button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])";

/** One local modal-focus Module shared by every PWA modal surface. */
export function useModalFocus(options: {
  readonly active: boolean;
  readonly focusKey: string;
  readonly containerRef: RefObject<HTMLElement | null>;
  readonly initialFocus: () => HTMLElement | null;
  readonly onEscape: () => void;
  readonly restoreFocus: () => HTMLElement | null;
}): void {
  const latest = useRef(options);
  const scopeGeneration = useRef(0);
  latest.current = options;

  useLayoutEffect(() => {
    if (!options.active) return;
    (options.initialFocus() ?? options.containerRef.current)?.focus();
  }, [options.active, options.focusKey, options.containerRef]);

  useEffect(() => {
    if (!options.active) return;
    const generation = ++scopeGeneration.current;
    const keyboard = (event: KeyboardEvent): void => {
      const current = latest.current;
      if (event.key === "Escape") {
        event.preventDefault();
        current.onEscape();
        return;
      }
      if (event.key !== "Tab") return;
      const container = current.containerRef.current;
      if (container === null) return;
      const focusable = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)]
        .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (
        focusable.length === 1 ||
        (!event.shiftKey && document.activeElement === last) ||
        (event.shiftKey && document.activeElement === first) ||
        !container.contains(document.activeElement)
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener("keydown", keyboard);
    return () => {
      document.removeEventListener("keydown", keyboard);
      queueMicrotask(() => {
        // StrictMode probes every effect with setup → cleanup → setup. The
        // second setup advances the generation before this microtask runs, so
        // only the cleanup of the final active modal scope restores focus.
        if (scopeGeneration.current === generation) latest.current.restoreFocus()?.focus();
      });
    };
  }, [options.active]);
}
