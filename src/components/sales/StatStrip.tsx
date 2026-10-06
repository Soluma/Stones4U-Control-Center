import { cn } from "@/lib/cn";

/** Compact counts above a Sales overview — one card, divided cells, same
 * look as "Mijn taken in cijfers" on the dashboard. `scope` says what the
 * counts cover (a search result, one page), so they are never read as totals. */
export function StatStrip({
  items,
  scope,
}: {
  items: { label: string; value: number; tone?: "neutral" | "accent" | "warning" | "danger" }[];
  scope: string;
}) {
  const tone = { neutral: "text-ink-primary", accent: "text-accent-600", warning: "text-warning-700", danger: "text-danger-500" };
  return (
    <div className="space-y-1.5">
      <div className="cc-card grid grid-cols-2 sm:grid-cols-4 [&>*]:border-border-subtle [&>*:nth-child(odd)]:border-r sm:[&>*:not(:last-child)]:border-r [&>*:nth-child(-n+2)]:border-b sm:[&>*:nth-child(-n+2)]:border-b-0">
        {items.map((item) => (
          <div key={item.label} className="min-w-0 px-4 py-3">
            <p className="truncate text-xs text-ink-tertiary">{item.label}</p>
            <p className={cn("mt-1 text-xl font-semibold tabular-nums", item.value === 0 ? "text-ink-tertiary" : tone[item.tone ?? "neutral"])}>
              {item.value}
            </p>
          </div>
        ))}
      </div>
      <p className="text-xs text-ink-tertiary">{scope}</p>
    </div>
  );
}
