"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { IconButton } from "./IconButton";

type DialogProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
};

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

const FIELD_SELECTOR = 'input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled])';

/** The element that should receive focus when the dialog opens: an explicit
 * `autoFocus` / `data-autofocus` element, otherwise the first form field,
 * otherwise the first focusable element (the close button is only ever the
 * fallback for a dialog without fields), otherwise the panel itself. */
export function findInitialFocus(panel: HTMLElement): HTMLElement {
  return (
    panel.querySelector<HTMLElement>("[data-autofocus], [autofocus]") ??
    panel.querySelector<HTMLElement>(FIELD_SELECTOR) ??
    panel.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ??
    panel
  );
}

/** Minimal accessible modal — used for Create User and Create/Edit Task,
 * the two Phase 1 forms genuinely improved by a dialog instead of an inline
 * form pushing page content around (docs/build/PHASE-1-UI-UX-PASS.md).
 * Handles Escape-to-close, backdrop-click-to-close, initial focus, and a
 * basic Tab focus trap — deliberately not a full library, since nothing
 * else in Phase 1 needs more than that.
 *
 * The open/close lifecycle (initial focus, key handling, focus restore)
 * depends on `open` only. Callers typically pass an inline
 * `onClose={() => setOpen(false)}`, which is a new function on every render;
 * when the effect depended on it, every keystroke in a field re-ran the
 * effect, which restored focus and then focused the first focusable element
 * — the close button — so typing a name jumped to the ✕ after each letter.
 * The latest onClose is read from a ref instead.
 *
 * The element to return focus to is captured while rendering the switch to
 * `open`, i.e. before React commits the dialog: a field with `autoFocus`
 * takes focus during that commit, so reading document.activeElement in the
 * effect would remember the field itself and "restore" focus to a removed
 * node (focus fell to <body> instead of the button that opened the dialog). */
export function Dialog({ open, onClose, title, description, children, footer }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [wasOpen, setWasOpen] = useState(open);
  const [returnFocusTo, setReturnFocusTo] = useState<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setReturnFocusTo(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  }

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;

    if (panelRef.current) findInitialFocus(panelRef.current).focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;

      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (returnFocusTo?.isConnected) returnFocusTo.focus();
    };
  }, [open, returnFocusTo]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-primary/20 px-4 animate-fade-in"
      onClick={() => onCloseRef.current()}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cc-dialog-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        className="max-h-[calc(100vh-2rem)] w-full max-w-md overflow-y-auto rounded-lg border border-border bg-surface shadow-popover animate-scale-in focus:outline-none"
      >
        <div className="flex items-start justify-between gap-4 border-b border-border-subtle px-5 py-4">
          <div>
            <h2 id="cc-dialog-title" className="text-sm font-semibold text-ink-primary">
              {title}
            </h2>
            {description && <p className="mt-0.5 text-xs text-ink-tertiary">{description}</p>}
          </div>
          <IconButton icon={<X className="h-4 w-4" />} label="Sluiten" onClick={() => onCloseRef.current()} />
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-border-subtle px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}
