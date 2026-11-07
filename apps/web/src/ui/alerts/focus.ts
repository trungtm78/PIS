import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** The modal parts that are open, the last one on top: only the top one answers the keyboard (a dialog over the drawer closes first). */
const open: HTMLElement[] = [];

/** The controls inside `root` a keyboard can reach, in document order. */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true' && element.getAttribute('type') !== 'hidden');
}

export interface FocusTrapOptions {
  onEscape: () => void;
}

/**
 * A modal part of the page: the focus moves in when it opens, Tab and Shift+Tab stay inside it (even when the control that had the focus is gone), Escape asks to close it,
 * and the focus goes back to where it came from when it closes.
 */
export function useFocusTrap(root: RefObject<HTMLElement | null>, active: boolean, options: FocusTrapOptions): void {
  const escape = useRef(options.onEscape);
  escape.current = options.onEscape;

  useEffect(() => {
    const container = root.current;
    if (!active || container === null) return undefined;
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    open.push(container);
    const first = focusableIn(container)[0];
    (first ?? container).focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (open[open.length - 1] !== container) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        escape.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusableIn(container);
      if (items.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      const head = items[0];
      const tail = items[items.length - 1];
      const current = document.activeElement;
      if (event.shiftKey && (current === head || !container.contains(current))) {
        event.preventDefault();
        tail?.focus();
      } else if (!event.shiftKey && (current === tail || !container.contains(current))) {
        event.preventDefault();
        head?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const at = open.lastIndexOf(container);
      if (at >= 0) open.splice(at, 1);
      if (origin !== null && origin.isConnected) origin.focus();
    };
  }, [root, active]);
}
