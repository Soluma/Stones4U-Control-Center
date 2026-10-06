"use client";

import { useId, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";

/** A section with a compact header that opens and closes its content —
 * closed by default. Used on the Customer 360 overview for recent activity,
 * calls and e-mails: the full history stays on its own tab, the overview only
 * shows how many recent items there are until someone opens the section.
 *
 * - The header is a real <button> with aria-expanded / aria-controls, so it
 *   works with the keyboard (Enter/Space) and screen readers.
 * - `count` is shown only when it is above 0.
 * - With `count === 0` the section is a single compact row ("geen") and does
 *   not open: there is nothing to show.
 * - The content is mounted only while open, so interactive children (e.g. the
 *   timeline's quick actions) start fresh and work normally once opened. */
export function CollapsibleSection({
  title,
  count,
  defaultOpen = false,
  emptyText = "geen",
  children,
  className,
  testId,
}: {
  title: string;
  count?: number;
  defaultOpen?: boolean;
  emptyText?: string;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();
  const empty = count === 0;

  if (empty) {
    return (
      <div className={cn("cc-card flex items-center justify-between gap-3 px-4 py-2.5", className)} data-testid={testId} data-state="empty">
        <h2 className="text-sm font-medium text-ink-secondary">{title}</h2>
        <span className="text-xs text-ink-tertiary">{emptyText}</span>
      </div>
    );
  }

  return (
    <div className={cn("space-y-3", className)} data-testid={testId} data-state={open ? "open" : "closed"}>
      <h2 className="text-sm font-medium text-ink-secondary">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => setOpen((value) => !value)}
          className="cc-card cc-table-row cc-focus-ring flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left"
        >
          <span className="min-w-0 truncate">{title}</span>
          <span className="flex shrink-0 items-center gap-2">
            {typeof count === "number" && count > 0 && (
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-surface-hover px-1.5 text-[11px] font-semibold tabular-nums text-ink-secondary">
                {count}
              </span>
            )}
            <ChevronRight
              className={cn("h-4 w-4 text-ink-tertiary transition-transform motion-reduce:transition-none", open && "rotate-90")}
              aria-hidden
            />
          </span>
        </button>
      </h2>
      {open && <div id={contentId}>{children}</div>}
    </div>
  );
}
