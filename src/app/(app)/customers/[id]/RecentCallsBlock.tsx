import { Phone } from "lucide-react";
import { formatDateTime } from "@/lib/format";
import type { TelephonyActivityItem } from "@/integrations/telephony/adapter";

// Overview-tab compact block (docs/platform-discovery/28-PHASE-3-ARCHITECTURE.md
// §4.1 — no new tab, a small block alongside the existing openstaande-
// taken/komende-afspraken pattern). Shows the same items the Activity
// Timeline projects, just the latest few, in one place a user sees first.
export function RecentCallsBlock({ calls }: { calls: TelephonyActivityItem[] }) {
  const recent = calls.slice(0, 5);

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-medium text-ink-secondary">Recente gesprekken</h2>
      {recent.length === 0 ? (
        <p className="cc-card p-4 text-sm text-ink-tertiary">Geen recente gesprekken.</p>
      ) : (
        <div className="cc-card divide-y divide-border-subtle">
          {recent.map((call) => (
            <div key={call.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              <Phone className="h-3.5 w-3.5 shrink-0 text-ink-tertiary" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-ink-primary">{call.phoneNumber ?? "Onbekend nummer"}</p>
                {call.summary && <p className="mt-0.5 truncate text-xs text-ink-tertiary">{call.summary}</p>}
              </div>
              <span className="shrink-0 text-xs text-ink-tertiary">{formatDateTime(call.occurredAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
