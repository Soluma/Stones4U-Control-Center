import { EmptyState } from "@/components/ui/EmptyState";
import { Badge } from "@/components/ui/Badge";
import { formatDateTime } from "@/lib/format";
import type { TimelineItem } from "@/modules/activity/timeline";

const SOURCE_LABEL: Record<TimelineItem["source"], string> = {
  CONTROL_CENTER: "Control Center",
  SHOPIFY: "Shopify",
  TELEFOONSYSTEEM: "TelefoonSysteem",
  EXACT: "Exact",
};

const SOURCE_TONE: Record<TimelineItem["source"], "accent" | "success" | "neutral" | "warning"> = {
  CONTROL_CENTER: "accent",
  SHOPIFY: "success",
  TELEFOONSYSTEEM: "neutral",
  EXACT: "warning",
};

export function ActivityTimelineView({ items }: { items: TimelineItem[] }) {
  if (items.length === 0) {
    return (
      <EmptyState
        title="Nog geen activiteit"
        description="Notities, taken, en Shopify-bestellingen verschijnen hier zodra ze bestaan."
      />
    );
  }

  return (
    <ol className="relative space-y-0 border-l border-border pl-5">
      {items.map((item) => (
        <li key={item.id} className="relative pb-5 last:pb-0">
          <span className="absolute -left-[25px] top-1 h-2.5 w-2.5 rounded-full border-2 border-surface bg-accent-400" />
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-ink-primary">{item.title}</p>
            <Badge tone={SOURCE_TONE[item.source]}>{SOURCE_LABEL[item.source]}</Badge>
          </div>
          {item.summary && <p className="mt-0.5 text-sm text-ink-secondary">{item.summary}</p>}
          <p className="mt-0.5 text-xs text-ink-tertiary">
            {formatDateTime(item.occurredAt)}
            {item.actorName ? ` · ${item.actorName}` : ""}
          </p>
        </li>
      ))}
    </ol>
  );
}
