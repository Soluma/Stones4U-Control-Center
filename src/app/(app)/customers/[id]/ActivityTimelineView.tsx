import {
  ShoppingBag,
  StickyNote,
  PenLine,
  Trash2,
  CheckSquare,
  CheckCircle2,
  XCircle,
  ArrowRightLeft,
  UserCog,
  Phone,
  Receipt,
  Paperclip,
  FileMinus,
  CalendarPlus,
  CalendarClock,
  CalendarCheck,
  CalendarX,
  MessageSquare,
  ListChecks,
  type LucideIcon,
} from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { cn } from "@/lib/cn";
import { formatDate, formatTime } from "@/lib/format";
import type { TimelineItem } from "@/modules/activity/timeline";

// Icon + tint per activity kind — small, consistent chips rather than large
// colored cards per docs/build/PHASE-1-UI-UX-PASS.md ("Activity Timeline").
// The CALL/INVOICE entries are wired for when the telephony/exact adapters
// are enabled (docs/architecture/ADR-004) — the timeline already renders
// them correctly today, there just aren't any yet.
const KIND_STYLE: Record<string, { icon: LucideIcon; tint: string }> = {
  SHOPIFY_ORDER: { icon: ShoppingBag, tint: "bg-success-50 text-success-700" },
  NOTE_CREATED: { icon: StickyNote, tint: "bg-accent-50 text-accent-700" },
  NOTE_UPDATED: { icon: PenLine, tint: "bg-accent-50 text-accent-700" },
  NOTE_DELETED: { icon: Trash2, tint: "bg-danger-50 text-danger-700" },
  TASK_CREATED: { icon: CheckSquare, tint: "bg-canvas text-ink-secondary" },
  TASK_STATUS_CHANGED: { icon: ArrowRightLeft, tint: "bg-canvas text-ink-secondary" },
  TASK_ASSIGNED: { icon: ArrowRightLeft, tint: "bg-canvas text-ink-secondary" },
  TASK_COMPLETED: { icon: CheckCircle2, tint: "bg-success-50 text-success-700" },
  TASK_CANCELLED: { icon: XCircle, tint: "bg-danger-50 text-danger-700" },
  CUSTOMER_PROFILE_UPDATED: { icon: UserCog, tint: "bg-canvas text-ink-secondary" },
  CALL: { icon: Phone, tint: "bg-warning-50 text-warning-700" },
  INVOICE: { icon: Receipt, tint: "bg-warning-50 text-warning-700" },
  // Phase 2
  FILE_UPLOADED: { icon: Paperclip, tint: "bg-accent-50 text-accent-700" },
  FILE_REMOVED: { icon: FileMinus, tint: "bg-danger-50 text-danger-700" },
  APPOINTMENT_CREATED: { icon: CalendarPlus, tint: "bg-canvas text-ink-secondary" },
  APPOINTMENT_UPDATED: { icon: CalendarClock, tint: "bg-canvas text-ink-secondary" },
  APPOINTMENT_COMPLETED: { icon: CalendarCheck, tint: "bg-success-50 text-success-700" },
  APPOINTMENT_CANCELLED: { icon: CalendarX, tint: "bg-danger-50 text-danger-700" },
  TASK_UPDATED: { icon: ArrowRightLeft, tint: "bg-canvas text-ink-secondary" },
  TASK_COMMENT_ADDED: { icon: MessageSquare, tint: "bg-accent-50 text-accent-700" },
  TASK_CHECKLIST_COMPLETED: { icon: ListChecks, tint: "bg-success-50 text-success-700" },
};

function dayKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam" }).format(date); // YYYY-MM-DD, stable sort key
}

function dayLabel(date: Date): string {
  const today = dayKey(new Date());
  const yesterday = dayKey(new Date(Date.now() - 86_400_000));
  const key = dayKey(date);
  if (key === today) return "Vandaag";
  if (key === yesterday) return "Gisteren";
  return formatDate(date);
}

function groupByDay(items: TimelineItem[]): { label: string; items: TimelineItem[] }[] {
  const groups: { key: string; label: string; items: TimelineItem[] }[] = [];
  for (const item of items) {
    const key = dayKey(item.occurredAt);
    const existing = groups.at(-1);
    if (existing && existing.key === key) {
      existing.items.push(item);
    } else {
      groups.push({ key, label: dayLabel(item.occurredAt), items: [item] });
    }
  }
  return groups;
}

export function ActivityTimelineView({ items }: { items: TimelineItem[] }) {
  if (items.length === 0) {
    return (
      <EmptyState
        title="Nog geen activiteit"
        description="Notities, taken, en Shopify-bestellingen verschijnen hier zodra ze bestaan."
      />
    );
  }

  const groups = groupByDay(items);

  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <div key={group.label}>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-disabled">{group.label}</p>
          <ol className="relative space-y-0 border-l border-border pl-5">
            {group.items.map((item) => {
              const style = KIND_STYLE[item.kind] ?? { icon: CheckSquare, tint: "bg-canvas text-ink-secondary" };
              const Icon = style.icon;
              return (
                <li key={item.id} className="relative pb-4 last:pb-0">
                  <span
                    className={cn(
                      "absolute -left-[27px] top-0 flex h-5 w-5 items-center justify-center rounded-full ring-4 ring-surface",
                      style.tint,
                    )}
                    aria-hidden
                  >
                    <Icon className="h-3 w-3" />
                  </span>
                  <p className="text-sm font-medium text-ink-primary">{item.title}</p>
                  {item.summary && <p className="mt-0.5 text-sm text-ink-secondary">{item.summary}</p>}
                  <p className="mt-0.5 text-xs text-ink-tertiary">
                    {formatTime(item.occurredAt)}
                    {item.actorName ? ` · ${item.actorName}` : ""}
                  </p>
                </li>
              );
            })}
          </ol>
        </div>
      ))}
    </div>
  );
}
