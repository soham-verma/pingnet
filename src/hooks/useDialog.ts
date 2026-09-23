// Accessible modal dialogs (audit UX-001).
//
// Spread the returned props on the modal's backdrop element:
//   const dialog = useDialog(onClose);
//   <div {...dialog} className="fixed inset-0 …">…<h2>Title</h2>…</div>
//
// Gives it role="dialog" + aria-modal, labels it by its first heading, moves
// focus inside on open, keeps Tab / Shift+Tab inside, closes on Escape, and
// restores focus to whatever was focused before the dialog opened.

import { useCallback, useEffect, useId, useRef } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Focusable descendants in DOM order, excluding hidden ones. */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute("inert") && el.getClientRects().length > 0,
  );
}

/** Where focus should go on Tab from `current` (wraps at the ends). Pure for tests. */
export function nextFocusIndex(count: number, current: number, backwards: boolean): number {
  if (count === 0) return -1;
  if (current < 0) return backwards ? count - 1 : 0;
  return backwards ? (current - 1 + count) % count : (current + 1) % count;
}

export function useDialog(onClose: () => void, opts: { closeOnEscape?: boolean } = {}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const closeOnEscape = opts.closeOnEscape ?? true;

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const previously = document.activeElement as HTMLElement | null;

    // Label the dialog by its first heading
    const heading = root.querySelector("h1, h2, h3");
    if (heading) {
      if (!heading.id) heading.id = titleId;
      root.setAttribute("aria-labelledby", heading.id);
    }

    // Move focus inside unless something inside is already focused (autoFocus)
    if (!root.contains(document.activeElement)) {
      const first = focusableIn(root)[0];
      (first ?? root).focus();
    }

    return () => {
      // Restore focus to the opener if it's still in the document
      if (previously && document.contains(previously)) previously.focus();
    };
  }, [titleId]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && closeOnEscape) {
      e.stopPropagation();
      onCloseRef.current();
      return;
    }
    if (e.key !== "Tab" || !ref.current) return;
    const items = focusableIn(ref.current);
    const idx = items.indexOf(document.activeElement as HTMLElement);
    const next = nextFocusIndex(items.length, idx, e.shiftKey);
    if (next < 0) { e.preventDefault(); return; }
    // Only intervene at the edges (or when focus escaped); normal Tab otherwise
    const atEdge = idx < 0 || (e.shiftKey ? idx === 0 : idx === items.length - 1);
    if (atEdge) {
      e.preventDefault();
      items[next].focus();
    }
  }, [closeOnEscape]);

  return {
    ref,
    role: "dialog" as const,
    "aria-modal": true as const,
    tabIndex: -1,
    onKeyDown,
  };
}
