"use client";

import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), summary';

export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute("inert") && el.getClientRects().length > 0,
  );
}

/** Open traps, innermost last — only the top one handles Tab/Escape (nested dialogs). */
const stack: symbol[] = [];

/**
 * Modal focus handling: while `active`, Tab cycles inside `ref`, Escape calls `onEscape`, focus
 * moves in on open (`initialFocus` selector, else the first focusable, else the container) and
 * returns to whatever had focus before when it closes.
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  opts: { onEscape?: () => void; initialFocus?: string; trap?: boolean } = {},
) {
  const escRef = useRef(opts.onEscape);
  escRef.current = opts.onEscape;
  const { initialFocus, trap = true } = opts;

  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;
    const previous = document.activeElement as HTMLElement | null;
    const id = Symbol("trap");
    stack.push(id);

    const focusFirst = () => {
      const target =
        (initialFocus ? root.querySelector<HTMLElement>(initialFocus) : null) ?? focusableIn(root)[0] ?? root;
      if (target === root && !root.hasAttribute("tabindex")) root.setAttribute("tabindex", "-1");
      target.focus({ preventScroll: true });
    };
    const raf = requestAnimationFrame(focusFirst);

    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id) return;
      if (e.key === "Escape" && escRef.current) {
        e.stopPropagation();
        escRef.current();
        return;
      }
      if (e.key !== "Tab" || !trap) return;
      const items = focusableIn(root);
      if (!items.length) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      // Focus on a non-tabbable spot inside the box (e.g. a tabindex=-1 wrapper) counts as outside
      // the cycle, otherwise the browser's own Tab order could step out of the dialog.
      const offCycle = !items.includes(current as HTMLElement);
      if (e.shiftKey && (current === first || offCycle)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (current === last || offCycle)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKey, true);
      stack.splice(stack.indexOf(id), 1);
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, [active, ref, initialFocus, trap]);
}

/** Locks page scroll while a modal/drawer is open. */
export function useScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
    };
  }, [active]);
}
