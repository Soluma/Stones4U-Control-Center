import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: "bg-canvas text-ink-secondary border-border",
  accent: "bg-accent-50 text-accent-700 border-accent-100",
  success: "bg-success-50 text-success-700 border-success-500/20",
  warning: "bg-warning-50 text-warning-700 border-warning-500/20",
  danger: "bg-danger-50 text-danger-700 border-danger-500/20",
};

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium leading-normal",
        TONE_CLASSES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

const DOT_TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: "bg-ink-disabled",
  accent: "bg-accent-500",
  success: "bg-success-500",
  warning: "bg-warning-500",
  danger: "bg-danger-500",
};

/** A borderless status indicator (colored dot + label) — used where a full
 * bordered Badge is visually heavier than needed, e.g. dense table rows. */
export function StatusDot({ children, tone = "neutral" }: { children: ReactNode; tone?: BadgeTone }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-secondary">
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", DOT_TONE_CLASSES[tone])} aria-hidden />
      {children}
    </span>
  );
}
