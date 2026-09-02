import Link from "next/link";

const TABS = [
  { key: "overview", label: "Overzicht" },
  { key: "orders", label: "Orders" },
  { key: "activity", label: "Activiteit" },
  { key: "notes", label: "Notities" },
  { key: "tasks", label: "Taken" },
] as const;

export function Tabs({ customerId, active }: { customerId: string; active: string }) {
  return (
    <div className="flex gap-1 border-b border-border-subtle">
      {TABS.map((tab) => (
        <Link
          key={tab.key}
          href={`/customers/${customerId}?tab=${tab.key}`}
          className={`px-3 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
            active === tab.key
              ? "border-accent-500 text-ink-primary"
              : "border-transparent text-ink-tertiary hover:text-ink-primary"
          }`}
        >
          {tab.label}
        </Link>
      ))}
    </div>
  );
}
