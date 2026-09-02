import type { ReactNode } from "react";

type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: "bg-canvas text-ink-secondary border-border",
  accent: "bg-accent-50 text-accent-700 border-accent-100",
  success: "bg-success-50 text-success-700 border-success-500/20",
  warning: "bg-warning-50 text-warning-700 border-warning-500/20",
  danger: "bg-danger-50 text-danger-700 border-danger-500/20",
};

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: BadgeTone }) {
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${TONE_CLASSES[tone]}`}
    >
      {children}
    </span>
  );
}
