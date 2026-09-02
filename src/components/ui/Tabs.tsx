import Link from "next/link";
import { cn } from "@/lib/cn";

export type TabItem = { key: string; label: string };

/** Generic, reusable tab-strip — used by Customer 360 (server-navigated via
 * a `?tab=` query param) and the Tasks page (client-state-navigated). Kept
 * presentation-only and navigation-agnostic (an `hrefFor` builder rather
 * than baked-in routing) so both call sites share one visual component
 * without forcing one navigation strategy on the other. */
export function Tabs({
  items,
  active,
  hrefFor,
  onSelect,
}: {
  items: TabItem[];
  active: string;
  hrefFor?: (key: string) => string;
  onSelect?: (key: string) => void;
}) {
  return (
    <div role="tablist" className="flex gap-1 border-b border-border-subtle">
      {items.map((item) => {
        const isActive = active === item.key;
        const className = cn(
          "px-3 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px cc-focus-ring rounded-t-sm",
          isActive
            ? "border-accent-500 text-ink-primary"
            : "border-transparent text-ink-tertiary hover:text-ink-primary",
        );

        if (hrefFor) {
          return (
            <Link key={item.key} href={hrefFor(item.key)} role="tab" aria-selected={isActive} className={className}>
              {item.label}
            </Link>
          );
        }

        return (
          <button
            key={item.key}
            role="tab"
            aria-selected={isActive}
            onClick={() => onSelect?.(item.key)}
            className={className}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
