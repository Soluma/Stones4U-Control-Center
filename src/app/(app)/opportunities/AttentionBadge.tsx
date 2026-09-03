import { AlertCircle, Clock, Info } from "lucide-react";
import { cn } from "@/lib/cn";
import type { AttentionSeverity, AttentionReason } from "@/modules/opportunities/attention";

// Phase 4B — shared attention indicator, reused on pipeline cards, list
// rows, opportunity detail, and Customer 360 (docs/platform-discovery/35
// §16). Always icon + text, never color-only (accessibility requirement
// from the build instruction).
const SEVERITY_STYLE: Record<Exclude<AttentionSeverity, "NONE">, { icon: typeof AlertCircle; className: string; fallbackLabel: string }> = {
  RED: { icon: AlertCircle, className: "bg-danger-50 text-danger-700", fallbackLabel: "Waarschuwing" },
  ORANGE: { icon: Clock, className: "bg-warning-50 text-warning-700", fallbackLabel: "Opvolging nodig" },
  BLUE: { icon: Info, className: "bg-accent-50 text-accent-700", fallbackLabel: "Signaal" },
};

export function AttentionBadge({
  severity,
  primaryReason,
  compact,
  className,
}: {
  severity: AttentionSeverity;
  primaryReason: AttentionReason | null;
  /** Compact mode shows only the icon (with a title tooltip) — used where
   * horizontal space is tight (kanban cards). Always still has an
   * accessible text alternative via title/aria-label. */
  compact?: boolean;
  className?: string;
}) {
  if (severity === "NONE") return null;
  const style = SEVERITY_STYLE[severity];
  const Icon = style.icon;
  const label = primaryReason?.label ?? style.fallbackLabel;

  return (
    <span
      className={cn("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium", style.className, className)}
      title={label}
    >
      <Icon className="h-3 w-3 shrink-0" aria-hidden />
      {!compact && <span className="truncate">{label}</span>}
      {compact && <span className="sr-only">{label}</span>}
    </span>
  );
}
